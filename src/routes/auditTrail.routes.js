import { Router } from 'express'
import { prisma } from '../lib/prisma.js'
import { success, error, serverError } from '../lib/response.js'
import { authenticate, authorize } from '../middleware/auth.js'

const router = Router()

router.get(
  '/',
  authenticate,
  authorize(['INTERNAL_AUDITOR', 'GENERAL_MANAGER', 'IT_ADMINISTRATOR']),
  async (req, res) => {
    try {
      const {
        search = '', action = '', module = '',
        userId = '', dateFrom = '', dateTo = '',
        page = 1, limit = 10,
      } = req.query

      const where = {
        AND: [
          search ? { description: { contains: search, mode: 'insensitive' } } : {},
          action ? { action }                                                   : {},
          module ? { module }                                                   : {},
          userId ? { userId: parseInt(userId) }                                 : {},
          dateFrom ? { createdAt: { gte: new Date(dateFrom) } }               : {},
          dateTo   ? { createdAt: { lte: new Date(dateTo) } }                 : {},
        ],
      }

      const [logs, total] = await Promise.all([
        prisma.auditLog.findMany({
          where,
          include: { user: { select: { id: true, name: true, role: true } } },
          orderBy: { createdAt: 'desc' },
          skip:    (parseInt(page) - 1) * parseInt(limit),
          take:    parseInt(limit),
        }),
        prisma.auditLog.count({ where }),
      ])

      const [totalActions, deleteActions, todayActions, uniqueUsers] =
        await Promise.all([
          prisma.auditLog.count(),
          prisma.auditLog.count({ where: { action: 'DOCUMENT_DELETE' } }),
          prisma.auditLog.count({
            where: { createdAt: { gte: new Date(new Date().setHours(0,0,0,0)) } }
          }),
          prisma.auditLog.groupBy({ by: ['userId'], _count: { userId: true } }),
        ])

      return success(res, {
        logs,
        stats: {
          totalActions,
          deleteActions,
          todayActions,
          uniqueUsers: uniqueUsers.length,
        },
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
  }
)

export default router
