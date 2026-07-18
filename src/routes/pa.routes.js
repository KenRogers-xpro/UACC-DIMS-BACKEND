import { Router } from 'express'
import { prisma } from '../lib/prisma.js'
import { logAudit } from '../lib/audit.js'
import { success, error, notFound, serverError } from '../lib/response.js'
import { authenticate, authorize } from '../middleware/auth.js'
import { sendGMCommunication } from '../lib/email.js'

const router = Router()

function normalizePriority(priority, fallback = 'NORMAL') {
  const value = String(priority || fallback).toUpperCase()
  return ['LOW', 'NORMAL', 'HIGH', 'URGENT'].includes(value) ? value : fallback
}

async function loadRoutingContext(routing) {
  if (routing.sourceType === 'DOCUMENT') {
    const document = await prisma.document.findUnique({
      where: { id: parseInt(routing.sourceId, 10) },
      include: { uploader: { select: { id: true, name: true, role: true } } },
    })
    return { ...routing, source: document }
  }

  if (routing.sourceType === 'REGISTRY_ENTRY') {
    const record = await prisma.registryEntry.findUnique({
      where: { id: parseInt(routing.sourceId, 10) },
      include: {
        handledBy: { select: { id: true, name: true, role: true } },
        annotations: {
          include: { author: { select: { id: true, name: true, role: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    })
    return { ...routing, source: record }
  }

  if (routing.sourceType === 'PROCUREMENT_REQUEST') {
    const request = await prisma.procurementRequest.findUnique({
      where: { id: parseInt(routing.sourceId, 10) },
      include: {
        requestedBy: { select: { id: true, name: true, role: true, department: true } },
        approvedBy: { select: { id: true, name: true, role: true } },
      },
    })
    return { ...routing, source: request }
  }

  return { ...routing, source: null }
}

function normalizeRecipients(input) {
  if (Array.isArray(input)) return input
  if (input?.recipients && Array.isArray(input.recipients)) return input.recipients
  return []
}

function uniqueByEmail(users) {
  const seen = new Set()
  const uniqueUsers = []

  for (const user of users) {
    const key = String(user.email).toLowerCase().trim()
    if (seen.has(key)) continue
    seen.add(key)
    uniqueUsers.push(user)
  }

  return uniqueUsers
}

// GET /api/pa/inbox — pre-dates GM gatekeeping (Directive 1/2): items headed
// to the GM now carry currentHolderRole GM_PERSONAL_ASSISTANT, not
// GENERAL_MANAGER, so this query has to match /circulation/pa-gateway's
// "toGM" filter rather than the literal GM role, or it would silently start
// returning nothing the moment gatekeeping shipped. Kept alongside the newer
// /circulation/pa-gateway endpoint (which also returns "fromGM") since
// PADashboard's stat card already depends on this exact response shape.
router.get('/inbox', authenticate, authorize(['GM_PERSONAL_ASSISTANT']), async (req, res) => {
  try {
    const circulations = await prisma.documentCirculation.findMany({
      where: {
        currentHolderRole: 'GM_PERSONAL_ASSISTANT',
        status: 'IN_CIRCULATION'
      },
      include: {
        originator: { select: { id: true, name: true, email: true } },
        steps: {
          orderBy: { stepNumber: 'asc' },
          include: {
            fromUser: { select: { id: true, name: true, email: true } }
          }
        }
      },
      orderBy: { updatedAt: 'desc' },
    })

    const toGM = circulations.filter((c) => {
      const latest = c.steps[c.steps.length - 1]
      return latest?.toRole === 'GENERAL_MANAGER'
    })

    return success(res, toGM)
  } catch (err) {
    return serverError(res, err)
  }
})

// PUT /api/pa/inbox/:id/forward
router.put('/inbox/:id/forward', authenticate, authorize(['GM_PERSONAL_ASSISTANT']), async (req, res) => {
  try {
    const { id } = req.params
    const { toRole, instruction, paNote, decision, amount } = req.body

    const existingCirculation = await prisma.documentCirculation.findUnique({
      where: { id },
      include: {
        steps: {
          orderBy: { stepNumber: 'desc' },
          take: 1
        }
      }
    })

    if (!existingCirculation) return notFound(res, 'Circulation not found')

    if (existingCirculation.currentHolderRole !== 'GM_PERSONAL_ASSISTANT') {
      return error(res, 'Circulation is not currently gatekept with the PA', 403)
    }

    const nextStepNumber = existingCirculation.steps.length > 0 ? existingCirculation.steps[0].stepNumber + 1 : 1
    const note = instruction || paNote || ''

    const result = await prisma.$transaction(async (tx) => {
      await tx.documentCirculation.update({
        where: { id },
        data: {
          // toRole directly, not resolveHeldByRole(...) — this IS the PA's
          // deliberate act of triaging past the gate, same as /release, so
          // it must not immediately re-gatekeep itself back to the PA.
          currentHolderRole: toRole,
          status: 'IN_CIRCULATION'
        }
      })

      return await tx.circulationStep.create({
        data: {
          circulationId: id,
          stepNumber: nextStepNumber,
          fromUserId: req.user.id,
          fromRole: 'GENERAL_MANAGER', // PA acting on behalf of GM
          toRole,
          heldByRole: toRole,
          instruction: note,
          stepType: 'FORWARD',
          decision,
          amount: amount ? Number(amount) : null,
          recordsCopies: {
            create: {
              status: 'PENDING_FILING'
            }
          }
        },
        include: {
          recordsCopies: true
        }
      })
    })

    await logAudit({
      userId: req.user.id,
      action: 'PA_TRIAGED_DOCUMENT',
      module: 'PA Inbox',
      description: `Triaged ${existingCirculation.sourceType || 'Document'} ${existingCirculation.sourceId || existingCirculation.id} on behalf of GM${note ? ` — Note: ${note}` : ''}`,
      ipAddress: req.ip,
    })

    return success(res, result, 'Circulation forwarded successfully on behalf of GM')
  } catch (err) {
    return serverError(res, err)
  }
})

// POST /api/pa/communications
router.post('/communications', authenticate, authorize(['GM_PERSONAL_ASSISTANT']), async (req, res) => {
  try {
    const { subject, bodyHtml, userIds, department, sentByPA = true } = req.body

    if (!subject || !bodyHtml) {
      return error(res, 'Subject and bodyHtml are required')
    }

    const recipients = []
    const requestedRecipients = normalizeRecipients(req.body)

    if (requestedRecipients.length > 0) {
      for (const recipient of requestedRecipients) {
        if (recipient?.type === 'USER' && recipient.id) {
          recipients.push({ kind: 'USER', id: parseInt(recipient.id, 10) })
        } else if (recipient?.type === 'DEPARTMENT' && recipient.department) {
          recipients.push({ kind: 'DEPARTMENT', department: String(recipient.department) })
        }
      }
    } else if (Array.isArray(userIds) && userIds.length > 0) {
      for (const userId of userIds) {
        recipients.push({ kind: 'USER', id: parseInt(userId, 10) })
      }
    } else if (department) {
      recipients.push({ kind: 'DEPARTMENT', department: String(department) })
    }

    if (recipients.length === 0) {
      return error(res, 'Provide recipient userIds, a department, or a recipients array')
    }

    const resolvedUsers = []

    for (const recipient of recipients) {
      if (recipient.kind === 'USER') {
        const user = await prisma.user.findUnique({
          where: { id: recipient.id },
          select: { id: true, name: true, email: true, role: true, department: true, isActive: true },
        })

        if (user && user.isActive) {
          resolvedUsers.push(user)
        }
      }

      if (recipient.kind === 'DEPARTMENT') {
        const users = await prisma.user.findMany({
          where: { department: recipient.department, isActive: true },
          select: { id: true, name: true, email: true, role: true, department: true, isActive: true },
        })

        resolvedUsers.push(...users)
      }
    }

    const uniqueRecipients = uniqueByEmail(resolvedUsers)

    if (uniqueRecipients.length === 0) {
      return error(res, 'No active recipients found')
    }

    const deliveryResults = []
    for (const recipient of uniqueRecipients) {
      await sendGMCommunication({
        to: recipient.email,
        subject: String(subject).trim(),
        bodyHtml: String(bodyHtml),
        sentByPA: sentByPA !== false,
        paName: req.user.name,
      })

      deliveryResults.push({
        id: recipient.id,
        name: recipient.name,
        email: recipient.email,
        department: recipient.department,
      })
    }

    await logAudit({
      userId: req.user.id,
      action: 'PA_SENT_GM_COMMUNICATION',
      module: 'PA Communications',
      description: `PA sent GM communication "${String(subject).trim()}" to ${JSON.stringify(deliveryResults)}`,
      ipAddress: req.ip,
    })

    return success(res, { sent: deliveryResults.length, recipients: deliveryResults }, 'Communication sent successfully', 201)
  } catch (err) {
    return serverError(res, err)
  }
})

export default router