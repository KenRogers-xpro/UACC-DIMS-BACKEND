import { Router } from 'express'
import { prisma } from '../lib/prisma.js'
import { success, error, serverError } from '../lib/response.js'
import { authenticate } from '../middleware/auth.js'

const router = Router()

const RECENT_ITEMS_LIMIT = 8
const VALID_SOURCE_TYPES = ['CIRCULATION_STEP', 'MESSAGE', 'ANNOUNCEMENT']

// GET /api/notifications — real read-tracking, split into "incoming" (landing
// on you: awaiting your action, messages you received, announcements you
// haven't opened) and "outgoing" (circulation you sent/forwarded that's now
// moved on — with someone else, or closed — so you can see what happened to
// it). Messages keep using DirectMessage.readAt, which already tracks
// per-message read state correctly; circulation steps and announcements have
// no native read state of their own, so they go through NotificationRead.
router.get('/', authenticate, async (req, res) => {
  try {
    const userId = req.user.id
    const userRole = req.user.role

    const [incomingCirc, outgoingCirc, unreadMessages, announcements, readRows] = await Promise.all([
      prisma.documentCirculation.findMany({
        where: { currentHolderRole: userRole, status: 'IN_CIRCULATION' },
        include: {
          originator: { select: { id: true, name: true } },
          steps: { orderBy: { stepNumber: 'desc' }, take: 1 },
        },
        orderBy: { updatedAt: 'desc' },
        take: RECENT_ITEMS_LIMIT * 2,
      }),
      prisma.documentCirculation.findMany({
        where: {
          steps: { some: { fromUserId: userId } },
          currentHolderRole: { not: userRole },
        },
        include: {
          steps: { orderBy: { stepNumber: 'desc' }, take: 1 },
        },
        orderBy: { updatedAt: 'desc' },
        take: RECENT_ITEMS_LIMIT * 2,
      }),
      prisma.directMessage.findMany({
        where: { recipientId: userId, readAt: null },
        select: { id: true, content: true, createdAt: true, sender: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'desc' },
        take: RECENT_ITEMS_LIMIT,
      }),
      prisma.announcement.findMany({
        select: { id: true, title: true, createdAt: true, author: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
        take: RECENT_ITEMS_LIMIT * 2,
      }),
      prisma.notificationRead.findMany({
        where: { userId },
        select: { sourceType: true, sourceId: true },
      }),
    ])

    const readSet = new Set(readRows.map((r) => `${r.sourceType}:${r.sourceId}`))
    const isRead = (sourceType, sourceId) => readSet.has(`${sourceType}:${String(sourceId)}`)

    const incoming = []
    const outgoing = []

    for (const c of incomingCirc) {
      const latest = c.steps[0]
      if (!latest || isRead('CIRCULATION_STEP', latest.id)) continue
      incoming.push({
        type: 'CIRCULATION',
        id: c.id,
        sourceId: latest.id,
        title: c.title,
        subtitle: `From ${c.originator?.name || 'Unknown'} — awaiting your action`,
        createdAt: latest.signedAt || c.updatedAt,
        link: '/dashboard/documents?tab=pending',
      })
    }

    for (const c of outgoingCirc) {
      const latest = c.steps[0]
      if (!latest || isRead('CIRCULATION_STEP', latest.id)) continue
      outgoing.push({
        type: 'CIRCULATION',
        id: c.id,
        sourceId: latest.id,
        title: c.title,
        subtitle: c.status === 'CLOSED'
          ? 'Closed — final decision recorded'
          : `Now with ${latest.toRole.replace(/_/g, ' ')}`,
        createdAt: latest.signedAt || c.updatedAt,
        link: '/dashboard/documents?tab=circulating',
      })
    }

    for (const m of unreadMessages) {
      incoming.push({
        type: 'MESSAGE',
        id: m.id,
        sourceId: m.id,
        title: m.sender?.name || 'Unknown',
        subtitle: m.content,
        createdAt: m.createdAt,
        link: `/dashboard/messages?thread=${m.sender?.id}`,
      })
    }

    for (const a of announcements) {
      if (isRead('ANNOUNCEMENT', a.id)) continue
      incoming.push({
        type: 'ANNOUNCEMENT',
        id: a.id,
        sourceId: a.id,
        title: a.title,
        subtitle: `Posted by ${a.author?.name || 'Unknown'}`,
        createdAt: a.createdAt,
        link: '/dashboard/announcements',
      })
    }

    incoming.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    outgoing.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))

    const incomingTrimmed = incoming.slice(0, RECENT_ITEMS_LIMIT)
    const outgoingTrimmed = outgoing.slice(0, RECENT_ITEMS_LIMIT)

    return success(res, {
      unreadCount: incomingTrimmed.length + outgoingTrimmed.length,
      incoming: incomingTrimmed,
      outgoing: outgoingTrimmed,
    })
  } catch (err) {
    return serverError(res, err)
  }
})

// POST /api/notifications/:sourceType/:sourceId/read — marks a single
// notification-worthy item as seen for the current user. Called when the
// user actually opens/views the linked item (a circulation in
// DocumentViewerModal, an announcement on its page) — never on hover, since
// that would mark things read before the user has seen the content.
router.post('/:sourceType/:sourceId/read', authenticate, async (req, res) => {
  try {
    const { sourceType, sourceId } = req.params
    if (!VALID_SOURCE_TYPES.includes(sourceType)) {
      return error(res, 'Invalid sourceType')
    }

    await prisma.notificationRead.upsert({
      where: { userId_sourceType_sourceId: { userId: req.user.id, sourceType, sourceId } },
      update: {},
      create: { userId: req.user.id, sourceType, sourceId },
    })

    return success(res, null, 'Marked as read')
  } catch (err) {
    return serverError(res, err)
  }
})

export default router
