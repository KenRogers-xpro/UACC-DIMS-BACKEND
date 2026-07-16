-- Cloudinary public_id, needed to delete/re-sign/inspect an uploaded file
-- later. Nullable: legacy fileData-backed rows and drafts have none.
ALTER TABLE "documents" ADD COLUMN "publicId" TEXT;
