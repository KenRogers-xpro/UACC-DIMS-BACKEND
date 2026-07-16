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
// Deleted messages are excluded here (this is a list/preview context) —
// they still exist in the actual thread as a placeholder, just not as
// someone's conversation preview text. Conversations this user hid (see
// DELETE /conversations/:userId) are dropped too, UNLESS the last message
// is newer than when they hid it — new activity un-hides a conversation
// rather than silently swallowing it forever.
router.get('/conversations', authenticate, async (req, res) => {
  try {
    const userId = req.user.id
    const [messages, hiddenRows] = await Promise.all([
      prisma.directMessage.findMany({
        where: { OR: [{ senderId: userId }, { recipientId: userId }], deletedAt: null },
        orderBy: { createdAt: 'desc' },
        include: {
          sender: { select: { id: true, name: true, role: true } },
          recipient: { select: { id: true, name: true, role: true } },
        },
      }),
      prisma.hiddenConversation.findMany({ where: { userId } }),
    ])

    const hiddenAtByPartner = new Map(hiddenRows.map((h) => [h.otherUserId, h.hiddenAt]))

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

    const visible = Array.from(byPartner.values()).filter(({ partner, lastMessage }) => {
      const hiddenAt = hiddenAtByPartner.get(partner.id)
      return !hiddenAt || new Date(lastMessage.createdAt) > new Date(hiddenAt)
    })

    return success(res, visible)
  } catch (err) {
    return serverError(res, err)
  }
})

// DELETE /api/messages/conversations/:userId — hide this conversation from
// the requesting user's own list. The other party's copy is untouched —
// hard-deleting DirectMessage rows here would erase their side too, which
// is exactly what the soft-delete posture on individual messages already
// avoids.
router.delete('/conversations/:userId', authenticate, async (req, res) => {
  try {
    const otherUserId = parseInt(req.params.userId, 10)
    await prisma.hiddenConversation.upsert({
      where: { userId_otherUserId: { userId: req.user.id, otherUserId } },
      update: { hiddenAt: new Date() },
      create: { userId: req.user.id, otherUserId, hiddenAt: new Date() },
    })
    return success(res, null, 'Conversation hidden')
  } catch (err) {
    return serverError(res, err)
  }
})

// GET /api/messages/thread/:userId — full message history with one person.
// Deleted messages stay in the timeline (as a placeholder) rather than
// vanishing, so the other party doesn't lose conversation context — but
// their real content is redacted server-side before it ever leaves here.
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

    const messages = thread.map((m) => (m.deletedAt ? { ...m, content: null } : m))

    return success(res, { otherUser, messages })
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

// PUT /api/messages/:id — edit a message's content. Sender only, and only
// while it hasn't been deleted.
router.put('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params
    const { content } = req.body
    if (!content || !String(content).trim()) return error(res, 'Content is required')

    const message = await prisma.directMessage.findUnique({ where: { id } })
    if (!message || message.deletedAt) return notFound(res, 'Message not found')
    if (message.senderId !== req.user.id) return error(res, 'You can only edit your own messages', 403)

    const updated = await prisma.directMessage.update({
      where: { id },
      data: { content: String(content).trim(), editedAt: new Date() },
    })

    return success(res, updated, 'Message updated')
  } catch (err) {
    return serverError(res, err)
  }
})

// DELETE /api/messages/:id — soft delete only, sender only. The row (and a
// "deleted" marker) stays in the thread — see GET /thread/:userId.
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params
    const message = await prisma.directMessage.findUnique({ where: { id } })
    if (!message || message.deletedAt) return notFound(res, 'Message not found')
    if (message.senderId !== req.user.id) return error(res, 'You can only delete your own messages', 403)

    await prisma.directMessage.update({ where: { id }, data: { deletedAt: new Date() } })

    return success(res, null, 'Message deleted')
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
