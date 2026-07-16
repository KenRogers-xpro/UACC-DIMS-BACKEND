-- Per-user conversation hiding. Not a delete of DirectMessage rows (that
-- would destroy the other party's copy) — a visibility flag scoped to the
-- user who hid it.
CREATE TABLE "HiddenConversation" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "otherUserId" INTEGER NOT NULL,
    "hiddenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HiddenConversation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "HiddenConversation_userId_otherUserId_key" ON "HiddenConversation"("userId", "otherUserId");

ALTER TABLE "HiddenConversation" ADD CONSTRAINT "HiddenConversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
