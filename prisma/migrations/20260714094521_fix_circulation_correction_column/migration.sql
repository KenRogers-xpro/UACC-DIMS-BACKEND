-- Pre-existing schema drift fix: schema.prisma already declared
-- DocumentCirculation.awaitingCorrectionFrom, but the migration that created
-- the table never included it, so the live database was missing the column
-- entirely — breaking GET /circulation/inbox and circulation creation.
-- AlterTable
ALTER TABLE "DocumentCirculation" ADD COLUMN     "awaitingCorrectionFrom" INTEGER;

-- AddForeignKey
ALTER TABLE "DocumentCirculation" ADD CONSTRAINT "DocumentCirculation_awaitingCorrectionFrom_fkey" FOREIGN KEY ("awaitingCorrectionFrom") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
