import { Router } from 'express'
import { prisma } from '../lib/prisma.js'
import { logAudit } from '../lib/audit.js'
import { success, error, notFound, serverError } from '../lib/response.js'
import { authenticate, authorize } from '../middleware/auth.js'

const router = Router()

function normalizeDraftStatus(status, fallback = 'DRAFT') {
  const value = String(status || fallback).toUpperCase()
  return ['DRAFT', 'PENDING_GM_REVIEW', 'GM_APPROVED', 'GM_REJECTED', 'FINALIZED'].includes(value)
    ? value
    : fallback
}

function normalizeCategory(category) {
  return ['POLICY', 'REPORT', 'MEMO', 'CONTRACT', 'FORM', 'OTHER'].includes(String(category || '').toUpperCase())
    ? String(category).toUpperCase()
    : 'OTHER'
}

function normalizeDepartment(department) {
  return ['GENERAL_MANAGER_OFFICE', 'FINANCE_AND_ADMINISTRATION', 'ENGINEERING', 'PILOTS', 'OPERATIONS'].includes(String(department || '').toUpperCase())
    ? String(department).toUpperCase()
    : 'GENERAL_MANAGER_OFFICE'
}

function parseBoolean(value) {
  return ['true', '1', 'yes', 'on'].includes(String(value || '').toLowerCase())
}

function getWeekStart() {
  const date = new Date()
  const day = date.getDay()
  const diff = date.getDate() - day + (day === 0 ? -6 : 1)
  const weekStart = new Date(date)
  weekStart.setDate(diff)
  weekStart.setHours(0, 0, 0, 0)
  return weekStart
}

async function makeDocumentFromDraft(draft, data = {}) {
  return prisma.document.create({
    data: {
      title: draft.title,
      category: normalizeCategory(data.category),
      department: normalizeDepartment(data.department),
      description: draft.content,
      filePath: data.filePath || `draft://${draft.id}`,
      fileSize: null,
      uploadedBy: draft.draftedById,
    },
    include: {
      uploader: { select: { id: true, name: true, role: true } },
    },
  })
}

// GET /api/drafts/summary
router.get('/summary', authenticate, authorize(['GM_PERSONAL_ASSISTANT', 'GENERAL_MANAGER']), async (req, res) => {
  try {
    const scope = req.user.role === 'GM_PERSONAL_ASSISTANT'
      ? { draftedById: req.user.id }
      : {}

    const weekStart = getWeekStart()

    const [pendingGMReviewCount, rejectedThisWeekCount, totalDrafts] = await Promise.all([
      prisma.draftDocument.count({ where: { ...scope, status: 'PENDING_GM_REVIEW' } }),
      prisma.draftDocument.count({
        where: {
          ...scope,
          status: 'GM_REJECTED',
          updatedAt: { gte: weekStart },
        },
      }),
      prisma.draftDocument.count({ where: scope }),
    ])

    return success(res, {
      summary: {
        pendingGMReviewCount,
        rejectedThisWeekCount,
        totalDrafts,
      },
    })
  } catch (err) {
    return serverError(res, err)
  }
})

// POST /api/drafts
router.post('/', authenticate, authorize(['GM_PERSONAL_ASSISTANT']), async (req, res) => {
  try {
    const { title, content } = req.body

    if (!title || !content) {
      return error(res, 'Title and content are required')
    }

    const draft = await prisma.draftDocument.create({
      data: {
        title: String(title).trim(),
        content: String(content).trim(),
        draftedById: req.user.id,
        status: 'DRAFT',
      },
      include: {
        draftedBy: { select: { id: true, name: true, role: true } },
      },
    })

    await logAudit({
      userId: req.user.id,
      action: 'DRAFT_CREATED',
      module: 'Drafts',
      description: `Drafted by PA: created draft "${draft.title}" createdById=${req.user.id}`,
      ipAddress: req.ip,
    })

    return success(res, draft, 'Draft created successfully', 201)
  } catch (err) {
    return serverError(res, err)
  }
})

