import { Router } from 'express'
import { prisma } from '../lib/prisma.js'
import { logAudit } from '../lib/audit.js'
import { success, error, notFound, serverError } from '../lib/response.js'
import { authenticate, authorize } from '../middleware/auth.js'
import { generateRegistryNo } from '../lib/registry.js'
import { ingestDocument, removeDocumentEmbedding, semanticSearchDocuments } from '../lib/embeddings.js'
import multer from 'multer'

const router  = Router()
const upload  = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10485760 } })

async function createPendingRouting({ sourceType, sourceId, addressedTo = 'GENERAL_MANAGER' }) {
  return prisma.documentRouting.create({
    data: {
      sourceType,
      sourceId: String(sourceId),
      addressedTo,
      status: 'PENDING_TRIAGE',
    },
  })
}

// Files are stored directly in Postgres (fileData Bytes?) rather than a
// third-party host — every list/detail query below selects fields
// explicitly to keep that column out of ordinary JSON responses. Only
// GET /:id/file selects it, to actually stream the bytes.
const DOCUMENT_SELECT = {
  id: true, title: true, category: true, department: true, filePath: true,
  fileSize: true, mimeType: true, description: true, status: true,
  isEditable: true, uploadedBy: true, createdAt: true, updatedAt: true,
  uploader: { select: { id: true, name: true, role: true } },
}

const NEW_ARRIVAL_WINDOW_MS = 48 * 60 * 60 * 1000

// Builds a Prisma `where` fragment for the "state" tab filter on the
// Documents page: NEW (just landed with this role), PENDING (awaiting this
// role's action, or the user's own unsubmitted drafts), IN_CIRCULATION
// (circulating but with someone else right now), STORED (circulation
// closed). Reuses DocumentCirculation rather than adding new endpoints —
// sourceId is a polymorphic string column, not a Prisma relation, so this
// resolves matching document IDs first and filters on those.
async function buildStateFilter(state, user) {
  if (!state) return {}

  if (state === 'NEW' || state === 'PENDING') {
    const myCirculations = await prisma.documentCirculation.findMany({
      where: { sourceType: 'DOCUMENT', currentHolderRole: user.role, status: 'IN_CIRCULATION' },
      select: { id: true, sourceId: true, updatedAt: true },
    })

    // "New" is "landed with me recently AND I haven't opened it yet" — once
    // viewed (DocumentViewerModal marks NEW_ARRIVAL read on open), it falls
    // through to Pending even if still inside the recency window. Not a
    // permanent category, just a since-I-last-looked surface.
    const readRows = await prisma.notificationRead.findMany({
      where: { userId: user.id, sourceType: 'NEW_ARRIVAL', sourceId: { in: myCirculations.map((c) => c.id) } },
      select: { sourceId: true },
    })
    const viewedSet = new Set(readRows.map((r) => r.sourceId))
    const isNew = (c) => (Date.now() - new Date(c.updatedAt).getTime()) < NEW_ARRIVAL_WINDOW_MS && !viewedSet.has(c.id)

    const ids = myCirculations
      .filter((c) => (state === 'NEW' ? isNew(c) : !isNew(c)))
      .map((c) => parseInt(c.sourceId, 10))
      .filter(Number.isInteger)

    if (state === 'PENDING') {
      // Your own not-yet-submitted drafts are also "pending your action".
      return { OR: [{ id: { in: ids } }, { status: 'PRIVATE', uploadedBy: user.id }] }
    }
    return { id: { in: ids } }
  }

  if (state === 'IN_CIRCULATION') {
    const elsewhere = await prisma.documentCirculation.findMany({
      where: { sourceType: 'DOCUMENT', status: 'IN_CIRCULATION', currentHolderRole: { not: user.role } },
      select: { sourceId: true },
    })
    return { id: { in: elsewhere.map((c) => parseInt(c.sourceId, 10)).filter(Number.isInteger) } }
  }

  if (state === 'STORED') {
    const closed = await prisma.documentCirculation.findMany({
      where: { sourceType: 'DOCUMENT', status: 'CLOSED' },
      select: { sourceId: true },
    })
    return { id: { in: closed.map((c) => parseInt(c.sourceId, 10)).filter(Number.isInteger) } }
  }

  return {}
}

