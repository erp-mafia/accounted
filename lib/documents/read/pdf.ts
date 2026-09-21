import { PDFDocument } from 'pdf-lib'
import { ReaderUnavailableError, type ReadPage, type WordBox } from './types'

/**
 * PDFs: the text layer is read with pdf.js (through unpdf, its serverless
 * build), page by page, with the position of every text run. A page with no
 * text layer is a scan: it is handed to the model as a single-page PDF
 * (Claude reads a PDF natively; no rasterizer). Pure JavaScript on purpose:
 * the native reader this replaced could not be loaded on the hosted runtime
 * (its Linux build needs glibc 2.35, Vercel has 2.34). Loaded lazily so the
 * client bundle and the tests that never touch PDFs stay free of it.
 */
export interface PdfReadResult {
  pages: ReadPage[]
  /** 1-based pages that need the model. */
  pagesNeedingVision: number[]
  pageCount: number
}

/**
 * Below this many non-space characters a page counts as a scan. A scanner's
 * stamp or a lone page number is not a text layer worth keeping instead of
 * the page itself. Measured on the trial set: every page the rule sends to
 * the model is a full-page image, and no text page falls under it.
 */
export const SCANNED_PAGE_MAX_CHARS = 16

type Unpdf = typeof import('unpdf')
let unpdf: Promise<Unpdf> | null = null
function loadUnpdf(): Promise<Unpdf> {
  unpdf ??= import('unpdf').catch((err) => {
    unpdf = null
    throw new ReaderUnavailableError('pdf_text', err)
  })
  return unpdf
}

interface TextItem {
  str: string
  transform: number[]
  width: number
  height: number
  hasEOL?: boolean
}

const round = (n: number) => Math.round(n * 10) / 10

export async function readPdfTextLayer(bytes: Buffer): Promise<PdfReadResult> {
  const { getDocumentProxy } = await loadUnpdf()
  // pdf.js takes ownership of the array it is given: hand it a copy, the caller still needs the bytes for the model.
  const doc = await getDocumentProxy(new Uint8Array(bytes))
  try {
    const pages: ReadPage[] = []
    const pagesNeedingVision: number[] = []
    for (let pageNo = 1; pageNo <= doc.numPages; pageNo++) {
      const page = await doc.getPage(pageNo)
      const viewport = page.getViewport({ scale: 1 })
      const content = await page.getTextContent()
      const items = (content.items as unknown[]).filter((it): it is TextItem => typeof (it as TextItem).str === 'string')
      const text = pageText(items)
      if (text.replace(/\s/g, '').length < SCANNED_PAGE_MAX_CHARS) {
        pagesNeedingVision.push(pageNo)
        continue
      }
      const words: WordBox[] = items
        .filter((it) => it.str.trim().length > 0)
        .map((it) => {
          const x = it.transform[4] ?? 0
          const baseline = it.transform[5] ?? 0
          const height = it.height || Math.abs(it.transform[3] ?? 0)
          // pdf.js reports the baseline from the page bottom; store a top-left origin.
          return { t: it.str, x0: round(x), y0: round(viewport.height - baseline - height), x1: round(x + it.width), y1: round(viewport.height - baseline) }
        })
      pages.push({
        pageNo,
        text,
        reader: 'pdf_text',
        hasTextLayer: true,
        words: words.length ? words : undefined,
        pageWidth: round(viewport.width),
        pageHeight: round(viewport.height),
      })
    }
    return { pages, pagesNeedingVision, pageCount: doc.numPages }
  } finally {
    // Frees the parsed document; the worker-less serverless build keeps everything in this process.
    await doc.loadingTask.destroy().catch(() => {})
  }
}

/** The page as lines: pdf.js marks the end of a printed line, and emits its own space runs inside one. */
function pageText(items: TextItem[]): string {
  let out = ''
  for (const it of items) {
    out += it.str
    if (it.hasEOL) out += '\n'
  }
  return out
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** A single page as its own PDF, for the model. */
export async function extractSinglePagePdf(bytes: Buffer, pageNo: number): Promise<Buffer> {
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true })
  const out = await PDFDocument.create()
  const [page] = await out.copyPages(src, [pageNo - 1])
  out.addPage(page)
  return Buffer.from(await out.save())
}
