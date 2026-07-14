-- Another pre-existing drift instance found live while verifying: schema.prisma
-- declared Annotation.type and Annotation.documentId, but no migration ever
-- created them. This was silently breaking GET /api/records (which includes
-- annotations) and would have broken the new POST/GET
-- /api/documents/:id/annotations endpoints on first use.
ALTER TABLE "annotations"
  ADD COLUMN "type" TEXT NOT NULL DEFAULT 'COMMENT',
  ADD COLUMN "documentId" INTEGER;

ALTER TABLE "annotations"
  ADD CONSTRAINT "annotations_documentId_fkey"
  FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
