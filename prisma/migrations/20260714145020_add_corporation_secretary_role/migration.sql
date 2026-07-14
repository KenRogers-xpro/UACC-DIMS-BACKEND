-- AlterEnum
-- Step 1 of 2 for replacing ACCOUNTS_OFFICER with CORPORATION_SECRETARY.
-- Postgres requires the new value to be committed before it can be used in
-- data (e.g. an UPDATE), so this is its own migration — the data migration
-- and removal of ACCOUNTS_OFFICER follow in the next one.
ALTER TYPE "Role" ADD VALUE 'CORPORATION_SECRETARY';
