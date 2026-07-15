-- Real per-user notification read-tracking, replacing the 72h-lookback-window
-- workaround for announcements and adding proper "seen" state for circulation
-- steps. DirectMessage already has its own readAt column and keeps using it.
CREATE TABLE "NotificationRead" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationRead_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NotificationRead_userId_sourceType_sourceId_key" ON "NotificationRead"("userId", "sourceType", "sourceId");

ALTER TABLE "NotificationRead" ADD CONSTRAINT "NotificationRead_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
