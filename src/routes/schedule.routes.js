import { Router } from 'express'
import { prisma } from '../lib/prisma.js'
import { logAudit } from '../lib/audit.js'
import { success, error, notFound, serverError } from '../lib/response.js'
import { authenticate, authorize } from '../middleware/auth.js'

const router = Router()

function parseDate(value) {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function buildRangeFilter(query) {
  const rangeStart = parseDate(query.startDate || query.from)
  const rangeEnd = parseDate(query.endDate || query.to)

  if (!rangeStart && !rangeEnd) return {}

  if (rangeStart && rangeEnd) {
    return {
      AND: [
        { startTime: { lte: rangeEnd } },
        { endTime: { gte: rangeStart } },
      ],
    }
  }

  if (rangeStart) {
    return { endTime: { gte: rangeStart } }
  }

  return { startTime: { lte: rangeEnd } }
}

function normalizeStatus(status, fallback = 'CONFIRMED') {
  const value = String(status || fallback).toUpperCase()
  return ['CONFIRMED', 'TENTATIVE', 'CANCELLED'].includes(value) ? value : fallback
}

// GET /api/schedule
router.get(
  '/',
  authenticate,
  authorize(['GM_PERSONAL_ASSISTANT', 'GENERAL_MANAGER']),
  async (req, res) => {
    try {
      const { page = 1, limit = 20 } = req.query
      const where = buildRangeFilter(req.query)

      const [events, total] = await Promise.all([
        prisma.gMScheduleEvent.findMany({
          where,
          include: {
            createdBy: { select: { id: true, name: true, role: true } },
          },
          orderBy: { startTime: 'asc' },
          skip: (parseInt(page, 10) - 1) * parseInt(limit, 10),
          take: parseInt(limit, 10),
        }),
        prisma.gMScheduleEvent.count({ where }),
      ])

      return success(res, {
        events,
        pagination: {
          total,
          page: parseInt(page, 10),
          limit: parseInt(limit, 10),
          totalPages: Math.ceil(total / parseInt(limit, 10)),
        },
      })
    } catch (err) {
      return serverError(res, err)
    }
  }
)

// POST /api/schedule
router.post(
  '/',
  authenticate,
  authorize(['GM_PERSONAL_ASSISTANT', 'GENERAL_MANAGER']),
  async (req, res) => {
    try {
      const { title, description, startTime, endTime, location, status } = req.body

      if (!title || !startTime || !endTime) {
        return error(res, 'Title, start time and end time are required')
      }

      const start = parseDate(startTime)
      const end = parseDate(endTime)

      if (!start || !end) {
        return error(res, 'Start time and end time must be valid dates')
      }

      if (end <= start) {
        return error(res, 'End time must be after start time')
      }

      const event = await prisma.gMScheduleEvent.create({
        data: {
          title: String(title).trim(),
          description: description ? String(description).trim() : null,
          startTime: start,
          endTime: end,
          location: location ? String(location).trim() : null,
          createdById: req.user.id,
          status: normalizeStatus(status),
        },
        include: {
          createdBy: { select: { id: true, name: true, role: true } },
        },
      })

      await logAudit({
        userId: req.user.id,
        action: 'SCHEDULE_EVENT_CREATED',
        module: 'Schedule',
        description: `Created schedule event "${event.title}" createdById=${req.user.id}`,
        ipAddress: req.ip,
      })

      return success(res, event, 'Schedule event created successfully', 201)
    } catch (err) {
      return serverError(res, err)
    }
  }
)

// PUT /api/schedule/:id
router.put(
  '/:id',
  authenticate,
  authorize(['GM_PERSONAL_ASSISTANT', 'GENERAL_MANAGER']),
  async (req, res) => {
    try {
      const event = await prisma.gMScheduleEvent.findUnique({
        where: { id: req.params.id },
      })

      if (!event) return notFound(res, 'Schedule event not found')

      if (req.user.role === 'GENERAL_MANAGER' && event.createdById !== req.user.id) {
        return error(res, 'You can only edit events you created', 403)
      }

      const nextStart = req.body.startTime ? parseDate(req.body.startTime) : event.startTime
      const nextEnd = req.body.endTime ? parseDate(req.body.endTime) : event.endTime

      if ((req.body.startTime && !nextStart) || (req.body.endTime && !nextEnd)) {
        return error(res, 'Start time and end time must be valid dates')
      }

      if (nextEnd <= nextStart) {
        return error(res, 'End time must be after start time')
      }

      const updated = await prisma.gMScheduleEvent.update({
        where: { id: req.params.id },
        data: {
          title: req.body.title ? String(req.body.title).trim() : event.title,
          description: req.body.description !== undefined
            ? (req.body.description ? String(req.body.description).trim() : null)
            : event.description,
          startTime: nextStart,
          endTime: nextEnd,
          location: req.body.location !== undefined
            ? (req.body.location ? String(req.body.location).trim() : null)
            : event.location,
          status: req.body.status ? normalizeStatus(req.body.status, event.status) : event.status,
        },
        include: {
          createdBy: { select: { id: true, name: true, role: true } },
        },
      })

      await logAudit({
        userId: req.user.id,
        action: 'SCHEDULE_EVENT_UPDATED',
        module: 'Schedule',
        description: `Updated schedule event "${updated.title}" createdById=${req.user.id}`,
        ipAddress: req.ip,
      })

      return success(res, updated, 'Schedule event updated successfully')
    } catch (err) {
      return serverError(res, err)
    }
  }
)

// DELETE /api/schedule/:id
router.delete(
  '/:id',
  authenticate,
  authorize(['GM_PERSONAL_ASSISTANT', 'GENERAL_MANAGER']),
  async (req, res) => {
    try {
      const event = await prisma.gMScheduleEvent.findUnique({
        where: { id: req.params.id },
      })

      if (!event) return notFound(res, 'Schedule event not found')

      if (req.user.role === 'GENERAL_MANAGER' && event.createdById !== req.user.id) {
        return error(res, 'You can only cancel events you created', 403)
      }

      const cancelled = await prisma.gMScheduleEvent.update({
        where: { id: req.params.id },
        data: { status: 'CANCELLED' },
        include: {
          createdBy: { select: { id: true, name: true, role: true } },
        },
      })

      await logAudit({
        userId: req.user.id,
        action: 'SCHEDULE_EVENT_CANCELLED',
        module: 'Schedule',
        description: `Cancelled schedule event "${cancelled.title}" createdById=${req.user.id}`,
        ipAddress: req.ip,
      })

      return success(res, cancelled, 'Schedule event cancelled successfully')
    } catch (err) {
      return serverError(res, err)
    }
  }
)

export default router