import './env.js'

import { GoogleGenerativeAI, GoogleGenerativeAIFetchError } from '@google/generative-ai'
import dotenv from 'dotenv'

// ensure env is loaded when this module is imported directly by scripts
dotenv.config()

const API_KEY = process.env.GEMINI_API_KEY || ''
const MODEL = process.env.GEMINI_MODEL || 'text-bison-001'

let genai, model
try {
  // prefer object form if supported, fall back to string
  try {
    genai = new GoogleGenerativeAI({ apiKey: API_KEY })
  } catch (e) {
    genai = new GoogleGenerativeAI(API_KEY)
  }
  model = genai.getGenerativeModel({ model: MODEL })
} catch (err) {
  console.error('Failed to initialize GoogleGenerativeAI client:', err && err.message)
}

function maskKey(k = '') {
  if (!k) return '<empty>'
  if (k.length < 8) return `${k.slice(0,2)}...${k.slice(-2)}`
  return `${k.slice(0,4)}...${k.slice(-4)}`
}

export async function generateFromMessages(messages = []) {
  if (!model) throw new Error('AI model not initialized')
  const prompt = messages.map(m => `${m.role}: ${m.text}`).join('\n')
  try {
    const chat = model.startChat()
    const result = await chat.sendMessage(prompt)
    // SDK provides helpers: response.text()
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
