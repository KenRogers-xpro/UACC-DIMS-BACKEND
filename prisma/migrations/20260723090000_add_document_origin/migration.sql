-- Adds Document.origin (UPLOADED | BULK_INGESTED — documented string, same
-- pattern as DraftDocument.origin) for the Records Executive bulk-ingest
-- feature. status already allows arbitrary strings, so ARCHIVED needs no
-- column change — it's just a new value by convention (see the updated
-- inline comment in schema.prisma).
--
-- Hand-written and applied via `prisma migrate deploy` rather than
-- `migrate dev` — the shadow database `migrate dev` needs is still broken
-- by the same pre-existing, unrelated migration-history inconsistency noted
-- in migration 20260721120000_add_circulation_records_copy_link (two old
-- migrations both add DocumentCirculation.awaitingCorrectionFrom, one
-- non-idempotently). Not fixed here as part of this feature either.

ALTER TABLE "documents" ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'UPLOADED';
