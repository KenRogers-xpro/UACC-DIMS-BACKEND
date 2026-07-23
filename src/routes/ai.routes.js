import { Router } from 'express'
import { authenticate } from '../middleware/auth.js'
import { success, error, serverError } from '../lib/response.js'
import { generateFromMessages, hasKey, getKeyDiagnostics, checkKeyWithTestCall } from '../lib/ai.js'
import { prisma } from '../lib/prisma.js'
import { semanticSearchWithEmbedding } from '../lib/embeddings.js'
import { captureUnansweredQuery, UNANSWERED_QUERY_THRESHOLD } from '../lib/insights.js'

const router = Router()

// Retrieves the documents relevant to the latest user message, scoped to
// what this user can actually see (same rule as GET /api/documents), and
// renders them as a context block the model is told to cite from. Never
// throws — retrieval failure (e.g. embeddings not configured) degrades to
// no context rather than breaking the chat. Also returns the raw top-of-
// search score and the query's embedding (computed once here, reused by
// the unanswered-query capture below) — topScore is the best result from
// the *raw* semantic search, before the visibility filter, since a
// "no good answer exists at all" question is a different case from "a good
// answer exists but not for you" (the latter is handled entirely by
// matchUnansweredQueriesForDocument's own visibility check at match time).
async function buildRagContext(messages, user) {
  const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user')
  if (!lastUserMessage?.text?.trim()) return { context: '', topScore: 1, embedding: null, queryText: '', isUnanswerable: false }

  const queryText = lastUserMessage.text.trim()

  try {
    const hasBroadAccess = ['RECORDS_EXECUTIVE', 'GENERAL_MANAGER'].includes(user.role)
    let touchedDocumentIds = new Set()
    if (!hasBroadAccess) {
      const touchedCirculations = await prisma.documentCirculation.findMany({
        where: {
          sourceType: 'DOCUMENT',
          steps: { some: { OR: [{ fromRole: user.role }, { toRole: user.role }] } },
        },
        select: { sourceId: true },
      })
      touchedDocumentIds = new Set(touchedCirculations.map((c) => parseInt(c.sourceId, 10)))
    }

    const { embedding, results: candidates } = await semanticSearchWithEmbedding(queryText, 15)
    const topScore = candidates[0]?.score ?? 0
    // ARCHIVED (bulk-ingested) documents never have a circulation to
    // "touch", so they get their own department-match branch — same rule
    // as documents.routes.js's list/semantic-search endpoints and
    // canViewDocument. Not confidentiality-tiered (see records.routes.js
    // POST /bulk-ingest) — this was verified against the actual gating
    // logic, not assumed to already work.
    const visible = candidates
      .filter((doc) => hasBroadAccess || doc.uploadedBy === user.id || touchedDocumentIds.has(doc.id) ||
        (doc.status === 'ARCHIVED' && doc.department === user.department))
      .slice(0, 5)

    // "Unanswerable" means retrieval genuinely came up empty (no visible
    // matches at all), not merely weak — a low-but-nonzero topScore still
    // hands the model real documents and lets it judge relevance itself,
    // rather than being told up front to give up on a match it might
    // actually be able to use.
    if (visible.length === 0) return { context: '', topScore, embedding, queryText, isUnanswerable: true }

    const entries = visible.map((doc) => {
      const header = `- [Document #${doc.id}] "${doc.title}" (${doc.category}, ${String(doc.department).replace(/_/g, ' ')})`
      const body = doc.bodyExtracted && doc.chunkText
        ? `${header} [Text Extracted]:\n${doc.chunkText}`
        : `${header} [Metadata Only - File Body Not Extracted]${doc.description ? `: ${doc.description}` : ''}`

      // Primes the model to attribute this correctly ("according to an
      // archived memo from...") instead of treating archival content as
      // current-state — not cosmetic, this is what stops a bulk-ingested
      // 2019 memo from being cited as if it reflects today.
      const provenance = doc.origin === 'BULK_INGESTED'
        ? '\n[Archival note: bulk-ingested from a physical/archival source, not part of a live circulation. Any known original date or source is folded into the description above — cite this as archived material, not current-state information.]'
        : ''

      return body + provenance
    }).join('\n\n')

    const hasMetadataOnlyDocs = visible.some((doc) => !doc.bodyExtracted)

    const context = [
      'The following documents from the DIMS system may be relevant to the user\'s question.',
      'Cite them by title and Document # when you use them. Do not mention documents not listed here.',
      hasMetadataOnlyDocs
        ? 'NOTE: The file contents for some listed documents were not extracted (metadata only). Do not invent, assume, or fabricate their file contents; state clearly that you can identify the document but have not read its full body text.'
        : null,
      entries,
    ].filter(Boolean).join('\n\n')

    return { context, topScore, embedding, queryText, isUnanswerable: false }
  } catch (err) {
    console.error('RAG retrieval failed, continuing without context:', err.message)
    // Retrieval itself throwing is the one case that still forces the
    // "couldn't find anything" branch — there's genuinely no context to
    // reason from here, unlike a merely low-scoring result above.
    return { context: '', topScore: 0, embedding: null, queryText, isUnanswerable: true }
  }
}

