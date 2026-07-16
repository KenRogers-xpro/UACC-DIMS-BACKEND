-- AI Agent insights: an unanswered chat question gets its own embedding;
-- every later document ingestion checks unresolved questions against the
-- new chunks, and a strong match produces an AgentInsight for the asker.
-- vector extension already exists (see DocumentEmbedding's migration), but
-- IF NOT EXISTS keeps this migration safe to run against a fresh DB too.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE "UnansweredQuery" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "queryText" TEXT NOT NULL,
    "embedding" vector(768) NOT NULL,
    "bestScoreAtAsk" DOUBLE PRECISION,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UnansweredQuery_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "UnansweredQuery_userId_resolvedAt_idx" ON "UnansweredQuery"("userId", "resolvedAt");

ALTER TABLE "UnansweredQuery" ADD CONSTRAINT "UnansweredQuery_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "AgentInsight" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "queryId" TEXT,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "similarity" DOUBLE PRECISION NOT NULL,
    "seenAt" TIMESTAMP(3),
    "dismissedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentInsight_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AgentInsight_userId_seenAt_dismissedAt_idx" ON "AgentInsight"("userId", "seenAt", "dismissedAt");

ALTER TABLE "AgentInsight" ADD CONSTRAINT "AgentInsight_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
