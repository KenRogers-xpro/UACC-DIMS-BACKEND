-- Remove AUDITOR from Role enum
-- PostgreSQL does not support DROP VALUE on enums directly,
-- so we recreate the enum without AUDITOR.

-- Step 1: Update any user with AUDITOR role to INTERNAL_AUDITOR before changing the type
UPDATE "users" SET "role" = 'INTERNAL_AUDITOR' WHERE "role" = 'AUDITOR';

-- Step 2: Drop the column default (it references the old enum)
ALTER TABLE "users" ALTER COLUMN "role" DROP DEFAULT;

-- Step 3: Create a new enum without AUDITOR
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
  'ACCOUNTS_OFFICER',
  'MARKETING_OFFICER'
);

-- Step 4: Alter the column to use the new type
ALTER TABLE "users" ALTER COLUMN "role" TYPE "Role_new" USING ("role"::text::"Role_new");

-- Step 5: Re-apply the default using the new enum
ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'STAFF'::"Role_new";

-- Step 6: Drop the old enum and rename the new one
DROP TYPE "Role";
ALTER TYPE "Role_new" RENAME TO "Role";
