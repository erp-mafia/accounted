import { PDFDocument } from 'pdf-lib'
import type { ReadPage, WordBox } from './types'

/**
 * PDFs: pdf-inspector decides text-based versus scanned per page and reads
 * the text layer with word positions. Pages it flags for OCR are handed to
 * the model as single-page PDFs (Claude reads a PDF natively; no rasterizer).
 * The native module is loaded lazily so the client bundle and the tests that
 * never touch PDFs stay free of it.
 */
export interface PdfReadResult {
  pages: ReadPage[]
  /** 1-based pages that need the model. */
  pagesNeedingVision: number[]
  pageCount: number
  pdfType: string
}

type Inspector = typeof import('@firecrawl/pdf-inspector')
let inspector: Promise<Inspector> | null = null
function loadInspector(): Promise<Inspector> {
  inspector ??= import('@firecrawl/pdf-inspector')
  return inspector
}

export async function readPdfTextLayer(bytes: Buffer): Promise<PdfReadResult> {
  const pi = await loadInspector()
  const markdown = pi.extractPagesMarkdown(bytes)
  let items: Array<{ text: string; x: number; y: number; width: number; height: number; page: number }> = []
  try {
    items = pi.extractTextWithPositions(bytes)
  } catch {
    items = []
  }
  const sizes = await pageSizes(bytes)
  const needsOcr = new Set(markdown.pagesNeedingOcr)
  const pages: ReadPage[] = []
  for (const p of markdown.pages) {
    const pageNo = p.page + 1
    if (needsOcr.has(pageNo) || p.needsOcr) continue
    const height = sizes[pageNo - 1]?.height
    const words: WordBox[] = items
      .filter((it) => it.page === pageNo && it.text.trim().length > 0)
      .map((it) => ({
        t: it.text,
        x0: round(it.x),
        // pdf-inspector reports the baseline from the page bottom; store a top-left origin.
        y0: round(height != null ? height - it.y - it.height : it.y),
        x1: round(it.x + it.width),
        y1: round(height != null ? height - it.y : it.y + it.height),
      }))
    pages.push({
      pageNo,
      text: p.markdown,
      reader: 'pdf_text',
      hasTextLayer: true,
      words: words.length ? words : undefined,
      pageWidth: sizes[pageNo - 1]?.width,
      pageHeight: height,
    })
  }
  const pageCount = Math.max(markdown.pages.length, sizes.length)
  const pagesNeedingVision = Array.from({ length: pageCount }, (_, i) => i + 1).filter((n) => needsOcr.has(n) || markdown.pages.find((p) => p.page + 1 === n)?.needsOcr)
  return { pages, pagesNeedingVision, pageCount, pdfType: pi.classifyPdf(bytes).pdfType as string }
}

async function pageSizes(bytes: Buffer): Promise<Array<{ width: number; height: number }>> {
  try {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true })
    return doc.getPages().map((p) => p.getSize())
  } catch {
    return []
  }
}

/** A single page as its own PDF, for the model. */
export async function extractSinglePagePdf(bytes: Buffer, pageNo: number): Promise<Buffer> {
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true })
  const out = await PDFDocument.create()
  const [page] = await out.copyPages(src, [pageNo - 1])
  out.addPage(page)
  return Buffer.from(await out.save())
}

const round = (n: number) => Math.round(n * 10) / 10
