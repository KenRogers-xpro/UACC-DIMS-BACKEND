-- Lets a circulation records copy be filed directly into a RecordsFile
-- dossier from the Filing Queue, same picker as the register modal.
ALTER TABLE "CirculationRecordsCopy" ADD COLUMN "recordsFileId" TEXT;

ALTER TABLE "CirculationRecordsCopy" ADD CONSTRAINT "CirculationRecordsCopy_recordsFileId_fkey" FOREIGN KEY ("recordsFileId") REFERENCES "RecordsFile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
