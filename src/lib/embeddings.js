import { GoogleGenerativeAI } from '@google/generative-ai'
import crypto from 'crypto'
import { prisma } from './prisma.js'

const API_KEY = process.env.GEMINI_API_KEY || ''
// text-embedding-004 always returns 768 dimensions, matching the
// DocumentEmbedding.embedding vector(768) column.
const EMBEDDING_MODEL = process.env.GEMINI_EMBEDDING_MODEL || 'text-embedding-004'

let genai, embeddingModel
try {
  genai = new GoogleGenerativeAI(API_KEY)
  embeddingModel = genai.getGenerativeModel({ model: EMBEDDING_MODEL })
} catch (err) {
  console.error('Failed to initialize embedding model:', err && err.message)
}

export async function generateEmbedding(text) {
  if (!embeddingModel) throw new Error('Embedding model not initialized')
  const result = await embeddingModel.embedContent(text)
  const values = result?.embedding?.values
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('Embedding API returned no vector')
  }
  return values
}

function toVectorLiteral(values) {
  return `[${values.join(',')}]`
}

// Builds a lightweight text surrogate for the document. This embeds
// metadata (title/description/category/department/uploader), NOT the
// original file's actual text content — extracting real text from
// arbitrary PDFs/DOCX/XLSX would need a parsing pipeline this project
// doesn't have yet. Search quality is bounded by that.
function buildChunkText(document) {
  return [
    `Title: ${document.title}`,
    document.description ? `Description: ${document.description}` : null,
    `Category: ${document.category}`,
    `Department: ${String(document.department).replace(/_/g, ' ')}`,
  ].filter(Boolean).join('\n')
}

export async function ingestDocument(document) {
  if (document.status === 'PRIVATE') {
    // Defense in depth — callers should already gate on this transition,
    // but never index a private draft even if called incorrectly.
    return
  }

  const chunkText = buildChunkText(document)
  const embedding = await generateEmbedding(chunkText)
  const vectorLiteral = toVectorLiteral(embedding)
  const sourceId = String(document.id)

  await prisma.$executeRaw`DELETE FROM "DocumentEmbedding" WHERE "sourceType" = 'DOCUMENT' AND "sourceId" = ${sourceId}`

  const id = crypto.randomUUID()
  await prisma.$executeRawUnsafe(
    `INSERT INTO "DocumentEmbedding" (id, "sourceType", "sourceId", "chunkIndex", "chunkText", embedding, "createdAt")
     VALUES ($1, 'DOCUMENT', $2, 0, $3, $4::vector, now())`,
    id, sourceId, chunkText, vectorLiteral
  )
}

export async function removeDocumentEmbedding(documentId) {
  await prisma.$executeRaw`DELETE FROM "DocumentEmbedding" WHERE "sourceType" = 'DOCUMENT' AND "sourceId" = ${String(documentId)}`
}

// Returns { id, title, description, category, department, status, uploadedBy, score }[]
// ordered by relevance. Does NOT apply access control — callers must filter
// the result against the requesting user's visible-document set themselves
// (see documents.routes.js's semantic search endpoint and ai.routes.js).
export async function semanticSearchDocuments(queryText, limit = 10) {
  const embedding = await generateEmbedding(queryText)
  const vectorLiteral = toVectorLiteral(embedding)

  const rows = await prisma.$queryRawUnsafe(
    `SELECT d.id, d.title, d.description, d.category, d.department, d.status, d."uploadedBy",
            1 - (e.embedding <=> $1::vector) AS score
     FROM "DocumentEmbedding" e
     JOIN documents d ON d.id = (e."sourceId")::int
     WHERE e."sourceType" = 'DOCUMENT' AND d.status != 'PRIVATE'
     ORDER BY e.embedding <=> $1::vector
     LIMIT $2`,
    vectorLiteral, limit
  )
  return rows
}
