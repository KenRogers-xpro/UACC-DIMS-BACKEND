-- Separates the declared destination (CirculationStep.toRole, unchanged) from
-- who must actually act on a step right now. Nullable: existing rows have no
-- gatekeeping concept applied retroactively, and application code treats a
-- null heldByRole as "same as toRole" wherever it matters going forward.
ALTER TABLE "CirculationStep" ADD COLUMN "heldByRole" TEXT;
