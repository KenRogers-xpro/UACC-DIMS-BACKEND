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

    // queryId (-> UnansweredQuery) and sourceId (-> whichever model
    // sourceType names) are plain string FKs, not Prisma relations — no
    // relation field was ever declared between AgentInsight and
    // UnansweredQuery/Document. Batch-fetch both rather than adding a
    // schema relation for what's only needed by "Ask AI about this"'s
    // pre-seeded message ([Document #N] "title" needs the real title,
    // and the message needs the original question text).
    const queryIds = [...new Set(insights.map((i) => i.queryId).filter(Boolean))]
    const documentIds = [...new Set(
      insights
        .filter((i) => i.sourceType === 'DOCUMENT')
        .map((i) => parseInt(i.sourceId, 10))
        .filter(Number.isInteger)
    )]

    const [queries, documents] = await Promise.all([
      queryIds.length > 0
        ? prisma.unansweredQuery.findMany({ where: { id: { in: queryIds } }, select: { id: true, queryText: true } })
        : [],
      documentIds.length > 0
        ? prisma.document.findMany({ where: { id: { in: documentIds } }, select: { id: true, title: true } })
        : [],
    ])

    const queryTextById = new Map(queries.map((q) => [q.id, q.queryText]))
    const documentTitleById = new Map(documents.map((d) => [d.id, d.title]))

    const enriched = insights.map((i) => ({
      ...i,
      queryText: i.queryId ? (queryTextById.get(i.queryId) || null) : null,
      documentTitle: i.sourceType === 'DOCUMENT' ? (documentTitleById.get(parseInt(i.sourceId, 10)) || null) : null,
    }))

    return success(res, enriched)
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
