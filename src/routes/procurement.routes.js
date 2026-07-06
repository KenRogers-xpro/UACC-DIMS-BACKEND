import { Router } from 'express'
import { prisma } from '../lib/prisma.js'
import { logAudit } from '../lib/audit.js'
import { sendEmail, templates } from '../lib/email.js'
import { success, error, notFound, serverError } from '../lib/response.js'
import { authenticate, authorize } from '../middleware/auth.js'

const router = Router()

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

// Generate procurement reference number
async function generateProcurementRef() {
  const year   = new Date().getFullYear()
  const prefix = `UACC-PROC-${year}-`
  const latest = await prisma.procurementRequest.findFirst({
    where:   { referenceNo: { startsWith: prefix } },
    orderBy: { createdAt: 'desc' },
  })
  if (!latest) return `${prefix}0001`
  const lastNum = parseInt(latest.referenceNo.split('-').pop())
  return `${prefix}${String(lastNum + 1).padStart(4, '0')}`
}

// GET /api/procurement
router.get('/', authenticate, async (req, res) => {
  try {
    const { status = '', department = '', search = '', page = 1, limit = 10 } = req.query

    let roleFilter = {}
    if (req.user.role === 'STAFF') {
      roleFilter = { requestedById: req.user.id }
    } else if (req.user.role === 'DEPARTMENT_HEAD') {
      roleFilter = { department: req.user.department }
    }

    const where = {
      AND: [
        roleFilter,
        status     ? { status }     : {},
        department ? { department } : {},
        search ? {
          OR: [
            { referenceNo:     { contains: search, mode: 'insensitive' } },
            { itemDescription: { contains: search, mode: 'insensitive' } },
          ],
        } : {},
      ],
    }

    const [requests, total] = await Promise.all([
      prisma.procurementRequest.findMany({
        where,
        include: {
          requestedBy: { select: { id: true, name: true, role: true, department: true } },
          approvedBy:  { select: { id: true, name: true, role: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip:    (parseInt(page) - 1) * parseInt(limit),
        take:    parseInt(limit),
      }),
      prisma.procurementRequest.count({ where }),
    ])

    return success(res, {
      requests,
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

// POST /api/procurement
router.post('/', authenticate, async (req, res) => {
  try {
    const allowedRoles = ['STAFF', 'DEPARTMENT_HEAD', 'IT_ADMINISTRATOR']
    if (!allowedRoles.includes(req.user.role)) {
      return error(res, 'Not authorized to submit procurement requests', 403)
    }

    const { itemDescription, quantity, estimatedCost, department, justification } = req.body

    if (!itemDescription || !quantity || !estimatedCost || !department || !justification) {
      return error(res, 'All fields are required')
    }

    const referenceNo = await generateProcurementRef()

    const request = await prisma.procurementRequest.create({
      data: {
        referenceNo,
        itemDescription:   String(itemDescription).trim(),
        quantity:          parseInt(quantity),
        estimatedCost:     parseFloat(estimatedCost),
        department,
        justification:     String(justification).trim(),
        requestedById:     req.user.id,
        status:            'PENDING_DEPT_HEAD',
      },
      include: {
        requestedBy: { select: { id: true, name: true, email: true, role: true } },
      },
    })

    await logAudit({
      userId:      req.user.id,
      action:      'PROCUREMENT_SUBMIT',
      module:      'Procurement',
      description: `Submitted ${referenceNo} — ${itemDescription}`,
      ipAddress:   req.ip,
    })

    // Notify Department Heads
    const deptHeads = await prisma.user.findMany({
      where: { role: 'DEPARTMENT_HEAD', department, isActive: true }
    })
    for (const head of deptHeads) {
      const tmpl = templates.procurementSubmitted(request, head)
      await sendEmail({ to: head.email, subject: tmpl.subject, html: tmpl.html })
    }

    return success(res, request, `Request submitted. Reference: ${referenceNo}`, 201)
  } catch (err) {
    return serverError(res, err)
  }
})

// PATCH /api/procurement/:id/decision
router.patch('/:id/decision', authenticate, async (req, res) => {
  try {
    const allowedRoles = ['DEPARTMENT_HEAD', 'PROCUREMENT_OFFICER', 'GENERAL_MANAGER']
    if (!allowedRoles.includes(req.user.role)) {
      return error(res, 'Not authorized to approve procurement requests', 403)
    }

    const { decision, comment, vendorName, vendorVerified, budgetVerified } = req.body
    
    const request = await prisma.procurementRequest.findUnique({
      where:   { id: parseInt(req.params.id) },
      include: { requestedBy: { select: { name: true, email: true } } },
    })
    if (!request) return notFound(res, 'Request not found')

    let updateData = {}
    let auditAction = ''
    let emailSubject = ''
    let emailHtml = ''

    if (req.user.role === 'DEPARTMENT_HEAD') {
      if (!['APPROVED', 'REJECTED'].includes(decision)) {
        return error(res, 'Decision must be APPROVED or REJECTED')
      }
      if (request.status !== 'PENDING_DEPT_HEAD') {
        return error(res, 'Request is not pending department head review')
      }
      updateData = {
        status:           decision === 'APPROVED' ? 'PENDING_PROCUREMENT_OFFICER' : 'REJECTED',
        deptHeadApproval: decision,
        deptHeadComment:  comment || null,
        approvedById:     req.user.id,
      }
      auditAction = decision === 'APPROVED' ? 'PROCUREMENT_APPROVE' : 'PROCUREMENT_REJECT'
    } else if (req.user.role === 'PROCUREMENT_OFFICER') {
      if (!['VERIFIED', 'RETURNED'].includes(decision)) {
        return error(res, 'Decision must be VERIFIED or RETURNED')
      }
      if (request.status !== 'PENDING_PROCUREMENT_OFFICER') {
        return error(res, 'Request is not pending procurement officer review')
      }
      
      updateData = {
        status: decision === 'VERIFIED' ? 'PENDING_GM' : 'PENDING_DEPT_HEAD',
        vendorName: vendorName || request.vendorName,
        vendorVerified: vendorVerified === true,
        budgetVerified: budgetVerified === true,
        poNotes: comment || null,
        poProcessedById: req.user.id,
        poProcessedAt: new Date()
      }
      
      // If returned to Dept Head, reset Dept Head approval
      if (decision === 'RETURNED') {
        updateData.deptHeadApproval = null
      }

      auditAction = decision === 'VERIFIED' ? 'PROCUREMENT_VENDOR_VERIFIED' : 'PROCUREMENT_REJECT'
    } else if (req.user.role === 'GENERAL_MANAGER') {
      if (!['APPROVED', 'REJECTED'].includes(decision)) {
        return error(res, 'Decision must be APPROVED or REJECTED')
      }
      if (request.status !== 'PENDING_GM') {
        return error(res, 'Request has not been verified by Procurement Officer yet')
      }
      updateData = {
        status:       decision,
        gmApproval:   decision,
        gmComment:    comment || null,
        approvedById: req.user.id,
      }
      auditAction = decision === 'APPROVED' ? 'PROCUREMENT_APPROVE' : 'PROCUREMENT_REJECT'
    }

    const updated = await prisma.procurementRequest.update({
      where: { id: parseInt(req.params.id) },
      data:  updateData,
    })

    await logAudit({
      userId:      req.user.id,
      action:      auditAction,
      module:      'Procurement',
      description: `${decision} ${request.referenceNo}${comment ? ` — ${comment}` : ''}`,
      ipAddress:   req.ip,
    })

    // Email logic
    if (decision === 'REJECTED' || decision === 'RETURNED' || (req.user.role === 'GENERAL_MANAGER' && decision === 'APPROVED')) {
      // Send email to requester for final decisions or returns
      const tmpl = templates.procurementDecision(request, decision, comment)
      await sendEmail({
        to:      request.requestedBy.email,
        subject: tmpl.subject,
        html:    tmpl.html,
      })
    }

    // Notify Procurement Officer if dept head approved
    if (req.user.role === 'DEPARTMENT_HEAD' && decision === 'APPROVED') {
      const pos = await prisma.user.findMany({
        where: { role: 'PROCUREMENT_OFFICER', isActive: true }
      })
      for (const po of pos) {
        const tmpl = templates.procurementSubmitted(request, po)
        await sendEmail({ to: po.email, subject: tmpl.subject, html: tmpl.html })
      }
    }

    // Notify GM if procurement officer verified
    if (req.user.role === 'PROCUREMENT_OFFICER' && decision === 'VERIFIED') {
      await createPendingRouting({
        sourceType: 'PROCUREMENT_REQUEST',
        sourceId: request.id,
        addressedTo: 'GENERAL_MANAGER',
      })

      const gm = await prisma.user.findFirst({
        where: { role: 'GENERAL_MANAGER', isActive: true }
      })
      if (gm) {
        const gmTmpl = templates.procurementOfficerVerified(request, gm)
        await sendEmail({
          to:      gm.email,
          subject: gmTmpl.subject,
          html:    gmTmpl.html,
        })
      }
    }

    return success(res, updated, `Request ${decision.toLowerCase()} successfully`)
  } catch (err) {
    return serverError(res, err)
  }
})

export default router
