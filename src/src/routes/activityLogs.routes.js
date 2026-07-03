const express = require('express');
const prisma = require('../lib/prisma');
const { success, error, serverError, paginated } = require('../lib/response');
const { authenticate } = require('../middleware/auth');
const { logAudit, getClientIp } = require('../lib/audit');

const router = express.Router();

/**
 * @route   GET /api/activity-logs
 * @desc    Get activity logs
 * @access  Private
 */
router.get('/', authenticate, async (req, res) => {
  try {
    const { department, page = 1, limit = 10, type = 'all' } = req.query;

    const where = {};
    
    // type = 'mine' -> only show my logs
    // type = 'all' -> show based on role
    
    if (type === 'mine') {
      where.userId = req.user.id;
    } else {
      if (req.user.role === 'STAFF') {
        where.userId = req.user.id;
      } else if (req.user.role === 'DEPARTMENT_HEAD') {
        where.department = req.user.department;
      } else if (department && department !== 'ALL' && department !== 'All') {
        where.department = department;
      }
    }

    const skip = (Number(page) - 1) * Number(limit);
    const take = Number(limit);

    const [logs, total] = await Promise.all([
      prisma.activityLog.findMany({
        where,
        include: {
          user: { select: { name: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      prisma.activityLog.count({ where }),
    ]);

    // Format for frontend
    const formattedLogs = logs.map(log => ({
      id: log.id,
      staffName: log.user.name,
      department: log.department,
      logDate: log.logDate.toISOString().split('T')[0],
      activityDescription: log.activityDescription,
      hoursSpent: log.hoursSpent,
      createdAt: log.createdAt,
    }));

    return paginated(res, { data: formattedLogs, total, page: Number(page), limit: take });
  } catch (err) {
    return serverError(res, err);
  }
});

/**
 * @route   POST /api/activity-logs
 * @desc    Submit a new activity log
 * @access  Private
 */
router.post('/', authenticate, async (req, res) => {
  try {
    const { logDate, activityDescription, hoursSpent } = req.body;

    if (!logDate || !activityDescription || !hoursSpent) {
      return error(res, 'Missing required fields');
    }

    const newLog = await prisma.activityLog.create({
      data: {
        userId: req.user.id,
        department: req.user.department,
        logDate: new Date(logDate),
        activityDescription,
        hoursSpent: Number(hoursSpent),
      },
    });

    await logAudit({
      userId: req.user.id,
      action: 'LOG_ENTRY',
      module: 'Activity Logs',
      description: `Submitted daily activity log for ${logDate} (${hoursSpent} hours)`,
      ipAddress: getClientIp(req),
    });

    return success(res, newLog, 201);
  } catch (err) {
    return serverError(res, err);
  }
});

module.exports = router;
