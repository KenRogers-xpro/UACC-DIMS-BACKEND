import { Router } from 'express'
import { authenticate } from '../middleware/auth.js'
import { success, error, serverError } from '../lib/response.js'
import { generateFromMessages, hasKey, getKeyDiagnostics, checkKeyWithTestCall } from '../lib/ai.js'

const router = Router()

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

    // Call Gemini via client wrapper
    const aiResp = await generateFromMessages(messages)
    if (aiResp && aiResp.success) {
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
