-- CreateEnum
CREATE TYPE "DocConfidentiality" AS ENUM ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'PA_SENT_GM_COMMUNICATION';
ALTER TYPE "AuditAction" ADD VALUE 'REGISTRY_ENTRY_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'REGISTRY_ENTRY_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'REGISTRY_ENTRY_DELETED';
ALTER TYPE "AuditAction" ADD VALUE 'ANNOTATION_ADDED';
ALTER TYPE "AuditAction" ADD VALUE 'ANNOTATION_DELETED';
ALTER TYPE "AuditAction" ADD VALUE 'RECORDS_FILE_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'ENTRY_ATTACHED_TO_FILE';
ALTER TYPE "AuditAction" ADD VALUE 'ENTRY_DETACHED_FROM_FILE';
ALTER TYPE "AuditAction" ADD VALUE 'CIRCULATION_INITIATED';
ALTER TYPE "AuditAction" ADD VALUE 'CIRCULATION_STEP_ADDED';
ALTER TYPE "AuditAction" ADD VALUE 'DOCUMENT_RETURNED_FOR_CORRECTION';
ALTER TYPE "AuditAction" ADD VALUE 'DOCUMENT_RESUBMITTED';
ALTER TYPE "AuditAction" ADD VALUE 'SIGNATURE_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'SIGNING_PIN_SET';
ALTER TYPE "AuditAction" ADD VALUE 'SIGNING_PIN_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE 'DISPATCH_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'DISPATCH_ACKNOWLEDGED';
ALTER TYPE "AuditAction" ADD VALUE 'DISPATCH_STATUS_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'SCHEDULE_EVENT_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'SCHEDULE_EVENT_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'SCHEDULE_EVENT_CANCELLED';
ALTER TYPE "AuditAction" ADD VALUE 'MESSAGE_SENT';
ALTER TYPE "AuditAction" ADD VALUE 'ANNOUNCEMENT_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'ANNOUNCEMENT_DELETED';

-- DropForeignKey
ALTER TABLE "annotations" DROP CONSTRAINT "annotations_registryEntryId_fkey";

-- AlterTable
ALTER TABLE "DocumentCirculation" ADD COLUMN     "awaitingCorrectionFrom" INTEGER;

-- AlterTable
ALTER TABLE "annotations" ADD COLUMN     "documentId" INTEGER,
ADD COLUMN     "type" TEXT NOT NULL DEFAULT 'COMMENT',
ALTER COLUMN "registryEntryId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "registry_entries" ADD COLUMN     "confidentiality" "DocConfidentiality" NOT NULL DEFAULT 'INTERNAL',
ADD COLUMN     "recordsFileId" TEXT,
ADD COLUMN     "retentionExpiresAt" TIMESTAMP(3),
ADD COLUMN     "retentionPeriodMonths" INTEGER;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "signingPinHash" TEXT,
ADD COLUMN     "signingPinSetAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "DocumentVersion" (
    "id" TEXT NOT NULL,
    "documentId" INTEGER NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "filePublicId" TEXT NOT NULL,
    "uploadedById" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecordsFile" (
    "id" TEXT NOT NULL,
    "fileNumber" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "fileType" TEXT,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdById" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecordsFile_pkey" PRIMARY KEY ("id")
);

-- Create Extension
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateTable
CREATE TABLE "DocumentEmbedding" (
    "id" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "chunkText" TEXT NOT NULL,
    "embedding" vector(768) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentEmbedding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DigitalSignature" (
    "id" TEXT NOT NULL,
    "circulationStepId" TEXT,
    "signerId" INTEGER NOT NULL,
    "signerRole" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "verifiedWithPin" BOOLEAN NOT NULL DEFAULT false,
    "verifiedWithPassword" BOOLEAN NOT NULL DEFAULT false,
    "previousHash" TEXT,
    "signatureHash" TEXT NOT NULL,
    "supersededAt" TIMESTAMP(3),
    "ipAddress" TEXT,
    "signedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DigitalSignature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DispatchRecord" (
    "id" TEXT NOT NULL,
    "dispatchNumber" TEXT NOT NULL,
    "circulationId" TEXT NOT NULL,
    "recipientName" TEXT NOT NULL,
    "recipientOrganization" TEXT,
    "recipientAddress" TEXT,
    "recipientEmail" TEXT,
    "dispatchMethod" TEXT NOT NULL,
    "dispatchedById" INTEGER NOT NULL,
    "dispatchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'DISPATCHED',
    "proofOfDeliveryUrl" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedBy" TEXT,
    "trackingReference" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DispatchRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DirectMessage" (
    "id" TEXT NOT NULL,
    "senderId" INTEGER NOT NULL,
    "recipientId" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DirectMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Announcement" (
    "id" TEXT NOT NULL,
    "authorId" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Announcement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DocumentVersion_documentId_idx" ON "DocumentVersion"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "RecordsFile_fileNumber_key" ON "RecordsFile"("fileNumber");

-- CreateIndex
CREATE INDEX "RecordsFile_fileNumber_idx" ON "RecordsFile"("fileNumber");

-- CreateIndex
CREATE INDEX "DocumentEmbedding_sourceType_sourceId_idx" ON "DocumentEmbedding"("sourceType", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "DigitalSignature_circulationStepId_key" ON "DigitalSignature"("circulationStepId");

-- CreateIndex
CREATE INDEX "DigitalSignature_signerId_idx" ON "DigitalSignature"("signerId");

-- CreateIndex
CREATE UNIQUE INDEX "DispatchRecord_dispatchNumber_key" ON "DispatchRecord"("dispatchNumber");

-- CreateIndex
CREATE UNIQUE INDEX "DispatchRecord_circulationId_key" ON "DispatchRecord"("circulationId");

-- CreateIndex
CREATE INDEX "DirectMessage_senderId_recipientId_idx" ON "DirectMessage"("senderId", "recipientId");

-- CreateIndex
CREATE INDEX "DirectMessage_recipientId_readAt_idx" ON "DirectMessage"("recipientId", "readAt");

-- AddForeignKey
ALTER TABLE "DocumentVersion" ADD CONSTRAINT "DocumentVersion_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentVersion" ADD CONSTRAINT "DocumentVersion_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registry_entries" ADD CONSTRAINT "registry_entries_recordsFileId_fkey" FOREIGN KEY ("recordsFileId") REFERENCES "RecordsFile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecordsFile" ADD CONSTRAINT "RecordsFile_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "annotations" ADD CONSTRAINT "annotations_registryEntryId_fkey" FOREIGN KEY ("registryEntryId") REFERENCES "registry_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "annotations" ADD CONSTRAINT "annotations_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DigitalSignature" ADD CONSTRAINT "DigitalSignature_circulationStepId_fkey" FOREIGN KEY ("circulationStepId") REFERENCES "CirculationStep"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DigitalSignature" ADD CONSTRAINT "DigitalSignature_signerId_fkey" FOREIGN KEY ("signerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentCirculation" ADD CONSTRAINT "DocumentCirculation_awaitingCorrectionFrom_fkey" FOREIGN KEY ("awaitingCorrectionFrom") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DispatchRecord" ADD CONSTRAINT "DispatchRecord_circulationId_fkey" FOREIGN KEY ("circulationId") REFERENCES "DocumentCirculation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DispatchRecord" ADD CONSTRAINT "DispatchRecord_dispatchedById_fkey" FOREIGN KEY ("dispatchedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DirectMessage" ADD CONSTRAINT "DirectMessage_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DirectMessage" ADD CONSTRAINT "DirectMessage_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Announcement" ADD CONSTRAINT "Announcement_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
