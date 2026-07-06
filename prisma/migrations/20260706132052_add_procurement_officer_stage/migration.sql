-- CreateEnum
CREATE TYPE "Role" AS ENUM ('GENERAL_MANAGER', 'GM_PERSONAL_ASSISTANT', 'DEPARTMENT_HEAD', 'STAFF', 'IT_ADMINISTRATOR', 'AUDITOR', 'RECORDS_EXECUTIVE', 'PROCUREMENT_OFFICER');

-- CreateEnum
CREATE TYPE "Department" AS ENUM ('GENERAL_MANAGER_OFFICE', 'FINANCE_AND_ADMINISTRATION', 'ENGINEERING', 'PILOTS', 'OPERATIONS');

-- CreateEnum
CREATE TYPE "DocumentCategory" AS ENUM ('POLICY', 'REPORT', 'MEMO', 'CONTRACT', 'FORM', 'OTHER');

-- CreateEnum
CREATE TYPE "ProcurementStatus" AS ENUM ('PENDING_DEPT_HEAD', 'PENDING_PROCUREMENT_OFFICER', 'PENDING_GM', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('LOGIN', 'LOGOUT', 'DOCUMENT_UPLOAD', 'DOCUMENT_DOWNLOAD', 'DOCUMENT_DELETE', 'PROCUREMENT_SUBMIT', 'PROCUREMENT_APPROVE', 'PROCUREMENT_REJECT', 'PA_TRIAGED_DOCUMENT', 'DRAFT_CREATED', 'DRAFT_SUBMITTED', 'DRAFT_REVIEWED', 'DRAFT_FINALIZED', 'LOG_ENTRY', 'USER_CREATED', 'USER_UPDATED', 'USER_DEACTIVATED');

-- CreateEnum
CREATE TYPE "DocType" AS ENUM ('MEMO', 'CONTRACT', 'POLICY', 'REPORT', 'LETTER', 'INVOICE', 'FORM', 'LOGBOOK', 'OTHER');

-- CreateEnum
CREATE TYPE "DocDirection" AS ENUM ('INCOMING', 'OUTGOING', 'INTERNAL');

-- CreateEnum
CREATE TYPE "DocPriority" AS ENUM ('NORMAL', 'HIGH', 'CONFIDENTIAL');

-- CreateEnum
CREATE TYPE "DocMedium" AS ENUM ('PHYSICAL', 'EMAIL', 'BOTH');

-- CreateEnum
CREATE TYPE "RegistryStatus" AS ENUM ('PENDING', 'DISPATCHED', 'RECEIVED', 'ACTIONED', 'CLOSED');

-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'STAFF',
    "department" "Department" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "category" "DocumentCategory" NOT NULL,
    "department" "Department" NOT NULL,
    "filePath" TEXT NOT NULL,
    "fileSize" INTEGER,
    "publicId" TEXT,
    "description" TEXT,
    "uploadedBy" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "procurement_requests" (
    "id" SERIAL NOT NULL,
    "referenceNo" TEXT NOT NULL,
    "itemDescription" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "estimatedCost" DECIMAL(12,2) NOT NULL,
    "department" "Department" NOT NULL,
    "justification" TEXT NOT NULL,
    "supportingDocument" TEXT,
    "status" "ProcurementStatus" NOT NULL DEFAULT 'PENDING_DEPT_HEAD',
    "deptHeadApproval" "ApprovalStatus",
    "deptHeadComment" TEXT,
    "vendorName" TEXT,
    "vendorVerified" BOOLEAN NOT NULL DEFAULT false,
    "budgetVerified" BOOLEAN NOT NULL DEFAULT false,
    "poNotes" TEXT,
    "poProcessedById" INTEGER,
    "poProcessedAt" TIMESTAMP(3),
    "gmApproval" "ApprovalStatus",
    "gmComment" TEXT,
    "requestedById" INTEGER NOT NULL,
    "approvedById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "procurement_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_logs" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "department" "Department" NOT NULL,
    "logDate" TIMESTAMP(3) NOT NULL,
    "activityDescription" TEXT NOT NULL,
    "hoursSpent" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "action" "AuditAction" NOT NULL,
    "module" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "registry_entries" (
    "id" SERIAL NOT NULL,
    "registryNo" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "docType" "DocType" NOT NULL,
    "direction" "DocDirection" NOT NULL,
    "source" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "receivedFrom" TEXT,
    "handledById" INTEGER NOT NULL,
    "priority" "DocPriority" NOT NULL DEFAULT 'NORMAL',
    "medium" "DocMedium" NOT NULL,
    "fileRef" TEXT,
    "physicalLocation" TEXT,
    "status" "RegistryStatus" NOT NULL DEFAULT 'PENDING',
    "dateRegistered" TIMESTAMP(3) NOT NULL,
    "dateDispatched" TIMESTAMP(3),
    "dateReceived" TIMESTAMP(3),
    "dateClosed" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "registry_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "annotations" (
    "id" SERIAL NOT NULL,
    "registryEntryId" INTEGER NOT NULL,
    "authorId" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "annotations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GMScheduleEvent" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "location" TEXT,
    "createdById" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CONFIRMED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GMScheduleEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentRouting" (
    "id" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "addressedTo" TEXT NOT NULL DEFAULT 'GENERAL_MANAGER',
    "triagedById" INTEGER,
    "priority" TEXT NOT NULL DEFAULT 'NORMAL',
    "paNote" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING_TRIAGE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "forwardedAt" TIMESTAMP(3),

    CONSTRAINT "DocumentRouting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DraftDocument" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "draftedById" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "gmFeedback" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DraftDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "procurement_requests_referenceNo_key" ON "procurement_requests"("referenceNo");

-- CreateIndex
CREATE UNIQUE INDEX "registry_entries_registryNo_key" ON "registry_entries"("registryNo");

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_uploadedBy_fkey" FOREIGN KEY ("uploadedBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "procurement_requests" ADD CONSTRAINT "procurement_requests_poProcessedById_fkey" FOREIGN KEY ("poProcessedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "procurement_requests" ADD CONSTRAINT "procurement_requests_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "procurement_requests" ADD CONSTRAINT "procurement_requests_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registry_entries" ADD CONSTRAINT "registry_entries_handledById_fkey" FOREIGN KEY ("handledById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "annotations" ADD CONSTRAINT "annotations_registryEntryId_fkey" FOREIGN KEY ("registryEntryId") REFERENCES "registry_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "annotations" ADD CONSTRAINT "annotations_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GMScheduleEvent" ADD CONSTRAINT "GMScheduleEvent_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentRouting" ADD CONSTRAINT "DocumentRouting_triagedById_fkey" FOREIGN KEY ("triagedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DraftDocument" ADD CONSTRAINT "DraftDocument_draftedById_fkey" FOREIGN KEY ("draftedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
