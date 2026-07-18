import { prisma } from './prisma.js'

export const NEW_ARRIVAL_WINDOW_MS = 48 * 60 * 60 * 1000

// Shared by documents.routes.js's buildStateFilter (state=NEW/PENDING) and
// circulation.routes.js's GET /inbox (the New Arrivals tab's awaiting-action
// panel) — both need the exact same "recent AND not yet viewed" definition
// of a new arrival, or they can silently drift apart (one shows an item the
// other has already dismissed).
export async function computeNewArrivalIds(userId, circulations) {
  const readRows = await prisma.notificationRead.findMany({
    where: { userId, sourceType: 'NEW_ARRIVAL', sourceId: { in: circulations.map((c) => c.id) } },
    select: { sourceId: true },
  })
  const viewedSet = new Set(readRows.map((r) => r.sourceId))
  const now = Date.now()
  return new Set(
    circulations
      .filter((c) => (now - new Date(c.updatedAt).getTime()) < NEW_ARRIVAL_WINDOW_MS && !viewedSet.has(c.id))
      .map((c) => c.id)
  )
}
