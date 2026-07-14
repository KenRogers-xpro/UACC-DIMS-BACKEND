-- DocumentEmbedding was declared in schema.prisma from an earlier pass but
-- never migrated (pgvector needs manual SQL — Prisma can't manage the vector
-- column type directly). Setting it up for real now.
CREATE EXTENSION IF NOT EXISTS vector;

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

CREATE INDEX "DocumentEmbedding_sourceType_sourceId_idx" ON "DocumentEmbedding"("sourceType", "sourceId");
