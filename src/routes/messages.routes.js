import { Router } from 'express'
import { prisma } from '../lib/prisma.js'
import { logAudit } from '../lib/audit.js'
import { success, error, notFound, serverError } from '../lib/response.js'
import { authenticate } from '../middleware/auth.js'

const router = Router()

// GET /api/messages/directory — everyone you can start a conversation with.
// Messaging is an internal, all-roles tool (unlike GET /api/users, which is
// IT Admin-only user management), so this is deliberately open to anyone
// authenticated.
router.get('/directory', authenticate, async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      where: { isActive: true, id: { not: req.user.id } },
      select: { id: true, name: true, role: true, department: true },
      orderBy: { name: 'asc' },
    })
    return success(res, users)
  } catch (err) {
    return serverError(res, err)
  }
})

// GET /api/messages/conversations — one row per person you've messaged with,
// most recent first, with the last message preview and unread count.
router.get('/conversations', authenticate, async (req, res) => {
  try {
    const userId = req.user.id
    const messages = await prisma.directMessage.findMany({
      where: { OR: [{ senderId: userId }, { recipientId: userId }] },
      orderBy: { createdAt: 'desc' },
      include: {
        sender: { select: { id: true, name: true, role: true } },
        recipient: { select: { id: true, name: true, role: true } },
      },
    })

    const byPartner = new Map()
    for (const m of messages) {
      const partner = m.senderId === userId ? m.recipient : m.sender
      if (!byPartner.has(partner.id)) {
        byPartner.set(partner.id, { partner, lastMessage: m, unreadCount: 0 })
      }
      if (m.recipientId === userId && !m.readAt) {
        byPartner.get(partner.id).unreadCount += 1
      }
    }

    return success(res, Array.from(byPartner.values()))
  } catch (err) {
    return serverError(res, err)
  }
})

// GET /api/messages/thread/:userId — full message history with one person
router.get('/thread/:userId', authenticate, async (req, res) => {
  try {
    const otherId = parseInt(req.params.userId)
    const otherUser = await prisma.user.findUnique({
      where: { id: otherId },
      select: { id: true, name: true, role: true },
    })
    if (!otherUser) return notFound(res, 'User not found')

    const thread = await prisma.directMessage.findMany({
      where: {
        OR: [
          { senderId: req.user.id, recipientId: otherId },
          { senderId: otherId, recipientId: req.user.id },
        ],
      },
      orderBy: { createdAt: 'asc' },
    })

    return success(res, { otherUser, messages: thread })
  } catch (err) {
    return serverError(res, err)
  }
})

// POST /api/messages — send a message
router.post('/', authenticate, async (req, res) => {
  try {
    const { recipientId, content } = req.body
    if (!recipientId || !content || !String(content).trim()) {
      return error(res, 'recipientId and content are required')
    }
    const recipient = await prisma.user.findUnique({ where: { id: parseInt(recipientId) } })
    if (!recipient) return notFound(res, 'Recipient not found')

    const message = await prisma.directMessage.create({
      data: {
        senderId: req.user.id,
        recipientId: parseInt(recipientId),
        content: String(content).trim(),
      },
    })

    await logAudit({
      userId:      req.user.id,
      action:      'MESSAGE_SENT',
      module:      'Communications',
      description: `Sent a message to ${recipient.name}`,
      ipAddress:   req.ip,
    })

    return success(res, message, 'Message sent', 201)
  } catch (err) {
    return serverError(res, err)
  }
})

// PATCH /api/messages/thread/:userId/read — mark everything that user sent
// you as read
router.patch('/thread/:userId/read', authenticate, async (req, res) => {
  try {
    const otherId = parseInt(req.params.userId)
    await prisma.directMessage.updateMany({
      where: { senderId: otherId, recipientId: req.user.id, readAt: null },
      data: { readAt: new Date() },
    })
    return success(res, null, 'Marked as read')
  } catch (err) {
    return serverError(res, err)
  }
})

export default router
