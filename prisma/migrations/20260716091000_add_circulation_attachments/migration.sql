-- Supporting-document attachments on an in-progress circulation. Every
-- attachment is a real Document (visible/retrievable through the normal
-- Documents module), just also linked here so it shows in the circulation's
-- trail and Attachments tab.
CREATE TABLE "CirculationAttachment" (
    "id" TEXT NOT NULL,
    "circulationId" TEXT NOT NULL,
    "circulationStepId" TEXT,
    "documentId" INTEGER NOT NULL,
    "attachedById" INTEGER NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CirculationAttachment_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "CirculationAttachment" ADD CONSTRAINT "CirculationAttachment_circulationId_fkey" FOREIGN KEY ("circulationId") REFERENCES "DocumentCirculation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CirculationAttachment" ADD CONSTRAINT "CirculationAttachment_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CirculationAttachment" ADD CONSTRAINT "CirculationAttachment_attachedById_fkey" FOREIGN KEY ("attachedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
