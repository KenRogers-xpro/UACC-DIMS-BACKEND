// Standalone child-process worker for PDF -> PNG rasterization.
//
// Why this exists as a separate process rather than a plain function in
// textExtraction.js: pdf-parse and pdf-to-png-converter each bundle their
// own (different) copy of pdfjs-dist. Node.js's PDF.js build registers
// global polyfills (DOMMatrix, ImageData, Path2D, a "fake worker" for the
// no-real-Worker Node environment) as side effects of being *used*, not
// just imported. Once pdf-parse's copy has actually parsed a PDF in a
// process, pdf-to-png-converter's copy in that same process fails at
// render time — first with a Path2D/canvas type error, and once that's
// papered over by deleting the polyfilled globals, with
// "API version does not match Worker version", because the fake-worker
// state pdf-parse's pdfjs-dist spun up doesn't fully clear via
// `delete globalThis.x` (confirmed by direct testing — this isn't a
// theoretical concern). Two different versions of a heavily-stateful,
// singleton-per-process library in the same process is the actual bug;
// process isolation sidesteps it entirely rather than chasing every global
// pdfjs-dist touches.
//
// Protocol: raw PDF bytes on stdin. On success, a JSON array of
// { pageNumber, base64 } on stdout and exit 0. On failure, an error
// message on stderr and non-zero exit.

import { pdfToPng } from 'pdf-to-png-converter'

// Kept in sync with OCR_PDF_MAX_PAGES / OCR_RENDER_DPI in textExtraction.js
// — duplicated here because this file must have zero imports from that
// module (importing it would pull pdf-parse back into this process).
const OCR_PDF_MAX_PAGES = 100
const OCR_RENDER_DPI = 150

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks)
}

try {
  const pdfBuffer = await readStdin()
  if (!pdfBuffer || pdfBuffer.length === 0) {
    throw new Error('No PDF data received on stdin')
  }

  const pages = await pdfToPng(pdfBuffer, {
    viewportScale: OCR_RENDER_DPI / 72,
    pagesToProcess: Array.from({ length: OCR_PDF_MAX_PAGES }, (_, i) => i + 1),
    returnPageContent: true,
  })

  const out = pages
    .filter((p) => p.content)
    .map((p) => ({ pageNumber: p.pageNumber, base64: p.content.toString('base64') }))

  process.stdout.write(JSON.stringify(out))
  process.exit(0)
} catch (err) {
  process.stderr.write(String((err && err.stack) || err))
  process.exit(1)
}
