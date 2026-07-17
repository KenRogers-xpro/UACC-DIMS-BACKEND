-- Copy roles for a circulation step: informed-only, never actionable, never
-- assigned currentHolderRole. Text[] rather than a join table, matching the
-- lightweight-string-role convention already used for fromRole/toRole.
ALTER TABLE "CirculationStep" ADD COLUMN "ccRoles" TEXT[] NOT NULL DEFAULT '{}';
