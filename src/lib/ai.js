import './env.js'

import { GoogleGenerativeAI, GoogleGenerativeAIFetchError } from '@google/generative-ai'
import dotenv from 'dotenv'

// ensure env is loaded when this module is imported directly by scripts
dotenv.config()

const API_KEY = process.env.GEMINI_API_KEY || ''
// text-bison-001 (the old default here) is a retired PaLM model, not even
// a Gemini one — it would fail every chat call regardless of key validity.
// Pin to gemini-3.1-flash-lite (GA, free tier, high quota). DO NOT use
// '-latest' aliases (broke July 2026 when it silently moved to 3.5-flash
// with 20 req/day limit). gemini-2.5-flash is restricted to pre-existing
// users as of mid-2026 and 404s for new API keys.
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite'

let genai, model
try {
  // This SDK's constructor takes the key directly as a string — the object
  // form { apiKey } (a different SDK's convention) doesn't throw here, it
  // just silently produces a client that sends a broken key on every
  // request, surfacing as a confusing "API key not valid" from Google
  // instead of an obvious local error.
  genai = new GoogleGenerativeAI(API_KEY)
  model = genai.getGenerativeModel({ model: MODEL })
} catch (err) {
  console.error('Failed to initialize GoogleGenerativeAI client:', err && err.message)
}

function maskKey(k = '') {
  if (!k) return '<empty>'
  if (k.length < 8) return `${k.slice(0,2)}...${k.slice(-2)}`
  return `${k.slice(0,4)}...${k.slice(-4)}`
}

export async function generateFromMessages(messages = [], tools = []) {
  if (!genai) throw new Error('AI client not initialized')
  
  // Use a model instance with tools if provided
  const currentModel = tools && tools.length > 0
    ? genai.getGenerativeModel({ model: MODEL, tools })
    : model

  if (!currentModel) throw new Error('AI model not initialized')

  // Convert messages to Gemini format (user/model)
  const history = messages.slice(0, -1).map(m => ({
    role: m.role === 'ai' ? 'model' : 'user',
    parts: [{ text: m.text }]
  }))
  const lastMessage = messages[messages.length - 1]?.text || ''

  try {
    const chat = currentModel.startChat({ history })
    const result = await chat.sendMessage(lastMessage)
    
    // Check if the model decided to call a function
    const functionCalls = result?.response?.functionCalls && result.response.functionCalls()
    if (functionCalls && functionCalls.length > 0) {
      return { success: true, functionCall: functionCalls[0], raw: result }
    }

    // Otherwise, return text
    const text = result && result.response && typeof result.response.text === 'function'
      ? result.response.text()
      : JSON.stringify(result)
    return { success: true, text, raw: result }
  } catch (err) {
    // Provide structured error info to caller for diagnostics
    if (err instanceof GoogleGenerativeAIFetchError) {
      return {
        success: false,
        error: 'fetch_error',
        status: err.status || null,
        message: err.message,
        details: err.errorDetails || null,
      }
    }
    return { success: false, error: 'unknown', message: err && err.message }
  }
}

export function hasKey() {
  return Boolean(API_KEY)
}

export function getKeyDiagnostics() {
  return {
    hasKey: hasKey(),
    keyMask: maskKey(API_KEY),
    model: MODEL,
    initialized: Boolean(model),
  }
}

export async function checkKeyWithTestCall(timeoutMs = 8000) {
  if (!model) return { ok: false, error: 'model_not_initialized' }
  try {
    const chat = model.startChat()
    // lightweight test message
    const res = await Promise.race([
      chat.sendMessage('ping'),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs))
    ])
    const text = res && res.response && typeof res.response.text === 'function'
      ? res.response.text()
      : JSON.stringify(res)
    return { ok: true, text, raw: res }
  } catch (err) {
    if (err instanceof GoogleGenerativeAIFetchError) {
      return { ok: false, status: err.status || null, message: err.message, details: err.errorDetails || null }
    }
    return { ok: false, message: err && err.message }
  }
}
