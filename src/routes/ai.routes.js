import { Router } from 'express'
import { authenticate } from '../middleware/auth.js'
import { success, error, serverError } from '../lib/response.js'
import { generateFromMessages, hasKey, getKeyDiagnostics, checkKeyWithTestCall } from '../lib/ai.js'
import { prisma } from '../lib/prisma.js'
import { semanticSearchDocuments } from '../lib/embeddings.js'

const router = Router()

// Retrieves the documents relevant to the latest user message, scoped to
// what this user can actually see (same rule as GET /api/documents), and
// renders them as a context block the model is told to cite from. Never
// throws — retrieval failure (e.g. embeddings not configured) degrades to
// no context rather than breaking the chat.
async function buildRagContext(messages, user) {
  const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user')
  if (!lastUserMessage?.text?.trim()) return ''

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

    const candidates = await semanticSearchDocuments(lastUserMessage.text, 15)
    const visible = candidates
      .filter((doc) => hasBroadAccess || doc.uploadedBy === user.id || touchedDocumentIds.has(doc.id))
      .slice(0, 5)

    if (visible.length === 0) return ''

    const entries = visible.map((doc) =>
      `- [Document #${doc.id}] "${doc.title}" (${doc.category}, ${String(doc.department).replace(/_/g, ' ')})${doc.description ? `: ${doc.description}` : ''}`
    ).join('\n')

    return [
      'The following documents from the DIMS system may be relevant to the user\'s question.',
      'Cite them by title and Document # when you use them. Do not mention documents not listed here.',
      entries,
    ].join('\n')
  } catch (err) {
    console.error('RAG retrieval failed, continuing without context:', err.message)
    return ''
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

    const ragContext = await buildRagContext(messages, req.user)
    
    const systemPrompt = `You are an AI assistant in the UACC Document & Information Management System (DIMS).
When a user asks you to "draft a memo", "write a letter", "compose a report", or similar, you MUST use the draftDocument tool to create the draft.
Generate well-structured document content (clear subject line, To/From/Date/Ref/Subject structure where appropriate) and call the tool.
IMPORTANT: After calling the tool, your response MUST state clearly that this is a draft requiring human review before submission — never imply the document is finalized. Tell the user to go to their My Drafts to review it.`

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
