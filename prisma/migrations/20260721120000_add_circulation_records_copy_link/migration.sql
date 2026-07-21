-- Redesign filing: CirculationRecordsCopy now links directly to the
-- DocumentCirculation it packages (one row per CLOSED circulation, created
-- explicitly via POST /api/circulation/:id/send-to-file — see
-- circulation.routes.js), instead of being auto-created on every single
-- step/sign event. circulationStepId is kept only as "the closing step, for
-- reference" and becomes optional.
--
-- Data cleanup (required before the new UNIQUE(circulationId) constraint
-- can be added — confirmed against live data before running):
--   - 29 PENDING_FILING rows were pure noise from the old per-step/per-sign
--     auto-create bug (10 of the 13 circulations they referenced weren't
--     even CLOSED yet). None represent a completed filing action, so they
--     are deleted outright rather than migrated forward.
--   - Of 5 FILED rows (real completed filing work — preserved), one
--     circulation ("Inventory work-1") had 2 duplicate FILED rows, both
--     already pointing at the same dossier (REG-FILE-001) — the later
--     duplicate (crc id cmrod3nce00066l1ysglusxox, filedAt 05:11:32) is
--     removed; the earlier one (cmrodb4lt000f6l1yvdp3z0m8, filedAt
--     04:47:53) is kept and becomes the one row for that circulation.

DELETE FROM "CirculationRecordsCopy" WHERE "status" = 'PENDING_FILING';
DELETE FROM "CirculationRecordsCopy" WHERE "id" = 'cmrod3nce00066l1ysglusxox';

-- AlterTable: add circulationId (nullable first, backfilled below, then
-- tightened to NOT NULL + UNIQUE), and make circulationStepId optional.
ALTER TABLE "CirculationRecordsCopy" ADD COLUMN "circulationId" TEXT;
ALTER TABLE "CirculationRecordsCopy" ALTER COLUMN "circulationStepId" DROP NOT NULL;

-- Backfill: every remaining row still has its original circulationStepId,
-- which resolves to exactly one circulation.
UPDATE "CirculationRecordsCopy" crc
SET "circulationId" = cs."circulationId"
FROM "CirculationStep" cs
WHERE crc."circulationStepId" = cs.id;

ALTER TABLE "CirculationRecordsCopy" ALTER COLUMN "circulationId" SET NOT NULL;
ALTER TABLE "CirculationRecordsCopy" ADD CONSTRAINT "CirculationRecordsCopy_circulationId_key" UNIQUE ("circulationId");

-- AddForeignKey
ALTER TABLE "CirculationRecordsCopy" ADD CONSTRAINT "CirculationRecordsCopy_circulationId_fkey" FOREIGN KEY ("circulationId") REFERENCES "DocumentCirculation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
