import { GoogleGenerativeAI } from '@google/generative-ai'
import crypto from 'crypto'
import { prisma } from './prisma.js'
import { toVectorLiteral } from './vectorUtils.js'
import { matchUnansweredQueriesForDocument } from './insights.js'
import { extractDocumentText } from './textExtraction.js'

const API_KEY = process.env.GEMINI_API_KEY || ''
// text-embedding-004 has been retired by Google — gemini-embedding-001 is
// the replacement, but it defaults to 3072 dimensions, so every call must
// explicitly request 768 to keep matching the DocumentEmbedding/
// UnansweredQuery vector(768) columns.
const EMBEDDING_MODEL = process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001'
const EMBEDDING_DIMENSIONS = 768

let genai, embeddingModel
try {
  genai = new GoogleGenerativeAI(API_KEY)
  embeddingModel = genai.getGenerativeModel({ model: EMBEDDING_MODEL })
} catch (err) {
  console.error('Failed to initialize embedding model:', err && err.message)
}

export async function generateEmbedding(text) {
  if (!embeddingModel) throw new Error('Embedding model not initialized')
  const result = await embeddingModel.embedContent({
    content: { parts: [{ text }] },
    outputDimensionality: EMBEDDING_DIMENSIONS,
  })
  const values = result?.embedding?.values
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('Embedding API returned no vector')
  }
  return values
}

async function fetchDocumentBuffer(document) {
  if (document.fileData && Buffer.isBuffer(document.fileData) && document.fileData.length > 0) {
    return document.fileData
  }

  const filePath = document.filePath || ''
  if (/^https?:\/\//i.test(filePath)) {
    try {
      const res = await fetch(filePath)
      if (!res.ok) {
        console.error('Failed to fetch document file from URL:', filePath, res.statusText)
        return null
      }
      const arrayBuffer = await res.arrayBuffer()
      return Buffer.from(arrayBuffer)
    } catch (err) {
      console.error('Error fetching document file buffer:', filePath, err && err.message)
      return null
    }
  }

  return null
}

function buildChunkText(document, bodyText = '') {
  const parts = [
    `Title: ${document.title}`,
    document.description ? `Description: ${document.description}` : null,
    `Category: ${document.category}`,
    `Department: ${String(document.department).replace(/_/g, ' ')}`,
  ].filter(Boolean)

  if (bodyText && bodyText.trim()) {
    parts.push(`Body:\n${bodyText.trim()}`)
  }

  return parts.join('\n')
}

export async function ingestDocument(document) {
  if (document.status === 'PRIVATE') {
    // Defense in depth — callers should already gate on this transition,
    // but never index a private draft even if called incorrectly.
    return
  }

  const buffer = await fetchDocumentBuffer(document)
  const extraction = buffer
    ? await extractDocumentText({
        buffer,
        mimeType: document.mimeType,
        filename: document.filePath || document.title,
      })
    : { text: null, extractionMethod: 'unsupported' }

  const chunkText = buildChunkText(document, extraction.text)
  const embedding = await generateEmbedding(chunkText)
  const vectorLiteral = toVectorLiteral(embedding)
  const sourceId = String(document.id)

  await prisma.$executeRaw`DELETE FROM "DocumentEmbedding" WHERE "sourceType" = 'DOCUMENT' AND "sourceId" = ${sourceId}`

  const id = crypto.randomUUID()
  const bodyExtracted = Boolean(extraction.text && extraction.text.trim())

  await prisma.$executeRawUnsafe(
    `INSERT INTO "DocumentEmbedding" (id, "sourceType", "sourceId", "chunkIndex", "chunkText", embedding, "bodyExtracted", "extractionMethod", "createdAt")
     VALUES ($1, 'DOCUMENT', $2, 0, $3, $4::vector, $5, $6, now())`,
    id, sourceId, chunkText, vectorLiteral, bodyExtracted, extraction.extractionMethod || 'unsupported'
  )

  // Detached on purpose — matching against every unresolved question is a
  // separate concern from indexing this document, and must never be able
  // to make ingestDocument() itself (and therefore the upload/submit
  // request it's chained from) fail or hang.
  matchUnansweredQueriesForDocument(document).catch((err) => {
    console.error('Insight matching pass failed for document', document.id, err)
  })
}

export async function removeDocumentEmbedding(documentId) {
  await prisma.$executeRaw`DELETE FROM "DocumentEmbedding" WHERE "sourceType" = 'DOCUMENT' AND "sourceId" = ${String(documentId)}`
}

async function searchByVectorLiteral(vectorLiteral, limit) {
  return prisma.$queryRawUnsafe(
    `SELECT d.id, d.title, d.description, d.category, d.department, d.status, d."uploadedBy",
            e."bodyExtracted", e."extractionMethod", e."chunkText",
            1 - (e.embedding <=> $1::vector) AS score
     FROM "DocumentEmbedding" e
     JOIN documents d ON d.id = (e."sourceId")::int
     WHERE e."sourceType" = 'DOCUMENT' AND d.status != 'PRIVATE'
     ORDER BY e.embedding <=> $1::vector
     LIMIT $2`,
    vectorLiteral, limit
  )
}

// Returns { id, title, description, category, department, status, uploadedBy, bodyExtracted, extractionMethod, chunkText, score }[]
// ordered by relevance. Does NOT apply access control — callers must filter
// the result against the requesting user's visible-document set themselves
// (see documents.routes.js's semantic search endpoint and ai.routes.js).
export async function semanticSearchDocuments(queryText, limit = 10) {
  const embedding = await generateEmbedding(queryText)
  const vectorLiteral = toVectorLiteral(embedding)
  return searchByVectorLiteral(vectorLiteral, limit)
}

// Same search, but also returns the query's own embedding — for callers
// (ai.routes.js's unanswered-query capture) that need to reuse it rather
// than re-embedding the same text a second time.
export async function semanticSearchWithEmbedding(queryText, limit = 10) {
  const embedding = await generateEmbedding(queryText)
  const results = await searchByVectorLiteral(toVectorLiteral(embedding), limit)
  return { embedding, results }
}