// GET /api/documents
router.get('/', authenticate, async (req, res) => {
  try {
    const { search = '', category = '', department = '', page = 1, limit = 8, state = '' } = req.query

    // Module-history-based access:
    //  - RECORDS_EXECUTIVE / GENERAL_MANAGER: broad access, see everything.
    //  - Everyone else: their own uploads, plus any document that has ever
    //    passed through their role in a circulation (fromRole or toRole on
    //    any CirculationStep of a DocumentCirculation sourced from it). A
    //    document that's still PRIVATE has no circulation yet, so it's only
    //    reachable via the "own uploads" branch — consistent with staging.
    const hasBroadAccess = ['RECORDS_EXECUTIVE', 'GENERAL_MANAGER'].includes(req.user.role)
    let visibility = {}
    if (!hasBroadAccess) {
      const touchedCirculations = await prisma.documentCirculation.findMany({
        where: {
          sourceType: 'DOCUMENT',
          steps: { some: { OR: [{ fromRole: req.user.role }, { toRole: req.user.role }] } },
        },
        select: { sourceId: true },
      })
      const touchedDocumentIds = touchedCirculations
        .map((c) => parseInt(c.sourceId, 10))
        .filter((n) => Number.isInteger(n))

      visibility = { OR: [{ uploadedBy: req.user.id }, { id: { in: touchedDocumentIds } }] }
    }

    const stateFilter = await buildStateFilter(state.toUpperCase(), req.user)

    const where = {
      AND: [
        search     ? { title:      { contains: search,     mode: 'insensitive' } } : {},
        category   ? { category }   : {},
        department ? { department } : {},
        visibility,
        stateFilter,
      ],
    }

    const [documents, total] = await Promise.all([
      prisma.document.findMany({
        where,
        select: DOCUMENT_SELECT,
        orderBy: { createdAt: 'desc' },
        skip:    (parseInt(page) - 1) * parseInt(limit),
        take:    parseInt(limit),
      }),
      prisma.document.count({ where }),
    ])

    return success(res, {
      documents,
      pagination: {
        total,
        page:       parseInt(page),
        limit:      parseInt(limit),
        totalPages: Math.ceil(total / parseInt(limit)),
      },
    })
  } catch (err) {
    return serverError(res, err)
  }
})

// GET /api/documents/search/semantic — RAG-style retrieval over submitted
// (non-PRIVATE) documents. Registered before GET /:id so "search" is never
// swallowed as an :id param.
router.get('/search/semantic', authenticate, async (req, res) => {
  try {
    const { q = '', limit = 10 } = req.query
    if (!q.trim()) return error(res, 'Query parameter q is required')

    const hasBroadAccess = ['RECORDS_EXECUTIVE', 'GENERAL_MANAGER'].includes(req.user.role)
    let touchedDocumentIds = new Set()
    if (!hasBroadAccess) {
      const touchedCirculations = await prisma.documentCirculation.findMany({
        where: {
          sourceType: 'DOCUMENT',
          steps: { some: { OR: [{ fromRole: req.user.role }, { toRole: req.user.role }] } },
        },
        select: { sourceId: true },
      })
      touchedDocumentIds = new Set(touchedCirculations.map((c) => parseInt(c.sourceId, 10)))
    }

    const candidates = await semanticSearchDocuments(q, Math.min(parseInt(limit, 10) || 10, 25) * 3)
    const visible = candidates.filter((doc) =>
      hasBroadAccess || doc.uploadedBy === req.user.id || touchedDocumentIds.has(doc.id)
    ).slice(0, parseInt(limit, 10) || 10)

    return success(res, visible)
  } catch (err) {
    return serverError(res, err)
  }
})

