-- Pre-existing drift fix: schema.prisma declared confidentiality, recordsFileId,
-- retentionPeriodMonths, retentionExpiresAt on RegistryEntry, but no migration
-- ever created them (nor the DocConfidentiality enum type). This was silently
-- breaking POST /api/records (registry entry creation) for every call, since
-- Prisma's default SELECT-all on create()/findFirst() includes these columns.
--
-- recordsFileId is added WITHOUT a foreign key: the RecordsFile table itself
-- was never migrated either and building it out is unrelated to this change —
-- nothing currently queries the recordsFile relation, so this doesn't newly
-- break anything that worked before.

-- CreateEnum
CREATE TYPE "DocConfidentiality" AS ENUM ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED');

-- AlterTable
ALTER TABLE "registry_entries"
  ADD COLUMN "confidentiality" "DocConfidentiality" NOT NULL DEFAULT 'INTERNAL',
  ADD COLUMN "recordsFileId" TEXT,
  ADD COLUMN "retentionPeriodMonths" INTEGER,
  ADD COLUMN "retentionExpiresAt" TIMESTAMP(3),
  ADD COLUMN "sourceDocumentId" INTEGER;

-- AddForeignKey (bridge to Document — this table exists, so the FK is real)
ALTER TABLE "registry_entries"
  ADD CONSTRAINT "registry_entries_sourceDocumentId_fkey"
  FOREIGN KEY ("sourceDocumentId") REFERENCES "documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