// PUT /api/drafts/:id/submit
router.put('/:id/submit', authenticate, authorize(['GM_PERSONAL_ASSISTANT']), async (req, res) => {
  try {
    const draft = await prisma.draftDocument.findUnique({
      where: { id: req.params.id },
    })

    if (!draft) return notFound(res, 'Draft not found')

    if (draft.draftedById !== req.user.id) {
      return error(res, 'You can only submit drafts you created', 403)
    }

    if (draft.status !== 'DRAFT') {
      return error(res, 'Only DRAFT drafts can be submitted', 409)
    }

    const updated = await prisma.draftDocument.update({
      where: { id: req.params.id },
      data: { status: 'PENDING_GM_REVIEW' },
      include: {
        draftedBy: { select: { id: true, name: true, role: true } },
      },
    })

    await logAudit({
      userId: req.user.id,
      action: 'DRAFT_SUBMITTED',
      module: 'Drafts',
      description: `Drafted by PA: submitted draft "${updated.title}" createdById=${req.user.id}`,
      ipAddress: req.ip,
    })

    return success(res, updated, 'Draft submitted for GM review')
  } catch (err) {
    return serverError(res, err)
  }
})

// GET /api/drafts/pending
router.get('/pending', authenticate, authorize(['GENERAL_MANAGER']), async (req, res) => {
  try {
    const drafts = await prisma.draftDocument.findMany({
      where: { status: 'PENDING_GM_REVIEW' },
      include: {
        draftedBy: { select: { id: true, name: true, role: true } },
      },
      orderBy: { createdAt: 'asc' },
    })

    return success(res, drafts)
  } catch (err) {
    return serverError(res, err)
  }
})

// PUT /api/drafts/:id/review
router.put('/:id/review', authenticate, authorize(['GENERAL_MANAGER']), async (req, res) => {
  try {
    const { decision, gmFeedback } = req.body

    if (!['GM_APPROVED', 'GM_REJECTED'].includes(String(decision || '').toUpperCase())) {
      return error(res, 'Decision must be GM_APPROVED or GM_REJECTED')
    }

    const draft = await prisma.draftDocument.findUnique({
      where: { id: req.params.id },
    })

    if (!draft) return notFound(res, 'Draft not found')

    if (draft.status !== 'PENDING_GM_REVIEW') {
      return error(res, 'Only PENDING_GM_REVIEW drafts can be reviewed', 409)
    }

    const updated = await prisma.draftDocument.update({
      where: { id: req.params.id },
      data: {
        status: String(decision).toUpperCase(),
        gmFeedback: gmFeedback ? String(gmFeedback).trim() : null,
      },
      include: {
        draftedBy: { select: { id: true, name: true, role: true } },
      },
    })

    await logAudit({
      userId: req.user.id,
      action: 'DRAFT_REVIEWED',
      module: 'Drafts',
      description: `Reviewed by GM: ${updated.status.toLowerCase()} draft "${updated.title}"${gmFeedback ? ` — ${String(gmFeedback).trim()}` : ''}`,
      ipAddress: req.ip,
    })

    return success(res, updated, `Draft ${updated.status.toLowerCase()} successfully`)
  } catch (err) {
    return serverError(res, err)
  }
})

// PUT /api/drafts/:id/finalize
router.put('/:id/finalize', authenticate, authorize(['GM_PERSONAL_ASSISTANT']), async (req, res) => {
  try {
    const draft = await prisma.draftDocument.findUnique({
      where: { id: req.params.id },
    })

    if (!draft) return notFound(res, 'Draft not found')

    if (draft.status !== 'GM_APPROVED') {
      return error(res, 'Only GM_APPROVED drafts can be finalized', 409)
    }

    const convertToDocument = parseBoolean(req.body.convertToDocument)
    const createdDocument = convertToDocument
      ? await makeDocumentFromDraft(draft, {
          category: req.body.category,
          department: req.body.department,
          filePath: req.body.filePath,
        })
      : null

    const updated = await prisma.draftDocument.update({
      where: { id: req.params.id },
      data: { status: 'FINALIZED' },
      include: {
        draftedBy: { select: { id: true, name: true, role: true } },
      },
    })

    await logAudit({
      userId: req.user.id,
      action: 'DRAFT_FINALIZED',
      module: 'Drafts',
      description: `Drafted by PA: finalized draft "${updated.title}" createdById=${req.user.id}${convertToDocument ? ' and converted to Document' : ''}`,
      ipAddress: req.ip,
    })

    return success(res, {
      draft: updated,
      document: createdDocument,
    }, 'Draft finalized successfully')
  } catch (err) {
    return serverError(res, err)
  }
})

export default router