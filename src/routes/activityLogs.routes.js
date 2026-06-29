import { Router } from 'express'
import { prisma } from '../lib/prisma.js'
import { logAudit } from '../lib/audit.js'
import { success, error, serverError } from '../lib/response.js'
import { authenticate } from '../middleware/auth.js'

const router = Router()

// GET /api/activity-logs
router.get('/', authenticate, async (req, res) => {
  try {
    const {
      department = '', staffId = '', dateFrom = '', dateTo = '',
      page = 1, limit = 10, myLogs = 'false'
    } = req.query

    let roleFilter = {}
    if (req.user.role === 'STAFF' || myLogs === 'true') {
      roleFilter = { userId: req.user.id }
    } else if (req.user.role === 'DEPARTMENT_HEAD') {
      roleFilter = { department: req.user.department }
    }

    const where = {
      AND: [
        roleFilter,
        department ? { department }                              : {},
        staffId    ? { userId: parseInt(staffId) }               : {},
        dateFrom   ? { logDate: { gte: new Date(dateFrom) } }   : {},
        dateTo     ? { logDate: { lte: new Date(dateTo) } }     : {},
      ],
    }

    const [logs, total, agg] = await Promise.all([
      prisma.activityLog.findMany({
        where,
        include: { user: { select: { id: true, name: true, role: true } } },
        orderBy: { logDate: 'desc' },
        skip:    (parseInt(page) - 1) * parseInt(limit),
        take:    parseInt(limit),
      }),
      prisma.activityLog.count({ where }),
      prisma.activityLog.aggregate({ where, _sum: { hoursSpent: true } }),
    ])

    return success(res, {
      logs,
      totalHours: agg._sum.hoursSpent || 0,
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

// POST /api/activity-logs
router.post('/', authenticate, async (req, res) => {
  try {
    const { logDate, activityDescription, hoursSpent } = req.body

    if (!logDate || !activityDescription || !hoursSpent) {
      return error(res, 'Date, description and hours are required')
    }

    if (parseFloat(hoursSpent) < 0.5 || parseFloat(hoursSpent) > 12) {
      return error(res, 'Hours must be between 0.5 and 12')
    }

    if (String(activityDescription).trim().length < 20) {
      return error(res, 'Description must be at least 20 characters')
    }

    // Check for duplicate entry on same date
    const existing = await prisma.activityLog.findFirst({
      where: {
        userId:  req.user.id,
        logDate: new Date(logDate),
      },
    })
    if (existing) {
      return error(res, 'You have already submitted a log for this date', 409)
    }

    const log = await prisma.activityLog.create({
      data: {
        userId:              req.user.id,
        department:          req.user.department,
        logDate:             new Date(logDate),
        activityDescription: String(activityDescription).trim(),
        hoursSpent:          parseFloat(hoursSpent),
      },
      include: { user: { select: { id: true, name: true, role: true } } },
    })

    await logAudit({
      userId:      req.user.id,
      action:      'LOG_ENTRY',
      module:      'Activity Logs',
      description: `Submitted activity log for ${logDate} (${hoursSpent} hours)`,
      ipAddress:   req.ip,
    })

    return success(res, log, 'Activity log submitted successfully', 201)
  } catch (err) {
    return serverError(res, err)
  }
})

export default router
