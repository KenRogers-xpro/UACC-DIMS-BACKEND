import { Router } from 'express'
import { prisma } from '../lib/prisma.js'
import { logAudit } from '../lib/audit.js'
import { sendEmail, templates } from '../lib/email.js'
import { success, error, notFound, serverError } from '../lib/response.js'
import { authenticate, authorize } from '../middleware/auth.js'

const router = Router()

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
        status:            'PENDING',
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
    const allowedRoles = ['DEPARTMENT_HEAD', 'GENERAL_MANAGER']
    if (!allowedRoles.includes(req.user.role)) {
      return error(res, 'Not authorized to approve procurement requests', 403)
    }

    const { decision, comment } = req.body
    if (!['APPROVED', 'REJECTED'].includes(decision)) {
      return error(res, 'Decision must be APPROVED or REJECTED')
    }

    const request = await prisma.procurementRequest.findUnique({
      where:   { id: parseInt(req.params.id) },
      include: { requestedBy: { select: { name: true, email: true } } },
    })
    if (!request) return notFound(res, 'Request not found')

    let updateData = {}

    if (req.user.role === 'DEPARTMENT_HEAD') {
      if (request.status !== 'PENDING') {
        return error(res, 'Request is not pending department head review')
      }
      updateData = {
        status:           decision === 'APPROVED' ? 'DEPT_HEAD_APPROVED' : 'REJECTED',
        deptHeadApproval: decision,
        deptHeadComment:  comment || null,
        approvedById:     req.user.id,
      }
    } else if (req.user.role === 'GENERAL_MANAGER') {
      if (request.status !== 'DEPT_HEAD_APPROVED') {
        return error(res, 'Request has not been approved by Department Head yet')
      }
      updateData = {
        status:       decision,
        gmApproval:   decision,
        gmComment:    comment || null,
        approvedById: req.user.id,
      }
    }

    const updated = await prisma.procurementRequest.update({
      where: { id: parseInt(req.params.id) },
      data:  updateData,
    })

    await logAudit({
      userId:      req.user.id,
      action:      decision === 'APPROVED' ? 'PROCUREMENT_APPROVE' : 'PROCUREMENT_REJECT',
      module:      'Procurement',
      description: `${decision} ${request.referenceNo}${comment ? ` — ${comment}` : ''}`,
      ipAddress:   req.ip,
    })

    // Send email to requester
    const tmpl = templates.procurementDecision(request, decision, comment)
    await sendEmail({
      to:      request.requestedBy.email,
      subject: tmpl.subject,
      html:    tmpl.html,
    })

    // Notify GM if dept head approved
    if (req.user.role === 'DEPARTMENT_HEAD' && decision === 'APPROVED') {
      const gm = await prisma.user.findFirst({
        where: { role: 'GENERAL_MANAGER', isActive: true }
      })
      if (gm) {
        const gmTmpl = templates.procurementSubmitted(
          { ...request, requestedBy: request.requestedBy },
          gm
        )
        await sendEmail({
          to:      gm.email,
          subject: `[DIMS] Awaiting Final Approval — ${request.referenceNo}`,
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
