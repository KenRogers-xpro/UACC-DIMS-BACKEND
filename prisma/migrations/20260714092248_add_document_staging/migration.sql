-- AlterTable
ALTER TABLE "documents" ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'PRIVATE',
ADD COLUMN     "isEditable" BOOLEAN NOT NULL DEFAULT true;
