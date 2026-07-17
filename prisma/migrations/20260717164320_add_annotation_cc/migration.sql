-- Same CC principle as circulation steps, applied to annotations: a role
-- listed here can view the parent document/registry entry but has nothing
-- actionable to do.
ALTER TABLE "annotations" ADD COLUMN "ccRoles" TEXT[] NOT NULL DEFAULT '{}';
