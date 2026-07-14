-- Step 2 of 2: migrate any existing ACCOUNTS_OFFICER row to the new role AND
-- rename it in-place to the new canonical identity (rather than just
-- flipping the enum value and leaving stale name/email), so the seeded
-- account transfers cleanly with no duplicate/orphaned row when seed.js is
-- next run. User id is preserved, so any FKs (documents.uploadedBy, audit
-- logs, etc.) referencing this user stay intact.
UPDATE "users"
SET "role" = 'CORPORATION_SECRETARY',
    "name" = 'Corporation Secretary',
    "email" = 'corporation.secretary@uacc.go.ug',
    "department" = 'GENERAL_MANAGER_OFFICE'
WHERE "role" = 'ACCOUNTS_OFFICER';

-- PostgreSQL does not support DROP VALUE on enums directly, so recreate the
-- enum without ACCOUNTS_OFFICER (same pattern as the earlier AUDITOR removal).
ALTER TABLE "users" ALTER COLUMN "role" DROP DEFAULT;

CREATE TYPE "Role_new" AS ENUM (
  'GENERAL_MANAGER',
  'GM_PERSONAL_ASSISTANT',
  'DEPARTMENT_HEAD',
  'STAFF',
  'IT_ADMINISTRATOR',
  'INTERNAL_AUDITOR',
  'RECORDS_EXECUTIVE',
  'PROCUREMENT_OFFICER',
  'HR_MANAGER',
  'FINANCE_DIRECTOR',
  'MARKETING_OFFICER',
  'CORPORATION_SECRETARY'
);

ALTER TABLE "users" ALTER COLUMN "role" TYPE "Role_new" USING ("role"::text::"Role_new");

ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'STAFF';

DROP TYPE "Role";
ALTER TYPE "Role_new" RENAME TO "Role";
