/**
 * Applies missing schema columns to the Neon DB without touching pgvector.
 * Run once: node scripts/apply_missing_columns.js
 */
import '../src/lib/env.js'
import pg from 'pg'

const { Client } = pg
const client = new Client({ connectionString: process.env.DATABASE_URL })

const statements = [
  // ── users table ──────────────────────────────────────────────────────────────
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS "signingPinHash" TEXT`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS "signingPinSetAt" TIMESTAMP(3)`,

  // ── document_versions table ──────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS "document_versions" (
    "id"            TEXT        NOT NULL,
    "documentId"    INTEGER     NOT NULL,
    "versionNumber" INTEGER     NOT NULL,
    "fileUrl"       TEXT        NOT NULL,
    "filePublicId"  TEXT        NOT NULL,
    "uploadedById"  INTEGER     NOT NULL,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "document_versions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "document_versions_documentId_fkey"
      FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "document_versions_uploadedById_fkey"
      FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS "document_versions_documentId_idx" ON "document_versions"("documentId")`,
]

try {
  await client.connect()
  console.log('✅ Connected to Neon DB')
  for (const sql of statements) {
    const preview = sql.trim().split('\n')[0].slice(0, 80)
    process.stdout.write(`  Running: ${preview}... `)
    await client.query(sql)
    console.log('OK')
  }
  console.log('\n🎉 All missing columns/tables applied successfully.')
} catch (err) {
  console.error('\n❌ Error:', err.message)
  process.exit(1)
} finally {
  await client.end()
}
