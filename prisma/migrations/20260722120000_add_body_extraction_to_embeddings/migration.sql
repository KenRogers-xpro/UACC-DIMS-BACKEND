-- AlterTable
ALTER TABLE "DocumentEmbedding" ADD COLUMN "bodyExtracted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "DocumentEmbedding" ADD COLUMN "extractionMethod" TEXT;
