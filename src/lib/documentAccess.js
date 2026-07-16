import { prisma } from './prisma.js'

// Shared visibility check — mirrors GET /documents/:id's rule exactly, so
// nothing (annotations, signatures, circulation, AI insights) can leak a
// document to someone who couldn't otherwise see it. Broken out into its
// own module (rather than living in documents.routes.js) so lib/insights.js
// can import it without creating a documents.routes.js <-> lib/embeddings.js
// <-> lib/insights.js circular import.
export async function canViewDocument(document, user) {
  const hasBroadAccess = ['RECORDS_EXECUTIVE', 'GENERAL_MANAGER'].includes(user.role)
  if (hasBroadAccess || document.uploadedBy === user.id) return true
  if (document.status === 'PRIVATE') return false

  const touchedIt = await prisma.documentCirculation.findFirst({
    where: {
      sourceType: 'DOCUMENT',
      sourceId: String(document.id),
      steps: { some: { OR: [{ fromRole: user.role }, { toRole: user.role }] } },
    },
    select: { id: true },
  })
  return Boolean(touchedIt)
}
