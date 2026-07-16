/**
 * One-time migration: for every Document row still holding its file as raw
 * bytes in Postgres (fileData IS NOT NULL), upload that same content to
 * Cloudinary and repoint filePath/publicId at it. fileData itself is left
 * untouched on purpose — this pass only adds the Cloudinary copy alongside
 * it, it doesn't remove the Postgres copy.
 *
 * Run once: node scripts/migrate-file-bytes-to-cloudinary.js
 */
import '../src/lib/env.js'
import { prisma } from '../src/lib/prisma.js'
import { uploadFile } from '../src/lib/cloudinary.js'

async function main() {
  const rows = await prisma.document.findMany({
    where: { fileData: { not: null } },
    select: { id: true, filePath: true, mimeType: true, fileData: true },
    orderBy: { id: 'asc' },
  })

  console.log(`Found ${rows.length} row(s) with fileData still in Postgres.\n`)

  const results = []

  for (const row of rows) {
    const originalName = row.filePath || `document-${row.id}`
    const byteSize = row.fileData?.length ?? 0

    try {
      const uploaded = await uploadFile(row.fileData, originalName, row.mimeType)

      await prisma.document.update({
        where: { id: row.id },
        data: { filePath: uploaded.secure_url, publicId: uploaded.public_id },
      })

      console.log(
        `OK   id=${row.id} file="${originalName}" bytes=${byteSize} -> ${uploaded.secure_url}`
      )
      results.push({ id: row.id, originalName, byteSize, success: true, url: uploaded.secure_url })
    } catch (err) {
      console.log(
        `FAIL id=${row.id} file="${originalName}" bytes=${byteSize} -> ${err.message}`
      )
      results.push({ id: row.id, originalName, byteSize, success: false, reason: err.message })
    }
  }

  const succeeded = results.filter((r) => r.success)
  const failed = results.filter((r) => !r.success)

  console.log(`\n${succeeded.length} of ${results.length} succeeded.`)
  if (failed.length > 0) {
    console.log('Failures:')
    for (const f of failed) {
      console.log(`  - id=${f.id} file="${f.originalName}": ${f.reason}`)
    }
  }
}

main()
  .catch((err) => {
    console.error('Migration script crashed:', err)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
