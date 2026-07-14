-- Move off Cloudinary (no working account behind those credentials) to
-- storing uploaded file bytes directly in Postgres.
ALTER TABLE "documents" DROP COLUMN "publicId";
ALTER TABLE "documents" ADD COLUMN "fileData" BYTEA;
ALTER TABLE "documents" ADD COLUMN "mimeType" TEXT;
