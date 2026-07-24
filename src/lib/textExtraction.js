import { PDFParse } from 'pdf-parse'
import mammoth from 'mammoth'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RASTERIZE_WORKER_PATH = path.join(__dirname, 'pdfRasterizeWorker.mjs')
const RASTERIZE_TIMEOUT_MS = 5 * 60 * 1000 // 100 pages worst-case; generous since ingestion is fire-and-forget

const MAX_TEXT_LENGTH = 200 * 1024 // 200KB cap (~50k tokens)

// A scanned/image PDF still "succeeds" at pdf-parse (no thrown error) but
// yields almost nothing — this is the giveaway that triggers the vision
// fallback below, not an empty-string check alone.
const SCANNED_PDF_TEXT_THRESHOLD = 100

// PDF page cap (100) and render DPI (150) live in pdfRasterizeWorker.mjs,
// not here — that worker runs in its own process specifically so this file
// never touches pdf-to-png-converter directly (see its header comment).

// Deliberately conservative daily safety valve against burning through the
// Gemini free-tier quota on OCR alone. Resets on redeploy (Render's free
// tier restarts often enough that this self-corrects in practice); if it
// drifts on a long-uptime day, that's the intended, conservative failure
// mode, not a bug.
//
// `?? 800`, not `|| 800` — a deliberately-configured 0 (disable OCR
// entirely without a redeploy) is falsy and would silently be overridden
// back to 800 by `||`.
const parsedOcrThreshold = parseInt(process.env.OCR_DAILY_RESERVE_THRESHOLD, 10)
const OCR_DAILY_RESERVE_THRESHOLD = Number.isFinite(parsedOcrThreshold) && parsedOcrThreshold >= 0
  ? parsedOcrThreshold
  : 800

let ocrCallsToday = 0
let ocrCounterDate = new Date().toDateString()

function checkAndResetCounter() {
  const today = new Date().toDateString()
  if (today !== ocrCounterDate) {
    ocrCallsToday = 0
    ocrCounterDate = today
  }
}

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || ''
// Same pin as ai.js/embeddings.js — DO NOT use '-latest' aliases (broke
// July 2026 when it silently moved to 3.5-flash with a 20 req/day limit).
// gemini-2.5-flash is restricted to pre-existing users as of mid-2026 and
// 404s for new API keys.
const VISION_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite'

let visionGenai, visionModel
try {
  visionGenai = new GoogleGenerativeAI(GEMINI_API_KEY)
  visionModel = visionGenai.getGenerativeModel({ model: VISION_MODEL })
} catch (err) {
  console.error('Failed to initialize Gemini Vision client:', err && err.message)
}

const OCR_PROMPT = 'Transcribe all text visible in this document image, verbatim. Preserve line breaks and general layout. Do not summarize, interpret, describe, or add commentary. If a section is illegible, write [illegible]. If the image contains no text, respond with only [no text found].'

function normalizeText(rawText) {
  if (!rawText) return ''
  // Strip footer markers from pdf-parse like "\n\n-- 1 of 1 --\n\n"
  const strippedFooter = rawText.replace(/\n\s*--\s*\d+\s*of\s*\d+\s*--\s*\n/gi, '\n')
  // Normalize whitespace: reduce consecutive spaces/tabs to a single space,
  // and reduce 3+ consecutive newlines to double newlines (paragraphs)
  return strippedFooter
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim()
}

function truncateText(text) {
  if (!text) return ''
  if (text.length <= MAX_TEXT_LENGTH) return text
  return text.slice(0, MAX_TEXT_LENGTH) + '\n...[truncated]'
}

async function parsePdf(buffer) {
  const parser = new PDFParse({ data: buffer })
  const result = await parser.getText()
  return {
    text: result?.text || null,
    pageCount: result?.total || result?.pages?.length || undefined,
  }
}

// Rasterizes a PDF to per-page PNG buffers in a genuinely separate child
// process — see pdfRasterizeWorker.mjs for why this can't just be a direct
// pdf-to-png-converter call in this file (pdf-parse, used above in the same
// process, corrupts its rendering).
function rasterizePdfPages(pdfBuffer) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RASTERIZE_WORKER_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const stdoutChunks = []
    const stderrChunks = []
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(new Error('PDF rasterization worker timed out'))
    }, RASTERIZE_TIMEOUT_MS)

    child.stdout.on('data', (d) => stdoutChunks.push(d))
    child.stderr.on('data', (d) => stderrChunks.push(d))

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(`PDF rasterization worker exited ${code}: ${Buffer.concat(stderrChunks).toString('utf-8').slice(0, 500)}`))
        return
      }
      try {
        const pages = JSON.parse(Buffer.concat(stdoutChunks).toString('utf-8'))
        resolve(pages.map((p) => Buffer.from(p.base64, 'base64')))
      } catch (err) {
        reject(new Error(`Failed to parse rasterization worker output: ${err.message}`))
      }
    })

    child.stdin.write(pdfBuffer)
    child.stdin.end()
  })
}

async function ocrSinglePage(buffer, mimeType) {
  const base64 = buffer.toString('base64')
  const result = await visionModel.generateContent([
    { inlineData: { mimeType, data: base64 } },
    OCR_PROMPT,
  ])
  const text = result?.response && typeof result.response.text === 'function' ? result.response.text() : ''
  return (text || '').trim()
}

