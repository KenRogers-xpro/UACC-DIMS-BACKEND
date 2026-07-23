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

  // Archived (bulk-ingested reference material — see records.routes.js
  // POST /bulk-ingest) never has a circulation, so the "touched it" rule
  // below can't ever apply to it. Gated on department match instead, same
  // department field every other document already carries — not
  // confidentiality-tiered yet, that was deliberately deferred.
  if (document.status === 'ARCHIVED') return document.department === user.department

  const touchedIt = await prisma.documentCirculation.findFirst({
    where: {
      sourceType: 'DOCUMENT',
      sourceId: String(document.id),
      steps: { some: { OR: [{ fromRole: user.role }, { toRole: user.role }, { ccRoles: { has: user.role } }] } },
    },
    select: { id: true },
  })
  if (touchedIt) return true

  // Annotation CC grants visibility the same way circulation CC does — a
  // role named here has been informed about the document even if it never
  // touched the circulation itself.
  const ccdViaAnnotation = await prisma.annotation.findFirst({
    where: { documentId: document.id, ccRoles: { has: user.role } },
    select: { id: true },
  })
  return Boolean(ccdViaAnnotation)
}
