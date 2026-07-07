import { Router } from 'express'
import { prisma } from '../lib/prisma.js'
import { success, serverError } from '../lib/response.js'
import { authenticate } from '../middleware/auth.js'

const router = Router()

// ── GET /api/dashboard/stats ─────────────────────────────────────────────────
router.get('/stats', authenticate, async (req, res) => {
  try {
    const now = new Date()
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate())

    const [
      totalDocuments,
      documentsThisMonth,
      pendingApprovals,
      activityLogsToday,
      totalStaff,
    ] = await Promise.all([
      prisma.document.count(),
      prisma.document.count({
        where: { createdAt: { gte: startOfMonth } },
      }),
      prisma.procurementRequest.count({
        where: {
          status: {
            in: ['PENDING_DEPT_HEAD', 'PENDING_PROCUREMENT_OFFICER', 'PENDING_GM'],
          },
        },
      }),
      prisma.activityLog.count({
        where: { createdAt: { gte: startOfDay } },
      }),
      prisma.user.count({
        where: { isActive: true },
      }),
    ])

    return success(res, {
      totalDocuments,
      documentsThisMonth,
      pendingApprovals,
      activityLogsToday,
      totalStaff,
    })
  } catch (err) {
    return serverError(res, err)
  }
})

// ── GET /api/dashboard/procurement-chart ──────────────────────────────────────
router.get('/procurement-chart', authenticate, async (req, res) => {
  try {
    const now = new Date()
    const months = []

    for (let i = 5; i >= 0; i--) {
      const start = new Date(now.getFullYear(), now.getMonth() - i, 1)
      const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 1)
      const monthLabel = start.toLocaleString('en-US', { month: 'short' })

      const [approved, rejected] = await Promise.all([
        prisma.procurementRequest.count({
          where: {
            status: 'APPROVED',
            updatedAt: { gte: start, lt: end },
          },
        }),
        prisma.procurementRequest.count({
          where: {
            status: 'REJECTED',
            updatedAt: { gte: start, lt: end },
          },
        }),
      ])

      months.push({ month: monthLabel, approved, rejected })
    }

    return success(res, months)
  } catch (err) {
    return serverError(res, err)
  }
})

// ── GET /api/dashboard/documents-by-category ─────────────────────────────────
router.get('/documents-by-category', authenticate, async (req, res) => {
  try {
    const categories = await prisma.document.groupBy({
      by: ['category'],
      _count: { id: true },
    })

    const CATEGORY_COLORS = {
      POLICY:   '#C9973A',
      REPORT:   '#4ade80',
      MEMO:     '#a5b4fc',
      CONTRACT: '#f472b6',
      FORM:     '#fbbf24',
      OTHER:    '#94a3b8',
    }

    const data = categories.map((cat) => ({
      name: cat.category.charAt(0) + cat.category.slice(1).toLowerCase(),
      value: cat._count.id,
      color: CATEGORY_COLORS[cat.category] || '#94a3b8',
    }))

    return success(res, data)
  } catch (err) {
    return serverError(res, err)
  }
})

// ── GET /api/dashboard/recent-activity ───────────────────────────────────────
router.get('/recent-activity', authenticate, async (req, res) => {
  try {
    const logs = await prisma.auditLog.findMany({
      take: 10,
      orderBy: { createdAt: 'desc' },
      include: {
        user: {
          select: { id: true, name: true, role: true, department: true },
        },
      },
    })

    const data = logs.map((log) => {
      const now = new Date()
      const logDate = new Date(log.createdAt)
      const diffMs = now - logDate
      const diffMin = Math.floor(diffMs / 60000)
      let time

      if (diffMin < 1) time = 'Just now'
      else if (diffMin < 60) time = `${diffMin}m ago`
      else if (diffMin < 1440) time = `${Math.floor(diffMin / 60)}h ago`
      else time = `${Math.floor(diffMin / 1440)}d ago`

      return {
        id: log.id,
        user: log.user.name,
        role: log.user.role,
        action: log.action,
        module: log.module,
        description: log.description,
        time,
      }
    })

    return success(res, data)
  } catch (err) {
    return serverError(res, err)
  }
})

// ── GET /api/dashboard/pending-procurement ───────────────────────────────────
router.get('/pending-procurement', authenticate, async (req, res) => {
  try {
    const requests = await prisma.procurementRequest.findMany({
      where: {
        status: {
          in: ['PENDING_DEPT_HEAD', 'PENDING_PROCUREMENT_OFFICER', 'PENDING_GM'],
        },
      },
      take: 5,
      orderBy: { createdAt: 'desc' },
      include: {
        requestedBy: {
          select: { id: true, name: true, department: true },
        },
      },
    })

    const data = requests.map((req) => ({
      id: req.referenceNo,
      item: req.itemDescription,
      dept: req.department,
      cost: Number(req.estimatedCost),
      status: req.status,
    }))

    return success(res, data)
  } catch (err) {
    return serverError(res, err)
  }
})

export default router
