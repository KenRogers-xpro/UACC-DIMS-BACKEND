import crypto from 'crypto'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { prisma } from './prisma.js'
import { toVectorLiteral } from './vectorUtils.js'
import { canViewDocument } from './documentAccess.js'

const API_KEY = process.env.GEMINI_API_KEY || ''
// DO NOT use '-latest' aliases — Google hot-swaps what they point to without
// notice, which can silently change your quota/pricing tier overnight (this
// broke the app once already, July 2026). Always pin to a specific dated
// model version.
const SUMMARY_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash'

// Both tunable — start conservative, adjust after observing real
// similarity score distributions in production.
export const UNANSWERED_QUERY_THRESHOLD = 0.55
export const INSIGHT_MATCH_THRESHOLD = 0.65
const DEDUPE_SIMILARITY_THRESHOLD = 0.9

let genai, summaryModel
try {
  genai = new GoogleGenerativeAI(API_KEY)
  summaryModel = genai.getGenerativeModel({ model: SUMMARY_MODEL })
} catch (err) {
  console.error('Failed to initialize insight summary model:', err && err.message)
}

// Directive 2 — called right after a chat search comes back weak (top
// similarity below UNANSWERED_QUERY_THRESHOLD). Stores the query with its
// already-computed embedding — never re-embeds — so a future document
// ingestion can check against it later.
export async function captureUnansweredQuery({ userId, queryText, embedding, topScore }) {
  const vectorLiteral = toVectorLiteral(embedding)

  // Dedupe: an unresolved question from this same user that's basically a
  // rephrasing of this one (cosine similarity > 0.9) shouldn't pile up.
  const dupes = await prisma.$queryRawUnsafe(
    `SELECT id FROM "UnansweredQuery"
     WHERE "userId" = $1 AND "resolvedAt" IS NULL
       AND 1 - (embedding <=> $2::vector) > $3
     LIMIT 1`,
    userId, vectorLiteral, DEDUPE_SIMILARITY_THRESHOLD
  )
  if (dupes.length > 0) return null

  const id = crypto.randomUUID()
  await prisma.$executeRawUnsafe(
    `INSERT INTO "UnansweredQuery" (id, "userId", "queryText", embedding, "bestScoreAtAsk", "createdAt")
     VALUES ($1, $2, $3, $4::vector, $5, now())`,
    id, userId, queryText, vectorLiteral, topScore
  )
  return id
}

// Directive 3 — called (fire-and-forget, by the caller) right after a
// document's chunks are (re-)embedded at ingestion. Scores every still-
// unresolved UnansweredQuery against ONLY this document's chunks (a single
// efficient query scoped by sourceId, not the whole embedding table) and,
// for anything crossing INSIGHT_MATCH_THRESHOLD, checks the asking user can
// actually see the document before doing anything else — a notification
// that a hidden document answers your question is itself a leak, so a
// failed visibility check produces absolutely nothing, not even a log line
// naming the document.
export async function matchUnansweredQueriesForDocument(document) {
  const sourceId = String(document.id)

  const matches = await prisma.$queryRawUnsafe(
    `SELECT uq.id AS "queryId", uq."userId", uq."queryText",
            MAX(1 - (uq.embedding <=> de.embedding)) AS score
     FROM "UnansweredQuery" uq
     CROSS JOIN "DocumentEmbedding" de
     WHERE uq."resolvedAt" IS NULL
       AND de."sourceType" = 'DOCUMENT' AND de."sourceId" = $1
     GROUP BY uq.id, uq."userId", uq."queryText"
     HAVING MAX(1 - (uq.embedding <=> de.embedding)) > $2
     ORDER BY score DESC`,
    sourceId, INSIGHT_MATCH_THRESHOLD
  )

  for (const match of matches) {
    try {
      await createInsightIfVisible(document, match)
    } catch (err) {
      console.error(`Insight matching failed for query ${match.queryId} / document ${document.id}:`, err.message)
    }
  }
}

async function createInsightIfVisible(document, match) {
  const askingUser = await prisma.user.findUnique({
    where: { id: match.userId },
    select: { id: true, role: true },
  })
  if (!askingUser) return

  const visible = await canViewDocument(document, askingUser)
  if (!visible) return

  const body = await generateInsightSummary(match.queryText, document)

  await prisma.agentInsight.create({
    data: {
      userId: match.userId,
      queryId: match.queryId,
      title: 'A new document may answer your earlier question',
      body,
      sourceType: 'DOCUMENT',
      sourceId: String(document.id),
      similarity: match.score,
    },
  })

  await prisma.unansweredQuery.update({
    where: { id: match.queryId },
    data: { resolvedAt: new Date() },
  })
}

async function generateInsightSummary(queryText, document) {
  const fallback = `You previously asked: "${queryText}". The newly added document "${document.title}" appears related and may help answer it.`
  if (!summaryModel) return fallback

  try {
    const prompt = [
      'A user previously asked this question in an internal document management system and got no good answer:',
      `"${queryText}"`,
      '',
      `A new document has just been added titled "${document.title}" (category: ${document.category}, department: ${String(document.department).replace(/_/g, ' ')}${document.description ? `, description: ${document.description}` : ''}).`,
      '',
      'In 1-2 short sentences, explain to the user why this new document might answer their earlier question. Be concise and direct, second person ("you asked...").',
    ].join('\n')

    const result = await summaryModel.generateContent(prompt)
    const text = result?.response?.text()?.trim()
    return text || fallback
  } catch (err) {
    console.error('Insight summary generation failed, using fallback text:', err.message)
    return fallback
  }
}