// Gemini Vision OCR fallback for PDFs/images that text-based extraction
// can't handle (scanned documents, corrupt PDFs). PDFs are rasterized to
// PNG per page and each page transcribed independently; images go straight
// through as a single "page". A failed page never aborts the whole
// document — see the try/catch inside the loop.
export async function extractViaGeminiVision(buffer, mimeType) {
  checkAndResetCounter()
  if (ocrCallsToday >= OCR_DAILY_RESERVE_THRESHOLD) {
    console.error(`OCR daily reserve (${OCR_DAILY_RESERVE_THRESHOLD}) reached — skipping vision OCR, document ingests with metadata only`)
    return { text: null, extractionMethod: 'ocr_quota_exceeded', pageCount: 0 }
  }
  if (!visionModel) {
    console.error('Gemini Vision client not initialized — cannot OCR')
    return { text: null, extractionMethod: 'ocr_quota_exceeded', pageCount: 0 }
  }

  const normalizedMime = String(mimeType || '').toLowerCase()
  const isPdf = normalizedMime === 'application/pdf'

  let pageBuffers = []
  if (isPdf) {
    // Runs in an isolated child process — see rasterizePdfPages and
    // pdfRasterizeWorker.mjs. Pages above the document's actual count are
    // silently ignored by pdf-to-png-converter inside the worker, which is
    // what gives the "cap at 100, no warning" behavior with no separate
    // page-count lookup needed.
    pageBuffers = await rasterizePdfPages(buffer)
  } else {
    pageBuffers = [buffer]
  }

  const pageTexts = []
  for (let i = 0; i < pageBuffers.length; i++) {
    ocrCallsToday++ // per page processed, not per document — Gemini Vision quota is per-call
    try {
      const pageMime = isPdf ? 'image/png' : normalizedMime
      const text = await ocrSinglePage(pageBuffers[i], pageMime)
      pageTexts.push(text || '[no text found]')
    } catch (err) {
      console.error(`Gemini Vision OCR failed on page ${i + 1}:`, err && err.message)
      pageTexts.push('[extraction failed]')
    }
  }

  const combined = pageTexts
    .map((text, i) => `--- Page ${i + 1} ---\n\n${text}`)
    .join('\n\n')

  return {
    text: truncateText(combined) || null,
    extractionMethod: 'vision_ocr',
    pageCount: pageBuffers.length,
  }
}

export async function extractDocumentText({ buffer, mimeType = '', filename = '' }) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { text: null, extractionMethod: 'unsupported' }
  }

  const normalizedMime = String(mimeType || '').toLowerCase()
  const normalizedFilename = String(filename || '').toLowerCase()

  const isPdf = normalizedMime === 'application/pdf' || normalizedFilename.endsWith('.pdf')
  const isImage = normalizedMime.startsWith('image/')
  const isDocx = normalizedMime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    || normalizedMime === 'application/msword'
    || normalizedFilename.endsWith('.docx')
    || normalizedFilename.endsWith('.doc')

  const isPlain = normalizedMime.startsWith('text/')
    || normalizedMime === 'application/json'
    || ['.txt', '.md', '.json', '.csv', '.log'].some((ext) => normalizedFilename.endsWith(ext))

  if (isPdf) {
    try {
      const pdfData = await parsePdf(buffer)
      const cleaned = truncateText(normalizeText(pdfData.text))

      // Scanned/image PDF giveaway: near-empty extracted text despite the
      // PDF genuinely having pages. Falls through to vision silently.
      if ((!cleaned || cleaned.length < SCANNED_PDF_TEXT_THRESHOLD) && pdfData.pageCount > 0) {
        return await extractViaGeminiVision(buffer, 'application/pdf')
      }

      return {
        text: cleaned || null,
        extractionMethod: 'pdf',
        pageCount: pdfData.pageCount,
      }
    } catch (err) {
      console.error('PDF text extraction failed for file:', filename, err && err.message)
      // Corrupt/unparseable PDF — a lot of these are just scanned images
      // with a slightly malformed structure pdf-parse won't tolerate but
      // the rasterizer can. Fall through to vision rather than giving up.
      try {
        return await extractViaGeminiVision(buffer, 'application/pdf')
      } catch (visionErr) {
        console.error('Vision OCR fallback also failed for file:', filename, visionErr && visionErr.message)
        return { text: null, extractionMethod: 'unsupported' }
      }
    }
  }

  if (isImage) {
    try {
      return await extractViaGeminiVision(buffer, normalizedMime)
    } catch (err) {
      console.error('Vision OCR failed for image file:', filename, err && err.message)
      return { text: null, extractionMethod: 'unsupported' }
    }
  }

  if (isDocx) {
    try {
      const result = await mammoth.extractRawText({ buffer })
      const cleaned = truncateText(normalizeText(result.value))
      return {
        text: cleaned || null,
        extractionMethod: 'docx',
      }
    } catch (err) {
      console.error('DOCX text extraction failed for file:', filename, err && err.message)
      return { text: null, extractionMethod: 'docx' }
    }
  }

  if (isPlain) {
    try {
      const raw = buffer.toString('utf-8')
      const cleaned = truncateText(normalizeText(raw))
      return {
        text: cleaned || null,
        extractionMethod: 'plain',
      }
    } catch (err) {
      console.error('Plain text extraction failed for file:', filename, err && err.message)
      return { text: null, extractionMethod: 'plain' }
    }
  }

  return { text: null, extractionMethod: 'unsupported' }
}
