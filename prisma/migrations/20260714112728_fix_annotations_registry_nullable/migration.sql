-- registryEntryId predates the polymorphic registry-or-document design
-- (schema.prisma comment: "exactly one of registryEntryId / documentId is
-- set") and still had its original NOT NULL constraint live, so any
-- document-only annotation (documentId set, registryEntryId null) failed
-- with a P2011 null constraint violation. Found live while verifying the
-- new /api/documents/:id/annotations endpoints.
ALTER TABLE "annotations" ALTER COLUMN "registryEntryId" DROP NOT NULL;
