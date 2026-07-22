import { prisma } from '../src/lib/prisma.js'
import { ingestDocument } from '../src/lib/embeddings.js'

async function main() {
  console.log('--- Starting Document Embeddings Re-ingestion ---')

  const documents = await prisma.document.findMany({
    where: {
      status: { not: 'PRIVATE' },
    },
    orderBy: { id: 'asc' },
  })

  console.log(`Found ${documents.length} non-private document(s) to process.`)

  let successCount = 0
  let failCount = 0

  for (const doc of documents) {
    try {
      console.log(`Processing Document #${doc.id}: "${doc.title}" (${doc.category}, ${doc.status})...`)
      await ingestDocument(doc)

      // Query the updated DocumentEmbedding row to log status
      const embeddingRow = await prisma.$queryRawUnsafe(
        `SELECT "bodyExtracted", "extractionMethod", LENGTH("chunkText") as chunk_len
         FROM "DocumentEmbedding"
         WHERE "sourceType" = 'DOCUMENT' AND "sourceId" = $1`,
        String(doc.id)
      )

      if (embeddingRow && embeddingRow.length > 0) {
        const info = embeddingRow[0]
        console.log(`  -> Indexed! Body Extracted: ${info.bodyExtracted}, Method: ${info.extractionMethod}, Chunk Length: ${info.chunk_len} chars`)
      } else {
        console.log(`  -> Warning: No DocumentEmbedding row found after ingestion for Document #${doc.id}`)
      }

      successCount++
    } catch (err) {
      console.error(`  -> ERROR re-ingesting Document #${doc.id}:`, err && err.message)
      failCount++
    }
  }

  console.log('--- Re-ingestion Complete ---')
  console.log(`Summary: ${successCount} succeeded, ${failCount} failed.`)
}

main()
  .catch((err) => {
    console.error('Fatal error during re-ingestion:', err)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
