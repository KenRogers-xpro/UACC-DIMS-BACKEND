/*
  Warnings:

  - You are about to drop the `DocumentRouting` table. If the table is not empty, all the data it contains will be lost.

*/
-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "Department" ADD VALUE 'HUMAN_RESOURCES';
ALTER TYPE "Department" ADD VALUE 'FINANCE_AND_ACCOUNTS';
ALTER TYPE "Department" ADD VALUE 'MARKETING';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "Role" ADD VALUE 'INTERNAL_AUDITOR';
ALTER TYPE "Role" ADD VALUE 'HR_MANAGER';
ALTER TYPE "Role" ADD VALUE 'FINANCE_DIRECTOR';
ALTER TYPE "Role" ADD VALUE 'ACCOUNTS_OFFICER';
ALTER TYPE "Role" ADD VALUE 'MARKETING_OFFICER';

-- DropForeignKey
ALTER TABLE "DocumentRouting" DROP CONSTRAINT "DocumentRouting_triagedById_fkey";

-- DropTable
DROP TABLE "DocumentRouting";

-- CreateTable
CREATE TABLE "DocumentCirculation" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "originatorId" INTEGER NOT NULL,
    "currentHolderRole" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'IN_CIRCULATION',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentCirculation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CirculationStep" (
    "id" TEXT NOT NULL,
    "circulationId" TEXT NOT NULL,
    "stepNumber" INTEGER NOT NULL,
    "fromUserId" INTEGER NOT NULL,
    "fromRole" TEXT NOT NULL,
    "toUserId" INTEGER,
    "toRole" TEXT NOT NULL,
    "instruction" TEXT NOT NULL,
    "stepType" TEXT NOT NULL,
    "decision" TEXT,
    "amount" DECIMAL(65,30),
    "signedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CirculationStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CirculationRecordsCopy" (
    "id" TEXT NOT NULL,
    "circulationStepId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING_FILING',
    "filedById" INTEGER,
    "filedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CirculationRecordsCopy_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "DocumentCirculation" ADD CONSTRAINT "DocumentCirculation_originatorId_fkey" FOREIGN KEY ("originatorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CirculationStep" ADD CONSTRAINT "CirculationStep_circulationId_fkey" FOREIGN KEY ("circulationId") REFERENCES "DocumentCirculation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CirculationStep" ADD CONSTRAINT "CirculationStep_fromUserId_fkey" FOREIGN KEY ("fromUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CirculationRecordsCopy" ADD CONSTRAINT "CirculationRecordsCopy_circulationStepId_fkey" FOREIGN KEY ("circulationStepId") REFERENCES "CirculationStep"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CirculationRecordsCopy" ADD CONSTRAINT "CirculationRecordsCopy_filedById_fkey" FOREIGN KEY ("filedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
