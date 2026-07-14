-- DigitalSignature was declared in schema.prisma but never migrated — needed
-- now for the real PIN-based signing flow.
CREATE TABLE "DigitalSignature" (
    "id" TEXT NOT NULL,
    "circulationStepId" TEXT,
    "signerId" INTEGER NOT NULL,
    "signerRole" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "verifiedWithPin" BOOLEAN NOT NULL DEFAULT false,
    "verifiedWithPassword" BOOLEAN NOT NULL DEFAULT false,
    "previousHash" TEXT,
    "signatureHash" TEXT NOT NULL,
    "supersededAt" TIMESTAMP(3),
    "ipAddress" TEXT,
    "signedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DigitalSignature_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DigitalSignature_circulationStepId_key" ON "DigitalSignature"("circulationStepId");
CREATE INDEX "DigitalSignature_signerId_idx" ON "DigitalSignature"("signerId");

ALTER TABLE "DigitalSignature" ADD CONSTRAINT "DigitalSignature_circulationStepId_fkey" FOREIGN KEY ("circulationStepId") REFERENCES "CirculationStep"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DigitalSignature" ADD CONSTRAINT "DigitalSignature_signerId_fkey" FOREIGN KEY ("signerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
