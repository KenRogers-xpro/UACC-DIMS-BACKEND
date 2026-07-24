-- Lets an ARCHIVED (bulk-ingested) Document be filed into a RecordsFile
-- dossier, same as a RegistryEntry or a CirculationRecordsCopy already can.
-- recordsFileId is TEXT (matching RecordsFile.id, a String cuid) — the
-- directive's own draft specified Int, which would have mismatched
-- RecordsFile's actual id type; caught during schema.prisma review before
-- writing this migration, not after.
--
-- Hand-written and applied via `prisma migrate deploy` rather than
-- `migrate dev` — same pre-existing, unrelated shadow-db migration-history
-- issue as the last two schema changes in this project.

ALTER TABLE "documents" ADD COLUMN "recordsFileId" TEXT;

ALTER TABLE "documents" ADD CONSTRAINT "documents_recordsFileId_fkey" FOREIGN KEY ("recordsFileId") REFERENCES "RecordsFile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
