const express = require('express');
const prisma = require('../lib/prisma');
const { success, error, serverError, paginated } = require('../lib/response');
const { authenticate, authorize } = require('../middleware/auth');
const { logAudit, getClientIp } = require('../lib/audit');

const router = express.Router();

/**
 * @route   GET /api/procurement
 * @desc    Get all procurement requests
 * @access  Private
 */
router.get('/', authenticate, async (req, res) => {
  try {
    const { status, department, search, page = 1, limit = 10 } = req.query;

    const where = {};
    if (status && status !== 'All') where.status = status;
    
    // Role based filtering
    if (req.user.role === 'STAFF') {
      where.requestedById = req.user.id;
    } else if (req.user.role === 'DEPARTMENT_HEAD') {
      where.department = req.user.department;
    } else if (department && department !== 'All') {
      where.department = department;
    }

    if (search) {
      where.OR = [
        { referenceNo: { contains: search } },
        { itemDescription: { contains: search } },
      ];
    }

    const skip = (Number(page) - 1) * Number(limit);
    const take = Number(limit);

    const [requests, total] = await Promise.all([
      prisma.procurementRequest.findMany({
        where,
        include: {
          requestedBy: { select: { name: true } },
          approvedBy: { select: { name: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      prisma.procurementRequest.count({ where }),
    ]);

    // Format for frontend
    const formattedReqs = requests.map(req => ({
      ...req,
      requestedBy: req.requestedBy.name,
      approvedBy: req.approvedBy ? req.approvedBy.name : null,
    }));

    return paginated(res, { data: formattedReqs, total, page: Number(page), limit: take });
  } catch (err) {
    return serverError(res, err);
  }
});

/**
 * @route   POST /api/procurement
 * @desc    Create a new procurement request
 * @access  Private (Staff / Dept Head)
 */
router.post('/', authenticate, async (req, res) => {
  try {
    const { itemDescription, quantity, estimatedCost, justification, supportingDocument } = req.body;

    if (!itemDescription || !quantity || !estimatedCost || !justification) {
      return error(res, 'Missing required fields');
    }

    // Generate reference number: UACC-PROC-YYYY-XXXX
    const year = new Date().getFullYear();
    const count = await prisma.procurementRequest.count();
    const referenceNo = `UACC-PROC-${year}-${String(count + 1).padStart(4, '0')}`;

    const newReq = await prisma.procurementRequest.create({
      data: {
        referenceNo,
        itemDescription,
        quantity: Number(quantity),
        estimatedCost: Number(estimatedCost),
        department: req.user.department,
        justification,
        supportingDocument,
        requestedById: req.user.id,
        status: 'PENDING',
      },
    });

    await logAudit({
      userId: req.user.id,
      action: 'PROCUREMENT_SUBMIT',
      module: 'Procurement',
      description: `Submitted new procurement request ${referenceNo} (${itemDescription})`,
      ipAddress: getClientIp(req),
    });

    return success(res, newReq, 201);
  } catch (err) {
    return serverError(res, err);
  }
});

/**
 * @route   PATCH /api/procurement/:id/approve
 * @desc    Approve or reject a procurement request
 * @access  Private (Dept Head / GM)
 */
router.patch('/:id/approve', authenticate, authorize('DEPARTMENT_HEAD', 'GENERAL_MANAGER'), async (req, res) => {
  try {
    const { status, comment } = req.body; // status: 'APPROVED' or 'REJECTED'
    
    if (!['APPROVED', 'REJECTED'].includes(status)) {
      return error(res, 'Invalid status');
    }

    const request = await prisma.procurementRequest.findUnique({ where: { id: Number(req.params.id) } });
    if (!request) return error(res, 'Request not found', 404);

    const updateData = {};
    let finalStatus = request.status;

    if (req.user.role === 'DEPARTMENT_HEAD') {
      if (request.department !== req.user.department) {
        return error(res, 'Forbidden: Cannot approve requests for other departments', 403);
      }
      updateData.deptHeadApproval = status;
      updateData.deptHeadComment = comment;
      finalStatus = status === 'APPROVED' ? 'DEPT_HEAD_APPROVED' : 'REJECTED';
    } 
    else if (req.user.role === 'GENERAL_MANAGER') {
      if (request.status !== 'DEPT_HEAD_APPROVED' && request.status !== 'PENDING') {
         return error(res, `Cannot approve/reject request in ${request.status} status`);
      }
      updateData.gmApproval = status;
      updateData.gmComment = comment;
      updateData.approvedById = req.user.id;
      finalStatus = status === 'APPROVED' ? 'APPROVED' : 'REJECTED';
    }

    updateData.status = finalStatus;

    const updatedReq = await prisma.procurementRequest.update({
      where: { id: Number(req.params.id) },
      data: updateData,
    });

    await logAudit({
      userId: req.user.id,
      action: finalStatus === 'REJECTED' ? 'PROCUREMENT_REJECT' : 'PROCUREMENT_APPROVE',
      module: 'Procurement',
      description: `${finalStatus === 'REJECTED' ? 'Rejected' : 'Approved'} request ${request.referenceNo}`,
      ipAddress: getClientIp(req),
    });

    return success(res, updatedReq);
  } catch (err) {
    return serverError(res, err);
  }
});

module.exports = router;
