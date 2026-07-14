-- CreateEnum (idempotent)
DO $$ BEGIN
  CREATE TYPE "DocConfidentiality" AS ENUM ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- AlterEnum (idempotent — IF NOT EXISTS supported in PostgreSQL 12+)
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PA_SENT_GM_COMMUNICATION';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'REGISTRY_ENTRY_CREATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'REGISTRY_ENTRY_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'REGISTRY_ENTRY_DELETED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ANNOTATION_ADDED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ANNOTATION_DELETED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'RECORDS_FILE_CREATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ENTRY_ATTACHED_TO_FILE';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ENTRY_DETACHED_FROM_FILE';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CIRCULATION_INITIATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CIRCULATION_STEP_ADDED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DOCUMENT_RETURNED_FOR_CORRECTION';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DOCUMENT_RESUBMITTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SIGNATURE_CREATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SIGNING_PIN_SET';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SIGNING_PIN_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DISPATCH_CREATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DISPATCH_ACKNOWLEDGED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DISPATCH_STATUS_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SCHEDULE_EVENT_CREATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SCHEDULE_EVENT_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SCHEDULE_EVENT_CANCELLED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MESSAGE_SENT';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ANNOUNCEMENT_CREATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ANNOUNCEMENT_DELETED';

-- DropForeignKey (idempotent)
DO $$ BEGIN
  ALTER TABLE "annotations" DROP CONSTRAINT "annotations_registryEntryId_fkey";
EXCEPTION
  WHEN undefined_object THEN null;
END $$;

-- AlterTable "DocumentCirculation" (idempotent)
ALTER TABLE "DocumentCirculation" ADD COLUMN IF NOT EXISTS "awaitingCorrectionFrom" INTEGER;

-- AlterTable "annotations" (idempotent)
ALTER TABLE "annotations" ADD COLUMN IF NOT EXISTS "documentId" INTEGER;
ALTER TABLE "annotations" ADD COLUMN IF NOT EXISTS "type" TEXT NOT NULL DEFAULT 'COMMENT';
ALTER TABLE "annotations" ALTER COLUMN "registryEntryId" DROP NOT NULL;

-- AlterTable "registry_entries" (idempotent)
ALTER TABLE "registry_entries" ADD COLUMN IF NOT EXISTS "confidentiality" "DocConfidentiality" NOT NULL DEFAULT 'INTERNAL';
ALTER TABLE "registry_entries" ADD COLUMN IF NOT EXISTS "recordsFileId" TEXT;
ALTER TABLE "registry_entries" ADD COLUMN IF NOT EXISTS "retentionExpiresAt" TIMESTAMP(3);
ALTER TABLE "registry_entries" ADD COLUMN IF NOT EXISTS "retentionPeriodMonths" INTEGER;

-- AlterTable "users" (idempotent)
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "signingPinHash" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "signingPinSetAt" TIMESTAMP(3);

-- CreateTable (idempotent)
CREATE TABLE IF NOT EXISTS "DocumentVersion" (
    "id" TEXT NOT NULL,
    "documentId" INTEGER NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "filePublicId" TEXT NOT NULL,
    "uploadedById" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable (idempotent)
CREATE TABLE IF NOT EXISTS "RecordsFile" (
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

-- Create Extension (already idempotent)
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateTable (idempotent)
CREATE TABLE IF NOT EXISTS "DocumentEmbedding" (
    "id" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "chunkText" TEXT NOT NULL,
    "embedding" vector(768) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentEmbedding_pkey" PRIMARY KEY ("id")
);

-- CreateTable (idempotent)
CREATE TABLE IF NOT EXISTS "DigitalSignature" (
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

-- CreateTable (idempotent)
CREATE TABLE IF NOT EXISTS "DispatchRecord" (
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

-- CreateTable (idempotent)
CREATE TABLE IF NOT EXISTS "DirectMessage" (
    "id" TEXT NOT NULL,
    "senderId" INTEGER NOT NULL,
    "recipientId" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DirectMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable (idempotent)
CREATE TABLE IF NOT EXISTS "Announcement" (
    "id" TEXT NOT NULL,
    "authorId" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Announcement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (idempotent)
CREATE INDEX IF NOT EXISTS "DocumentVersion_documentId_idx" ON "DocumentVersion"("documentId");

-- CreateIndex (idempotent)
CREATE UNIQUE INDEX IF NOT EXISTS "RecordsFile_fileNumber_key" ON "RecordsFile"("fileNumber");

-- CreateIndex (idempotent)
CREATE INDEX IF NOT EXISTS "RecordsFile_fileNumber_idx" ON "RecordsFile"("fileNumber");

-- CreateIndex (idempotent)
CREATE INDEX IF NOT EXISTS "DocumentEmbedding_sourceType_sourceId_idx" ON "DocumentEmbedding"("sourceType", "sourceId");

-- CreateIndex (idempotent)
CREATE UNIQUE INDEX IF NOT EXISTS "DigitalSignature_circulationStepId_key" ON "DigitalSignature"("circulationStepId");

-- CreateIndex (idempotent)
CREATE INDEX IF NOT EXISTS "DigitalSignature_signerId_idx" ON "DigitalSignature"("signerId");

-- CreateIndex (idempotent)
CREATE UNIQUE INDEX IF NOT EXISTS "DispatchRecord_dispatchNumber_key" ON "DispatchRecord"("dispatchNumber");

-- CreateIndex (idempotent)
CREATE UNIQUE INDEX IF NOT EXISTS "DispatchRecord_circulationId_key" ON "DispatchRecord"("circulationId");

-- CreateIndex (idempotent)
CREATE INDEX IF NOT EXISTS "DirectMessage_senderId_recipientId_idx" ON "DirectMessage"("senderId", "recipientId");

-- CreateIndex (idempotent)
CREATE INDEX IF NOT EXISTS "DirectMessage_recipientId_readAt_idx" ON "DirectMessage"("recipientId", "readAt");

-- AddForeignKey (idempotent via DO blocks)
DO $$ BEGIN
  ALTER TABLE "DocumentVersion" ADD CONSTRAINT "DocumentVersion_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "DocumentVersion" ADD CONSTRAINT "DocumentVersion_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "registry_entries" ADD CONSTRAINT "registry_entries_recordsFileId_fkey" FOREIGN KEY ("recordsFileId") REFERENCES "RecordsFile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "RecordsFile" ADD CONSTRAINT "RecordsFile_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "annotations" ADD CONSTRAINT "annotations_registryEntryId_fkey" FOREIGN KEY ("registryEntryId") REFERENCES "registry_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "annotations" ADD CONSTRAINT "annotations_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "DigitalSignature" ADD CONSTRAINT "DigitalSignature_circulationStepId_fkey" FOREIGN KEY ("circulationStepId") REFERENCES "CirculationStep"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "DigitalSignature" ADD CONSTRAINT "DigitalSignature_signerId_fkey" FOREIGN KEY ("signerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "DocumentCirculation" ADD CONSTRAINT "DocumentCirculation_awaitingCorrectionFrom_fkey" FOREIGN KEY ("awaitingCorrectionFrom") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "DispatchRecord" ADD CONSTRAINT "DispatchRecord_circulationId_fkey" FOREIGN KEY ("circulationId") REFERENCES "DocumentCirculation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "DispatchRecord" ADD CONSTRAINT "DispatchRecord_dispatchedById_fkey" FOREIGN KEY ("dispatchedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "DirectMessage" ADD CONSTRAINT "DirectMessage_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "DirectMessage" ADD CONSTRAINT "DirectMessage_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "Announcement" ADD CONSTRAINT "Announcement_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
