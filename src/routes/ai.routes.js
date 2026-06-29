import { Router } from 'express'
import { authenticate } from '../middleware/auth.js'
import { success, error, serverError } from '../lib/response.js'

const router = Router()

// Temporary stub for AI assistant route.
// Restores a minimal, valid endpoint so the server can start.
router.post('/', authenticate, async (req, res) => {
  try {
    const { messages } = req.body
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return error(res, 'Messages array is required')
    }

    // Placeholder response while AI implementation is being restored.
    return success(res, { message: 'AI assistant temporarily unavailable' })
  } catch (err) {
    console.error('AI route error:', err)
    return serverError(res, err)
  }
})

export default router
