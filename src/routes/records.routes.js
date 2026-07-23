import { Router } from 'express'
import multer from 'multer'
import { prisma } from '../lib/prisma.js'
import { logAudit } from '../lib/audit.js'
import { success, error, notFound, serverError } from '../lib/response.js'
import { authenticate, authorize } from '../middleware/auth.js'
import { generateRegistryNo } from '../lib/registry.js'
import { validateCcRoles } from '../lib/roles.js'

const router = Router()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10485760 } })

// DocType (registry) and DocumentCategory (documents module) overlap but
// aren't identical — LETTER/INVOICE/LOGBOOK have no document-category
// equivalent, so they fall back to OTHER.
const DOC_TYPE_TO_CATEGORY = {
  MEMO: 'MEMO', CONTRACT: 'CONTRACT', POLICY: 'POLICY', REPORT: 'REPORT', FORM: 'FORM',
  LETTER: 'OTHER', INVOICE: 'OTHER', LOGBOOK: 'OTHER', OTHER: 'OTHER',
}

async function generateNextFileNumber() {
  const prefix = 'REG-FILE-'
  const latest = await prisma.recordsFile.findFirst({
    where: { fileNumber: { startsWith: prefix } },
    orderBy: { createdAt: 'desc' },
  })
  if (!latest) return `${prefix}001`
  const lastNum = parseInt(latest.fileNumber.split('-').pop(), 10) || 0
  return `${prefix}${String(lastNum + 1).padStart(3, '0')}`
}

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

