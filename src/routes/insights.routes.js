import { Router } from 'express'
import { prisma } from '../lib/prisma.js'
import { success, notFound, serverError } from '../lib/response.js'
import { authenticate } from '../middleware/auth.js'

const router = Router()

// GET /api/insights — this user's AgentInsights, unseen first, most recent
// within each group first. Dismissed ones are never returned — once
// dismissed, gone for good (per the frontend's "never re-show a dismissed
// one" rule, enforced here so it holds even if the frontend list is stale).
router.get('/', authenticate, async (req, res) => {
  try {
    const insights = await prisma.agentInsight.findMany({
      where: { userId: req.user.id, dismissedAt: null },
      orderBy: [{ seenAt: 'asc' }, { createdAt: 'desc' }],
    })
    return success(res, insights)
  } catch (err) {
    return serverError(res, err)
  }
})

// PUT /api/insights/:id/seen — mark one insight seen. Own insights only.
router.put('/:id/seen', authenticate, async (req, res) => {
  try {
    const insight = await prisma.agentInsight.findUnique({ where: { id: req.params.id } })
    if (!insight || insight.userId !== req.user.id) return notFound(res, 'Insight not found')

    const updated = await prisma.agentInsight.update({
      where: { id: req.params.id },
      data: { seenAt: insight.seenAt || new Date() },
    })
    return success(res, updated, 'Marked as seen')
  } catch (err) {
    return serverError(res, err)
  }
})

// PUT /api/insights/:id/dismiss — dismiss one insight for good. Own
// insights only.
router.put('/:id/dismiss', authenticate, async (req, res) => {
  try {
    const insight = await prisma.agentInsight.findUnique({ where: { id: req.params.id } })
    if (!insight || insight.userId !== req.user.id) return notFound(res, 'Insight not found')

    const updated = await prisma.agentInsight.update({
      where: { id: req.params.id },
      data: { dismissedAt: new Date() },
    })
    return success(res, updated, 'Dismissed')
  } catch (err) {
    return serverError(res, err)
  }
})

export default router
