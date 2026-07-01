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

// GET /api/pa/inbox
router.get('/inbox', authenticate, authorize(['GM_PERSONAL_ASSISTANT']), async (req, res) => {
  try {
    const routings = await prisma.documentRouting.findMany({
      where: { status: 'PENDING_TRIAGE' },
      orderBy: { createdAt: 'asc' },
    })

    const inbox = await Promise.all(routings.map(loadRoutingContext))

    return success(res, inbox)
  } catch (err) {
    return serverError(res, err)
  }
})

// PUT /api/pa/inbox/:id/forward
router.put('/inbox/:id/forward', authenticate, authorize(['GM_PERSONAL_ASSISTANT']), async (req, res) => {
  try {
    const routing = await prisma.documentRouting.findUnique({
      where: { id: req.params.id },
    })

    if (!routing) return notFound(res, 'Routing record not found')

    if (routing.status !== 'PENDING_TRIAGE') {
      return error(res, 'Routing record is no longer pending triage', 409)
    }

    const paNote = req.body.paNote ? String(req.body.paNote).trim() : null
    const priority = normalizePriority(req.body.priority, routing.priority)

    const updated = await prisma.documentRouting.update({
      where: { id: req.params.id },
      data: {
        paNote,
        priority,
        status: 'FORWARDED',
        forwardedAt: new Date(),
        triagedById: req.user.id,
      },
    })

    await logAudit({
      userId: req.user.id,
      action: 'PA_TRIAGED_DOCUMENT',
      module: 'PA Inbox',
      description: `Triaged ${routing.sourceType} ${routing.sourceId}${paNote ? ` — Note: ${paNote}` : ''}${priority ? ` — Priority: ${priority}` : ''}`,
      ipAddress: req.ip,
    })

    return success(res, updated, 'Routing forwarded successfully')
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