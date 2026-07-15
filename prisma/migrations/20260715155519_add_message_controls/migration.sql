-- Edit/soft-delete tracking for direct messages and announcements.
ALTER TABLE "DirectMessage" ADD COLUMN "editedAt" TIMESTAMP(3);
ALTER TABLE "DirectMessage" ADD COLUMN "deletedAt" TIMESTAMP(3);

ALTER TABLE "Announcement" ADD COLUMN "editedAt" TIMESTAMP(3);
ALTER TABLE "Announcement" ADD COLUMN "deletedAt" TIMESTAMP(3);
