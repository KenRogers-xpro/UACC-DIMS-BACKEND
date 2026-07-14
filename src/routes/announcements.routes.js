import { Router } from 'express'
import { prisma } from '../lib/prisma.js'
import { logAudit } from '../lib/audit.js'
import { success, error, notFound, serverError } from '../lib/response.js'
import { authenticate } from '../middleware/auth.js'

const router = Router()

// GET /api/announcements — company-wide, visible to every role. Pinned
// first, then most recent.
router.get('/', authenticate, async (req, res) => {
  try {
    const announcements = await prisma.announcement.findMany({
      include: { author: { select: { id: true, name: true, role: true } } },
      orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
    })
    return success(res, announcements)
  } catch (err) {
    return serverError(res, err)
  }
})

// POST /api/announcements — any authenticated user can post one; the
// author-or-GM rule only governs deletion (see below).
router.post('/', authenticate, async (req, res) => {
  try {
    const { title, content, pinned = false } = req.body
    if (!title || !String(title).trim() || !content || !String(content).trim()) {
      return error(res, 'Title and content are required')
    }

    const announcement = await prisma.announcement.create({
      data: {
        authorId: req.user.id,
        title: String(title).trim(),
        content: String(content).trim(),
        pinned: Boolean(pinned),
      },
      include: { author: { select: { id: true, name: true, role: true } } },
    })

    await logAudit({
      userId:      req.user.id,
      action:      'ANNOUNCEMENT_CREATED',
      module:      'Communications',
      description: `Posted announcement: "${announcement.title}"`,
      ipAddress:   req.ip,
    })

    return success(res, announcement, 'Announcement posted', 201)
  } catch (err) {
    return serverError(res, err)
  }
})

// DELETE /api/announcements/:id — author or GENERAL_MANAGER only
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const announcement = await prisma.announcement.findUnique({ where: { id: req.params.id } })
    if (!announcement) return notFound(res, 'Announcement not found')

    if (announcement.authorId !== req.user.id && req.user.role !== 'GENERAL_MANAGER') {
      return error(res, 'Only the author or the General Manager can delete this announcement', 403)
    }

    await prisma.announcement.delete({ where: { id: req.params.id } })

    await logAudit({
      userId:      req.user.id,
      action:      'ANNOUNCEMENT_DELETED',
      module:      'Communications',
      description: `Deleted announcement: "${announcement.title}"`,
      ipAddress:   req.ip,
    })

    return success(res, null, 'Announcement deleted')
  } catch (err) {
    return serverError(res, err)
  }
})

export default router