// GET /api/records
router.get('/', authenticate, authorize(['RECORDS_EXECUTIVE', 'GENERAL_MANAGER', 'IT_ADMINISTRATOR']), async (req, res) => {
  try {
    const { search = '', status = '', page = 1, limit = 10 } = req.query

    const where = {
      AND: [
        search ? {
          OR: [
            { registryNo: { contains: search, mode: 'insensitive' } },
            { subject: { contains: search, mode: 'insensitive' } },
            { source: { contains: search, mode: 'insensitive' } },
            { destination: { contains: search, mode: 'insensitive' } },
          ],
        } : {},
        status ? { status } : {},
      ],
    }

    const [records, total] = await Promise.all([
      prisma.registryEntry.findMany({
        where,
        include: {
          handledBy: { select: { id: true, name: true, role: true } },
          annotations: {
            include: {
              author: { select: { id: true, name: true, role: true } },
            },
            orderBy: { createdAt: 'asc' },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (parseInt(page, 10) - 1) * parseInt(limit, 10),
        take: parseInt(limit, 10),
      }),
      prisma.registryEntry.count({ where }),
    ])

    return success(res, {
      records,
      pagination: {
        total,
        page: parseInt(page, 10),
        limit: parseInt(limit, 10),
        totalPages: Math.ceil(total / parseInt(limit, 10)),
      },
    })
  } catch (err) {
    return serverError(res, err)
  }
})

// POST /api/records — multipart so a digital copy can ride along with the
// registration in one request. Also handles optional file-linkage: either
// recordsFileId (pick an existing RecordsFile) or newFileNumber/newFileTitle
// (create one inline, then link to it) — mutually exclusive, checked in that
// order. An attached file becomes a real Document (same private-until-
// submitted staging as a normal Documents-module upload) and is bridged onto
// the registry entry via sourceDocumentId, exactly like the reverse bridge
// documents.routes.js does at submit-time.
router.post('/', authenticate, authorize(['RECORDS_EXECUTIVE', 'GENERAL_MANAGER', 'IT_ADMINISTRATOR']), upload.single('file'), async (req, res) => {
  try {
    const {
      subject,
      docType,
      direction,
      source,
      destination,
      receivedFrom,
      handledById,
      priority = 'NORMAL',
      medium,
      fileRef,
      physicalLocation,
      dateRegistered,
      addressedTo,
      notes,
      recordsFileId,
      newFileNumber,
      newFileTitle,
      ccRoles,
    } = req.body

    if (!subject || !docType || !direction || !source || !destination || !medium || !dateRegistered) {
      return error(res, 'Subject, type, direction, source, destination, medium and date registered are required')
    }

    // multipart/form-data (this route accepts an optional file alongside the
    // fields) — array fields arrive as a JSON string, not a real array.
    let validatedCcRoles
    try {
      const parsedCcRoles = typeof ccRoles === 'string' ? JSON.parse(ccRoles) : ccRoles
      validatedCcRoles = validateCcRoles(parsedCcRoles)
    } catch (err) {
      return error(res, err.message || 'Invalid ccRoles')
    }

    const file = req.file
    const destinationValue = String(destination).trim()
    const addressedValue = String(addressedTo || destinationValue).trim().toUpperCase()

    const result = await prisma.$transaction(async (tx) => {
      let linkedFileId = recordsFileId || null

      if (!linkedFileId && newFileTitle && String(newFileTitle).trim()) {
        const fileNumber = (newFileNumber && String(newFileNumber).trim())
          || await generateNextFileNumber()
        const newFile = await tx.recordsFile.create({
          data: {
            fileNumber,
            title: String(newFileTitle).trim(),
            createdById: req.user.id,
          },
        })
        linkedFileId = newFile.id
      }

      let sourceDocumentId = null
      if (file) {
        const doc = await tx.document.create({
          data: {
            title: String(subject).trim(),
            category: DOC_TYPE_TO_CATEGORY[docType] || 'OTHER',
            department: req.user.department,
            filePath: file.originalname,
            mimeType: file.mimetype,
            fileData: file.buffer,
            fileSize: file.size,
            uploadedBy: req.user.id,
          },
          select: { id: true },
        })
        sourceDocumentId = doc.id
      }

      const registryNo = await generateRegistryNo()
      const record = await tx.registryEntry.create({
        data: {
          registryNo,
          subject: String(subject).trim(),
          docType,
          direction,
          source: String(source).trim(),
          destination: destinationValue,
          receivedFrom: receivedFrom ? String(receivedFrom).trim() : null,
          handledById: handledById ? parseInt(handledById, 10) : req.user.id,
          priority,
          medium,
          fileRef: fileRef ? String(fileRef).trim() : null,
          physicalLocation: physicalLocation ? String(physicalLocation).trim() : null,
          dateRegistered: new Date(dateRegistered),
          recordsFileId: linkedFileId,
          sourceDocumentId,
        },
        include: {
          handledBy: { select: { id: true, name: true, role: true } },
          recordsFile: true,
        },
      })

      if (notes && String(notes).trim()) {
        await tx.annotation.create({
          data: {
            registryEntryId: record.id,
            authorId: req.user.id,
            type: 'NOTE',
            text: String(notes).trim(),
            ccRoles: validatedCcRoles,
          },
        })
      }

      return record
    })

    if (addressedValue === 'GENERAL_MANAGER') {
      await createPendingRouting({
        sourceType: 'REGISTRY_ENTRY',
        sourceId: result.id,
        addressedTo: 'GENERAL_MANAGER',
      })
    }

    await logAudit({
      userId: req.user.id,
      action: 'LOG_ENTRY',
      module: 'Records',
      description: `Created registry entry ${result.registryNo}${addressedValue === 'GENERAL_MANAGER' ? ' for GM review' : ''}`,
      ipAddress: req.ip,
    })

    const withAnnotations = await prisma.registryEntry.findUnique({
      where: { id: result.id },
      include: {
        handledBy: { select: { id: true, name: true, role: true } },
        recordsFile: true,
        annotations: { include: { author: { select: { id: true, name: true, role: true } } }, orderBy: { createdAt: 'asc' } },
      },
    })

    return success(res, withAnnotations, 'Registry entry created successfully', 201)
  } catch (err) {
    return serverError(res, err)
  }
})

// GET /api/records/files/next-number — the auto-suggested next sequential
// file number, mirroring how registry numbers auto-assign. Read-only preview
// for the standalone "+ New File" modal; the number is only actually
// consumed/incremented at creation time (a second file created concurrently
// would still get the true next number, this is just a starting suggestion).
router.get('/files/next-number', authenticate, authorize(['RECORDS_EXECUTIVE', 'GENERAL_MANAGER', 'IT_ADMINISTRATOR']), async (req, res) => {
  try {
    return success(res, { fileNumber: await generateNextFileNumber() })
  } catch (err) {
    return serverError(res, err)
  }
})

// GET /api/records/files — list RecordsFile entries for the Files tab and
// the Link-to-File picker. ?search matches fileNumber or title.
router.get('/files', authenticate, authorize(['RECORDS_EXECUTIVE', 'GENERAL_MANAGER', 'IT_ADMINISTRATOR']), async (req, res) => {
  try {
    const { search = '' } = req.query
    const where = search ? {
      OR: [
        { fileNumber: { contains: search, mode: 'insensitive' } },
        { title: { contains: search, mode: 'insensitive' } },
      ],
    } : {}

    const files = await prisma.recordsFile.findMany({
      where,
      include: {
        createdBy: { select: { id: true, name: true } },
        _count: { select: { entries: true } },
      },
      orderBy: { createdAt: 'desc' },
    })

    return success(res, files)
  } catch (err) {
    return serverError(res, err)
  }
})

// GET /api/records/files/:id — a dossier's full contents. Two genuinely
// separate models get filed into a RecordsFile via two different foreign
// keys: RegistryEntry.recordsFileId (the old path — physical incoming mail,
// PUT /:entryId/attach-to-file) and CirculationRecordsCopy.recordsFileId
// (the new explicit "Send to File" path — POST /circulation/:id/send-to-file,
// PUT /circulation-copies/:id/file). The dossier detail modal used to be
// built only against the first one (a client-side filter over RegistryEntry
// records), which is why a circulation package filed into REG-FILE-001
// never showed up there — this endpoint queries both and returns them
// together so the modal doesn't have to know which path something came
// through. circulationPackages reuses fetchCirculationPackages() so this
// modal and the Filing Queue render identical package shapes.
router.get('/files/:id', authenticate, authorize(['RECORDS_EXECUTIVE', 'GENERAL_MANAGER', 'IT_ADMINISTRATOR']), async (req, res) => {
  try {
    const { id } = req.params

    const file = await prisma.recordsFile.findUnique({
      where: { id },
      include: { createdBy: { select: { id: true, name: true } } },
    })
    if (!file) return notFound(res, 'Records file not found')

    const [registryEntries, circulationPackages] = await Promise.all([
      prisma.registryEntry.findMany({
        where: { recordsFileId: id },
        include: {
          handledBy: { select: { id: true, name: true, role: true } },
          annotations: {
            include: { author: { select: { id: true, name: true, role: true } } },
            orderBy: { createdAt: 'asc' },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      fetchCirculationPackages({ recordsFileId: id, status: 'FILED' }),
    ])

    return success(res, {
      file,
      registryEntries,
      circulationPackages,
      totalEntries: registryEntries.length + circulationPackages.length,
    })
  } catch (err) {
    return serverError(res, err)
  }
})

// POST /api/records/files — standalone file creation, independent of
// registering any document — the "create a file while waiting for
// documents" capability. Starts with zero entries.
router.post('/files', authenticate, authorize(['RECORDS_EXECUTIVE', 'GENERAL_MANAGER', 'IT_ADMINISTRATOR']), async (req, res) => {
  try {
    const { fileNumber, title, fileType, description } = req.body
    if (!title || !String(title).trim()) {
      return error(res, 'Title is required')
    }

    const number = (fileNumber && String(fileNumber).trim()) || await generateNextFileNumber()

    const file = await prisma.recordsFile.create({
      data: {
        fileNumber: number,
        title: String(title).trim(),
        fileType: fileType ? String(fileType).trim() : null,
        description: description ? String(description).trim() : null,
        createdById: req.user.id,
      },
      include: {
        createdBy: { select: { id: true, name: true } },
      },
    })

    await logAudit({
      userId: req.user.id,
      action: 'RECORDS_FILE_CREATED',
      module: 'Records',
      description: `Created records file ${number} — "${file.title}"`,
      ipAddress: req.ip,
    })

    return success(res, { ...file, _count: { entries: 0 } }, 'File created successfully', 201)
  } catch (err) {
    return serverError(res, err)
  }
})

// PUT /api/records/:entryId/attach-to-file — file an existing registry entry
// into a RecordsFile after the fact (the register modal's own Directive-3
// linking happens at creation time; this covers filing something in later).
router.put('/:entryId/attach-to-file', authenticate, authorize(['RECORDS_EXECUTIVE', 'GENERAL_MANAGER', 'IT_ADMINISTRATOR']), async (req, res) => {
  try {
    const entryId = parseInt(req.params.entryId, 10)
    const { recordsFileId } = req.body
    if (!recordsFileId) return error(res, 'recordsFileId is required')

    const entry = await prisma.registryEntry.findUnique({ where: { id: entryId } })
    if (!entry) return notFound(res, 'Registry entry not found')

    const targetFile = await prisma.recordsFile.findUnique({ where: { id: recordsFileId } })
    if (!targetFile) return notFound(res, 'Records file not found')

    const updated = await prisma.registryEntry.update({
      where: { id: entryId },
      data: { recordsFileId },
      include: { recordsFile: true },
    })

    await logAudit({
      userId: req.user.id,
      action: 'ENTRY_ATTACHED_TO_FILE',
      module: 'Records',
      description: `Filed registry entry ${entry.registryNo} into ${targetFile.fileNumber}`,
      ipAddress: req.ip,
    })

    return success(res, updated, 'Entry attached to file')
  } catch (err) {
    return serverError(res, err)
  }
})

// Shared by GET /circulation-copies (the Filing Queue) and GET /files/:id
// (a dossier's contents) — both need the exact same package shape (real
// source Document + full step/signature trail) so the two surfaces render
// identically instead of teaching users two different mental models for
// "what a filed package looks like".
async function fetchCirculationPackages(where) {
  const copies = await prisma.circulationRecordsCopy.findMany({
    where,
    include: {
      circulation: {
        include: {
          steps: {
            orderBy: { stepNumber: 'asc' },
            include: {
              signature: true,
              fromUser: { select: { id: true, name: true, role: true } },
            },
          },
          originator: { select: { id: true, name: true, role: true } },
          attachments: {
            include: {
              document: { select: { id: true, title: true, mimeType: true, fileSize: true } },
              attachedBy: { select: { id: true, name: true } },
            },
          },
        },
      },
      step: true, // the closing step, kept only for reference — see schema.prisma
      recordsFile: true,
      filedBy: { select: { id: true, name: true, role: true } },
    },
    orderBy: { createdAt: 'desc' }
  })

  // Resolve the real source Document for each package, same batched pattern
  // as the notifications fix (notifications.routes.js) — one query for
  // every referenced document instead of N+1.
  const documentIds = [...new Set(
    copies
      .filter((c) => c.circulation?.sourceType === 'DOCUMENT' && c.circulation.sourceId)
      .map((c) => parseInt(c.circulation.sourceId, 10))
      .filter((id) => !Number.isNaN(id))
  )]
  const sourceDocuments = documentIds.length
    ? await prisma.document.findMany({
        where: { id: { in: documentIds } },
        select: { id: true, title: true, category: true, department: true, filePath: true, mimeType: true, fileSize: true, createdAt: true },
      })
    : []
  const documentsById = new Map(sourceDocuments.map((d) => [d.id, d]))

  return copies.map((c) => ({
    ...c,
    document: c.circulation?.sourceType === 'DOCUMENT'
      ? documentsById.get(parseInt(c.circulation.sourceId, 10)) || null
      : null,
  }))
}

// GET /api/records/circulation-copies — one row per CLOSED-and-sent-to-file
// circulation (see circulation.routes.js POST /:id/send-to-file). Each row
// carries the FULL package: the real originating Document and the complete
// ordered step/signature trail — not just the closing step's single
// instruction string, so the Filing Queue can render what's actually being
// filed instead of a bare quoted line.
router.get('/circulation-copies', authenticate, authorize(['RECORDS_EXECUTIVE']), async (req, res) => {
  try {
    const { status = 'PENDING_FILING' } = req.query
    const copiesWithDocument = await fetchCirculationPackages({ status })
    return success(res, copiesWithDocument)
  } catch (err) {
    return serverError(res, err)
  }
})

// PUT /api/records/circulation-copies/:id/file — mark FILED; recordsFileId
// is optional (the Filing Queue dialog's link-to-file step, same picker as
// the register modal).
router.put('/circulation-copies/:id/file', authenticate, authorize(['RECORDS_EXECUTIVE']), async (req, res) => {
  try {
    const { id } = req.params
    const { recordsFileId } = req.body
    const copy = await prisma.circulationRecordsCopy.update({
      where: { id },
      data: {
        status: 'FILED',
        filedById: req.user.id,
        filedAt: new Date(),
        recordsFileId: recordsFileId || null,
      },
      include: { recordsFile: true },
    })

    await logAudit({
      userId: req.user.id,
      action: 'ENTRY_ATTACHED_TO_FILE',
      module: 'Records',
      description: `Filed circulation copy${copy.recordsFile ? ` into ${copy.recordsFile.fileNumber}` : ''}`,
      ipAddress: req.ip,
    })

    return success(res, copy, 'Circulation copy filed successfully')
  } catch (err) {
    return serverError(res, err)
  }
})

export default router