router.post('/', authenticate, async (req, res) => {
  try {
    console.log('AI route hit; provider=', process.env.AI_PROVIDER, 'hasKey=', hasKey())
    const { messages } = req.body
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return error(res, 'Messages array is required')
    }

    if (process.env.AI_PROVIDER !== 'gemini') {
      return error(res, 'AI provider not configured for Gemini')
    }

    if (!hasKey()) {
      return error(res, 'Gemini API key is not set', { diagnostics: getKeyDiagnostics() })
    }

    const { context: ragContext, topScore, embedding, queryText, isUnanswerable } = await buildRagContext(messages, req.user)

    // Two different questions reuse the same retrieval result but must NOT
    // share one flag: isUnanswerable ("should the model be told to give up")
    // is correctly true only when retrieval failed or nothing was visible at
    // all — a weak-but-visible match should still let the model try. But
    // "should this question be tracked so a future document upload can
    // resolve it" is a different question with a different answer: a
    // visible-but-weak match is exactly the case the insight system exists
    // for, so capture must key off the raw topScore threshold, not off
    // whether anything happened to be visible this time.
    const shouldCaptureUnanswered = isUnanswerable || topScore < UNANSWERED_QUERY_THRESHOLD

    // Store the question (reusing the embedding already computed above —
    // never re-embed) so a future document ingestion can check against it.
    // Awaited, not fire-and-forget: the system prompt below needs to know
    // right now whether to give the "I'll flag you later" line, and this is
    // one small insert, not the expensive part of the request.
    if (shouldCaptureUnanswered && embedding && queryText) {
      try {
        await captureUnansweredQuery({ userId: req.user.id, queryText, embedding, topScore })
      } catch (err) {
        console.error('Failed to capture unanswered query:', err.message)
      }
    }

    const systemPrompt = `You are an AI assistant in the UACC Document & Information Management System (DIMS).

You have access to a draftDocument tool. Use it only when the user has clearly and explicitly asked you to create, write, or draft a document that they intend to save — for example "draft a memo about X" or "write me a formal letter to Y". Do not call it in response to general help, questions, summaries, or discussions where the user hasn't asked for a saved document.

When you do call the tool, state clearly in your reply that the result is a draft requiring human review before submission, and point the user to My Drafts. Never imply the document is finalized.${isUnanswerable ? `
IMPORTANT: You could not find a good answer to the user's question in the available documents. Honestly tell them you couldn't find a strong match right now, and mention that you'll notify them if a relevant document is added later. Do not fabricate an answer or cite documents that weren't provided to you.` : ''}`

    const augmentedMessages = [
      { role: 'system', text: systemPrompt },
      ...(ragContext ? [{ role: 'system', text: ragContext }] : []),
      ...messages
    ]

    const tools = [
      {
        functionDeclarations: [
          {
            name: 'draftDocument',
            description: 'Drafts a new document with the provided title and content. This document will be saved in the user\'s Drafts and requires human review.',
            parameters: {
              type: 'OBJECT',
              properties: {
                title: { type: 'STRING', description: 'The title of the drafted document' },
                content: { type: 'STRING', description: 'The full text content of the document (use markdown or clear structure)' },
                purpose: { type: 'STRING', description: 'The purpose of the document' }
              },
              required: ['title', 'content']
            }
          }
        ]
      }
    ]

    // Call Gemini via client wrapper
    const aiResp = await generateFromMessages(augmentedMessages, tools)
    
    if (aiResp && aiResp.success) {
      if (aiResp.functionCall && aiResp.functionCall.name === 'draftDocument') {
        const { title, content } = aiResp.functionCall.args
        const draft = await prisma.draftDocument.create({
          data: {
            title: String(title).trim(),
            content: String(content).trim(),
            origin: 'AI_GENERATED',
            draftedById: req.user.id,
            status: 'DRAFT',
          }
        })
        
        const responseText = `I've created a draft titled "[${draft.title}]". You can find it in your Drafts to review and edit before submitting. DRAFT_CREATED_ID:${draft.id}`
        return success(res, { provider: 'gemini', response: { success: true, text: responseText } })
      }

      return success(res, { provider: 'gemini', response: aiResp })
    }

    // If we reach here, the provider returned an error structure. Include diagnostics and try a lightweight test call.
    console.error('Gemini returned error:', aiResp)
    const check = await checkKeyWithTestCall()
    return serverError(res, { message: 'Gemini call failed', providerError: aiResp, diagnostics: getKeyDiagnostics(), testCall: check })

  } catch (err) {
    console.error('AI route error:', err)
    return serverError(res, err)
  }
})

// Diagnostics endpoint (no auth) — returns key diagnostics and a quick test call
router.get('/diagnostics', async (req, res) => {
  try {
    const diag = getKeyDiagnostics()
    const test = await checkKeyWithTestCall(8000)
    return success(res, { diagnostics: diag, testCall: test })
  } catch (err) {
    console.error('Diagnostics error:', err)
    return serverError(res, err)
  }
})

export default router
