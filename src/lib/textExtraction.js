import { PDFParse } from 'pdf-parse'
import mammoth from 'mammoth'

const MAX_TEXT_LENGTH = 200 * 1024 // 200KB cap (~50k tokens)

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

export async function extractDocumentText({ buffer, mimeType = '', filename = '' }) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { text: null, extractionMethod: 'unsupported' }
  }

  const normalizedMime = String(mimeType || '').toLowerCase()
  const normalizedFilename = String(filename || '').toLowerCase()

  const isPdf = normalizedMime === 'application/pdf' || normalizedFilename.endsWith('.pdf')
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
      return {
        text: cleaned || null,
        extractionMethod: 'pdf',
        pageCount: pdfData.pageCount,
      }
    } catch (err) {
      console.error('PDF text extraction failed for file:', filename, err && err.message)
      return { text: null, extractionMethod: 'pdf' }
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
