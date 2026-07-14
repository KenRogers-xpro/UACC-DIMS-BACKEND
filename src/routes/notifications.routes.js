import { Router } from 'express'
import { prisma } from '../lib/prisma.js'
import { success, serverError } from '../lib/response.js'
import { authenticate } from '../middleware/auth.js'

const router = Router()

const ANNOUNCEMENT_WINDOW_MS = 72 * 60 * 60 * 1000
const RECENT_ITEMS_LIMIT = 8

// GET /api/notifications — combined unread count + recent items across the
// circulation inbox, direct messages, and announcements for the bell icon.
// Announcements have no per-user read tracking, so "recent" substitutes for
// "unseen" via a fixed lookback window — user.lastSeenAt can't be used here
// since it's refreshed on every authenticated request (see
// middleware/auth.js), not a per-feature "last checked" cursor.
router.get('/', authenticate, async (req, res) => {
  try {
    const since = new Date(Date.now() - ANNOUNCEMENT_WINDOW_MS)

    const [inboxItems, unreadMessages, recentAnnouncements, inboxCount, unreadMessageCount] = await Promise.all([
      prisma.documentCirculation.findMany({
        where: { currentHolderRole: req.user.role, status: 'IN_CIRCULATION' },
        select: { id: true, title: true, updatedAt: true, originator: { select: { name: true } } },
        orderBy: { updatedAt: 'desc' },
        take: RECENT_ITEMS_LIMIT,
      }),
      prisma.directMessage.findMany({
        where: { recipientId: req.user.id, readAt: null },
        select: { id: true, content: true, createdAt: true, sender: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'desc' },
        take: RECENT_ITEMS_LIMIT,
      }),
      prisma.announcement.findMany({
        where: { createdAt: { gte: since } },
        select: { id: true, title: true, createdAt: true, author: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
        take: RECENT_ITEMS_LIMIT,
      }),
      prisma.documentCirculation.count({
        where: { currentHolderRole: req.user.role, status: 'IN_CIRCULATION' },
      }),
      prisma.directMessage.count({
        where: { recipientId: req.user.id, readAt: null },
      }),
    ])

    const items = [
      ...inboxItems.map((c) => ({
        type: 'CIRCULATION',
        id: c.id,
        title: c.title,
        subtitle: `From ${c.originator?.name || 'Unknown'} — awaiting your action`,
        createdAt: c.updatedAt,
        link: '/dashboard/documents?tab=pending',
      })),
      ...unreadMessages.map((m) => ({
        type: 'MESSAGE',
        id: m.id,
        title: m.sender?.name || 'Unknown',
        subtitle: m.content,
        createdAt: m.createdAt,
        link: `/dashboard/messages?thread=${m.sender?.id}`,
      })),
      ...recentAnnouncements.map((a) => ({
        type: 'ANNOUNCEMENT',
        id: a.id,
        title: a.title,
        subtitle: `Posted by ${a.author?.name || 'Unknown'}`,
        createdAt: a.createdAt,
        link: '/dashboard/announcements',
      })),
    ]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, RECENT_ITEMS_LIMIT)

    return success(res, {
      unreadCount: inboxCount + unreadMessageCount + recentAnnouncements.length,
      items,
    })
  } catch (err) {
    return serverError(res, err)
  }
})

export default router