// POST /api/documents
router.post('/', authenticate, upload.single('file'), async (req, res) => {
  try {
    const { title, category, department, description, addressedTo, forGMAttention } = req.body
    const file = req.file

    if (!title || !category || !department || !file) {
      return error(res, 'Title, category, department and file are required')
    }

    const document = await prisma.document.create({
      data: {
        title:       String(title).trim(),
        category,
        department,
        description: description ? String(description).trim() : null,
        filePath:    file.originalname,
        mimeType:    file.mimetype,
        fileData:    file.buffer,
        fileSize:    file.size,
        uploadedBy:  req.user.id,
      },
      select: DOCUMENT_SELECT,
    })

    const isForGM = String(addressedTo || '').toUpperCase() === 'GENERAL_MANAGER'
      || ['true', '1', 'yes', 'on'].includes(String(forGMAttention || '').toLowerCase())

    if (isForGM) {
      await createPendingRouting({
        sourceType: 'DOCUMENT',
        sourceId: document.id,
        addressedTo: 'GENERAL_MANAGER',
      })
    }

    await logAudit({
      userId:      req.user.id,
      action:      'DOCUMENT_UPLOAD',
      module:      'Documents',
      description: `Uploaded "${title}" to ${department}`,
      ipAddress:   req.ip,
    })

    return success(res, document, 'Document uploaded successfully', 201)
  } catch (err) {
    return serverError(res, err)
  }
})

// GET /api/documents/:id — single document, same module-history visibility
// rule as the list endpoint
router.get('/:id', authenticate, async (req, res) => {
  try {
    const id = parseInt(req.params.id)
    const document = await prisma.document.findUnique({
      where: { id },
      select: DOCUMENT_SELECT,
    })
    if (!document) return notFound(res, 'Document not found')

    const hasBroadAccess = ['RECORDS_EXECUTIVE', 'GENERAL_MANAGER'].includes(req.user.role)
    const isOwner = document.uploadedBy === req.user.id

    if (!hasBroadAccess && !isOwner) {
      const touchedIt = document.status !== 'PRIVATE' && await prisma.documentCirculation.findFirst({
        where: {
          sourceType: 'DOCUMENT',
          sourceId: String(document.id),
          steps: { some: { OR: [{ fromRole: req.user.role }, { toRole: req.user.role }] } },
        },
        select: { id: true },
      })
      if (!touchedIt) return notFound(res, 'Document not found')
    }

    return success(res, document)
  } catch (err) {
    return serverError(res, err)
  }
})

// GET /api/documents/:id/file — streams the actual file bytes. Requires the
// same Bearer auth as everything else, so the frontend fetches this as a
// blob (not a plain <img src=.../<iframe src=...> URL, which can't carry an
// Authorization header) and renders it via an object URL.
router.get('/:id/file', authenticate, async (req, res) => {
  try {
    const id = parseInt(req.params.id)
    const document = await prisma.document.findUnique({
      where: { id },
      select: { id: true, uploadedBy: true, status: true, filePath: true, mimeType: true, fileData: true },
    })
    if (!document || !document.fileData) return notFound(res, 'Document not found')

    const hasBroadAccess = ['RECORDS_EXECUTIVE', 'GENERAL_MANAGER'].includes(req.user.role)
    const isOwner = document.uploadedBy === req.user.id
    if (!hasBroadAccess && !isOwner) {
      const touchedIt = document.status !== 'PRIVATE' && await prisma.documentCirculation.findFirst({
        where: {
          sourceType: 'DOCUMENT',
          sourceId: String(document.id),
          steps: { some: { OR: [{ fromRole: req.user.role }, { toRole: req.user.role }] } },
        },
        select: { id: true },
      })
      if (!touchedIt) return notFound(res, 'Document not found')
    }

    res.setHeader('Content-Type', document.mimeType || 'application/octet-stream')
    res.setHeader('Content-Disposition', `inline; filename="${document.filePath.replace(/"/g, '')}"`)
    return res.send(document.fileData)
  } catch (err) {
    return serverError(res, err)
  }
})

// Shared visibility check used by the annotation/circulation sub-resources —
// mirrors GET /:id's rule exactly so you can't read annotations/signatures
// on a document you couldn't otherwise see.
async function canViewDocument(document, user) {
  const hasBroadAccess = ['RECORDS_EXECUTIVE', 'GENERAL_MANAGER'].includes(user.role)
  if (hasBroadAccess || document.uploadedBy === user.id) return true
  if (document.status === 'PRIVATE') return false

  const touchedIt = await prisma.documentCirculation.findFirst({
    where: {
      sourceType: 'DOCUMENT',
      sourceId: String(document.id),
      steps: { some: { OR: [{ fromRole: user.role }, { toRole: user.role }] } },
    },
    select: { id: true },
  })
  return Boolean(touchedIt)
}

