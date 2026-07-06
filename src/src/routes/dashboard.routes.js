const express = require('express');
const prisma = require('../lib/prisma');
const { success, serverError } = require('../lib/response');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

/**
 * @route   GET /api/dashboard/stats
 * @desc    Get high-level stats for dashboard cards
 * @access  Private
 */
router.get('/stats', authenticate, async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const firstDayOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);

    if (req.user.role === 'PROCUREMENT_OFFICER') {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      
      const firstDayOfLastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const lastDayOfLastMonth = new Date(today.getFullYear(), today.getMonth(), 0, 23, 59, 59);

      const [
        pendingVerification,
        processedRequests,
        vendorBreakdownRaw,
        requestsThisMonthCount,
        requestsLastMonthCount,
        flaggedForClarification
      ] = await Promise.all([
        prisma.procurementRequest.count({ where: { status: 'PENDING_PROCUREMENT_OFFICER' } }),
        prisma.procurementRequest.findMany({
          where: { poProcessedAt: { gte: thirtyDaysAgo } },
          select: { poProcessedAt: true, createdAt: true }
        }),
        prisma.procurementRequest.groupBy({
          by: ['vendorName'],
          where: { vendorName: { not: null } },
          _count: { id: true },
          orderBy: { _count: { id: 'desc' } },
          take: 5
        }),
        prisma.procurementRequest.count({ where: { createdAt: { gte: firstDayOfMonth } } }),
        prisma.procurementRequest.count({ where: { createdAt: { gte: firstDayOfLastMonth, lte: lastDayOfLastMonth } } }),
        prisma.procurementRequest.count({ where: { status: 'PENDING_DEPT_HEAD', poNotes: { not: null } } })
      ]);

      let totalProcessingTime = 0;
      processedRequests.forEach(req => {
        totalProcessingTime += (req.poProcessedAt - req.createdAt);
      });
      const avgProcessingTimeMs = processedRequests.length > 0 ? totalProcessingTime / processedRequests.length : 0;
      const averageProcessingTime = `${(avgProcessingTimeMs / (1000 * 60 * 60)).toFixed(1)} hours`;

      let percentChange = 0;
      if (requestsLastMonthCount > 0) {
        percentChange = Math.round(((requestsThisMonthCount - requestsLastMonthCount) / requestsLastMonthCount) * 100);
      } else if (requestsThisMonthCount > 0) {
        percentChange = 100;
      }

      const vendorBreakdown = vendorBreakdownRaw.map(v => ({
        vendor: v.vendorName,
        count: v._count.id
      }));

      return success(res, {
        pendingVerification,
        averageProcessingTime,
        vendorBreakdown,
        requestsThisMonth: {
          count: requestsThisMonthCount,
          percentChange
        },
        flaggedForClarification
      });
    }

    const [
      totalDocuments,
      docsThisMonth,
      pendingApprovals,
      activityLogsToday,
      totalStaff
    ] = await Promise.all([
      prisma.document.count(),
      prisma.document.count({ where: { createdAt: { gte: firstDayOfMonth } } }),
      prisma.procurementRequest.count({ where: { status: 'PENDING_DEPT_HEAD' } }),
      prisma.activityLog.count({ where: { createdAt: { gte: today } } }),
      prisma.user.count({ where: { isActive: true } }),
    ]);

    return success(res, {
      totalDocuments,
      documentsThisMonth: docsThisMonth,
      pendingApprovals,
      activityLogsToday,
      totalStaff
    });
  } catch (err) {
    return serverError(res, err);
  }
});

/**
 * @route   GET /api/dashboard/procurement-chart
 * @desc    Get procurement approval/rejection stats by month (Last 6 months)
 * @access  Private
 */
router.get('/procurement-chart', authenticate, async (req, res) => {
  try {
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5);
    sixMonthsAgo.setDate(1);
    sixMonthsAgo.setHours(0, 0, 0, 0);

    const reqs = await prisma.procurementRequest.findMany({
      where: { createdAt: { gte: sixMonthsAgo } },
      select: { createdAt: true, status: true }
    });

    // Group by month
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const chartData = {};

    // Initialize last 6 months
    for (let i = 5; i >= 0; i--) {
      const d = new Date();
      d.setMonth(d.getMonth() - i);
      const monthStr = months[d.getMonth()];
      chartData[monthStr] = { month: monthStr, requests: 0, approved: 0, rejected: 0 };
    }

    reqs.forEach(r => {
      const monthStr = months[r.createdAt.getMonth()];
      if (chartData[monthStr]) {
        chartData[monthStr].requests++;
        if (r.status === 'APPROVED' || r.status === 'DEPT_HEAD_APPROVED') chartData[monthStr].approved++;
        if (r.status === 'REJECTED') chartData[monthStr].rejected++;
      }
    });

    return success(res, Object.values(chartData));
  } catch (err) {
    return serverError(res, err);
  }
});

/**
 * @route   GET /api/dashboard/documents-by-category
 * @desc    Get document counts grouped by category
 * @access  Private
 */
router.get('/documents-by-category', authenticate, async (req, res) => {
  try {
    const counts = await prisma.document.groupBy({
      by: ['category'],
      _count: { id: true }
    });

    const colors = {
      POLICY: '#C9973A',
      REPORT: '#CC2200',
      MEMO: '#4ade80',
      CONTRACT: '#a5b4fc',
      FORM: '#f4be5d',
      OTHER: '#94a3b8'
    };

    const data = counts.map(c => ({
      name: c.category.charAt(0).toUpperCase() + c.category.slice(1).toLowerCase(),
      value: c._count.id,
      color: colors[c.category] || colors.OTHER
    }));

    return success(res, data);
  } catch (err) {
    return serverError(res, err);
  }
});

/**
 * @route   GET /api/dashboard/recent-activity
 * @desc    Get latest 8 audit logs for dashboard feed
 * @access  Private
 */
router.get('/recent-activity', authenticate, async (req, res) => {
  try {
    const logs = await prisma.auditLog.findMany({
      take: 8,
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { name: true, role: true } } }
    });

    const formatted = logs.map(log => ({
      id: log.id,
      user: log.user.name,
      role: log.user.role,
      action: log.action,
      module: log.module,
      description: log.description,
      time: log.createdAt
    }));

    return success(res, formatted);
  } catch (err) {
    return serverError(res, err);
  }
});

/**
 * @route   GET /api/dashboard/pending-procurement
 * @desc    Get top 5 pending procurement requests
 * @access  Private
 */
router.get('/pending-procurement', authenticate, async (req, res) => {
  try {
    let where = { status: { in: ['PENDING', 'DEPT_HEAD_APPROVED'] } };
    
    // Scoped view
    if (req.user.role === 'DEPARTMENT_HEAD') {
      where = { department: req.user.department, status: 'PENDING' };
    } else if (req.user.role === 'STAFF') {
      where.requestedById = req.user.id;
    }

    const reqs = await prisma.procurementRequest.findMany({
      where,
      take: 5,
      orderBy: { createdAt: 'desc' },
      include: { requestedBy: { select: { name: true } } }
    });

    const formatted = reqs.map(r => ({
      id: r.referenceNo,
      item: r.itemDescription,
      dept: r.department,
      cost: r.estimatedCost,
      requestedBy: r.requestedBy.name,
      status: r.status
    }));

    return success(res, formatted);
  } catch (err) {
    return serverError(res, err);
  }
});

module.exports = router;
