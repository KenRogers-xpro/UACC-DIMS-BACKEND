const express = require('express');
const prisma = require('../lib/prisma');
const { success, error, serverError, paginated } = require('../lib/response');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

/**
 * @route   GET /api/audit-logs
 * @desc    Get audit trail logs
 * @access  Private (Auditor / GM / Admin)
 */
router.get('/', authenticate, authorize('AUDITOR', 'GENERAL_MANAGER', 'IT_ADMINISTRATOR'), async (req, res) => {
  try {
    const { actionType, search, page = 1, limit = 20 } = req.query;

    const where = {};
    
    if (actionType && actionType !== 'ALL' && actionType !== 'All') {
      where.action = actionType;
    }

    if (search) {
      where.OR = [
        { description: { contains: search } },
        { user: { name: { contains: search } } },
      ];
    }

    const skip = (Number(page) - 1) * Number(limit);
    const take = Number(limit);

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        include: {
          user: { select: { name: true, role: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      prisma.auditLog.count({ where }),
    ]);

    // Format for frontend
    const formattedLogs = logs.map(log => ({
      id: log.id,
      userId: log.userId,
      userName: log.user.name,
      userRole: log.user.role,
      action: log.action,
      module: log.module,
      description: log.description,
      ipAddress: log.ipAddress || 'Unknown',
      createdAt: log.createdAt,
    }));

    return paginated(res, { data: formattedLogs, total, page: Number(page), limit: take });
  } catch (err) {
    return serverError(res, err);
  }
});

module.exports = router;