// GET /api/documents/:id/annotations
router.get('/:id/annotations', authenticate, async (req, res) => {
  try {
    const id = parseInt(req.params.id)
    const document = await prisma.document.findUnique({ where: { id }, select: DOCUMENT_SELECT })
    if (!document) return notFound(res, 'Document not found')
    if (!(await canViewDocument(document, req.user))) return notFound(res, 'Document not found')

    const annotations = await prisma.annotation.findMany({
      where: { documentId: id },
      include: { author: { select: { id: true, name: true, role: true } } },
      orderBy: { createdAt: 'asc' },
    })

    return success(res, annotations)
  } catch (err) {
    return serverError(res, err)
  }
})

// POST /api/documents/:id/annotations
router.post('/:id/annotations', authenticate, async (req, res) => {
  try {
    const id = parseInt(req.params.id)
    const { text, type = 'COMMENT' } = req.body
    if (!text || !String(text).trim()) return error(res, 'Annotation text is required')

    const document = await prisma.document.findUnique({ where: { id }, select: DOCUMENT_SELECT })
    if (!document) return notFound(res, 'Document not found')
    if (!(await canViewDocument(document, req.user))) return notFound(res, 'Document not found')

    const annotation = await prisma.annotation.create({
      data: {
        documentId: id,
        authorId: req.user.id,
        type,
        text: String(text).trim(),
      },
      include: { author: { select: { id: true, name: true, role: true } } },
    })

    await logAudit({
      userId:      req.user.id,
      action:      'ANNOTATION_ADDED',
      module:      'Documents',
      description: `Added a ${type.toLowerCase()} to "${document.title}"`,
      ipAddress:   req.ip,
    })

    return success(res, annotation, 'Annotation added', 201)
  } catch (err) {
    return serverError(res, err)
  }
})

// GET /api/documents/:id/circulation — the circulation (if any) this document
// has entered, with its full step + signature history. Still-PRIVATE
// documents legitimately have none yet — that's not an error.
router.get('/:id/circulation', authenticate, async (req, res) => {
  try {
    const id = parseInt(req.params.id)
    const document = await prisma.document.findUnique({ where: { id }, select: DOCUMENT_SELECT })
    if (!document) return notFound(res, 'Document not found')
    if (!(await canViewDocument(document, req.user))) return notFound(res, 'Document not found')

    const circulation = await prisma.documentCirculation.findFirst({
      where: { sourceType: 'DOCUMENT', sourceId: String(id) },
      orderBy: { createdAt: 'desc' },
      include: {
        originator: { select: { id: true, name: true, role: true } },
        steps: {
          orderBy: { stepNumber: 'asc' },
          include: {
            fromUser: { select: { id: true, name: true, role: true } },
            signature: {
              include: { signer: { select: { id: true, name: true } } },
            },
          },
        },
      },
    })

    return success(res, circulation || null)
  } catch (err) {
    return serverError(res, err)
  }
})

// PUT /api/documents/:id — edit title/description/category while still a
// private draft. Once submitted, the document is immutable (mirrors the
// circulation "return to originator to edit" rule).
router.put('/:id', authenticate, async (req, res) => {
  try {
    const id = parseInt(req.params.id)
    const document = await prisma.document.findUnique({ where: { id }, select: DOCUMENT_SELECT })
    if (!document) return notFound(res, 'Document not found')

    if (document.uploadedBy !== req.user.id) {
      return error(res, 'You can only edit documents you uploaded', 403)
    }
    if (document.status !== 'PRIVATE' || !document.isEditable) {
      return error(res, 'This document has been submitted and can no longer be edited directly.', 400)
    }

    const { title, description, category } = req.body
    const updated = await prisma.document.update({
      where: { id },
      data: {
        ...(title !== undefined ? { title: String(title).trim() } : {}),
        ...(description !== undefined ? { description: description ? String(description).trim() : null } : {}),
        ...(category !== undefined ? { category } : {}),
      },
      select: DOCUMENT_SELECT,
    })

    return success(res, updated, 'Document updated successfully')
  } catch (err) {
    return serverError(res, err)
  }
})

// POST /api/documents/:id/submit — graduate a private draft into formal
// circulation. Sets status: SUBMITTED, isEditable: false, starts a
// DocumentCirculation with this document as sourceType "DOCUMENT", AND
// bridges it into the central registry (RegistryEntry) so Records Executive
// sees it without re-entering anything.
//
// NOTE on timing: the brief for the registry bridge said to create the
// RegistryEntry in POST / (the initial upload handler). That would put a
// still-PRIVATE draft into the registry immediately, which breaks the
// personal-staging model (private-until-submitted) this same brief's
// Directive 4 explicitly protects for embeddings ("only ingest once status
// changes away from PRIVATE... prevents an unfinished draft from surfacing").
// Bridging at submit-time is the point that's actually consistent with the
// rest of the system, so that's where this fires instead.
router.post('/:id/submit', authenticate, async (req, res) => {
  try {
    const id = parseInt(req.params.id)
    const { toRole, instruction } = req.body
    if (!toRole) return error(res, 'toRole is required')

    const document = await prisma.document.findUnique({ where: { id }, select: DOCUMENT_SELECT })
    if (!document) return notFound(res, 'Document not found')

    if (document.uploadedBy !== req.user.id) {
      return error(res, 'You can only submit documents you uploaded', 403)
    }
    if (document.status !== 'PRIVATE') {
      return error(res, 'This document has already been submitted', 400)
    }

    const registryNo = await generateRegistryNo()

    const result = await prisma.$transaction(async (tx) => {
      const updatedDocument = await tx.document.update({
        where: { id },
        data: { status: 'SUBMITTED', isEditable: false },
        select: DOCUMENT_SELECT,
      })

      const circulation = await tx.documentCirculation.create({
        data: {
          title: document.title,
          sourceType: 'DOCUMENT',
          sourceId: String(document.id),
          originatorId: req.user.id,
          currentHolderRole: toRole,
          status: 'IN_CIRCULATION',
          steps: {
            create: {
              stepNumber: 1,
              fromUserId: req.user.id,
              fromRole: req.user.role,
              toRole,
              instruction: instruction || `Submitted "${document.title}" for review.`,
              stepType: 'FORWARD',
              recordsCopies: { create: { status: 'PENDING_FILING' } },
            },
          },
        },
        include: { steps: { include: { recordsCopies: true } } },
      })

      // DocumentCategory and DocType share identical string values for
      // POLICY/REPORT/MEMO/CONTRACT/FORM/OTHER, so this mapping is exact.
      const registryEntry = await tx.registryEntry.create({
        data: {
          registryNo,
          subject: document.title,
          docType: document.category,
          direction: 'INTERNAL',
          source: req.user.name,
          destination: String(toRole).replace(/_/g, ' '),
          handledById: req.user.id,
          medium: 'EMAIL',
          status: 'PENDING',
          confidentiality: 'INTERNAL',
          dateRegistered: new Date(),
          sourceDocumentId: document.id,
        },
      })

      return { document: updatedDocument, circulation, registryEntry }
    })

    await logAudit({
      userId:      req.user.id,
      action:      'CIRCULATION_INITIATED',
      module:      'Documents',
      description: `Submitted "${document.title}" to ${toRole}`,
      ipAddress:   req.ip,
    })

    // Fire-and-forget: index for semantic search now that it's no longer
    // PRIVATE. Never block the submit response on embedding generation.
    ingestDocument(result.document).catch((err) => {
      console.error('ingestDocument failed for document', result.document.id, err)
    })

    return success(res, result, 'Document submitted and circulation initiated', 201)
  } catch (err) {
    return serverError(res, err)
  }
})

// DELETE /api/documents/:id
router.delete(
  '/:id',
  authenticate,
  authorize('IT_ADMINISTRATOR', 'GENERAL_MANAGER'),
  async (req, res) => {
    try {
      const document = await prisma.document.findUnique({
        where: { id: parseInt(req.params.id) },
        select: DOCUMENT_SELECT,
      })
      if (!document) return notFound(res, 'Document not found')

      await prisma.document.delete({ where: { id: parseInt(req.params.id) } })
      await removeDocumentEmbedding(document.id).catch(() => {})

      await logAudit({
        userId:      req.user.id,
        action:      'DOCUMENT_DELETE',
        module:      'Documents',
        description: `Deleted document: "${document.title}"`,
        ipAddress:   req.ip,
      })

      return success(res, null, 'Document deleted successfully')
    } catch (err) {
      return serverError(res, err)
    }
  }
)

export default router
