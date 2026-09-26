import { extractSinglePagePdf, readPdfTextLayer } from './pdf'
import { readOfficeDocument } from './office'
import { readTextDocument } from './text'
import { readImageWithModel, transcribeWithModel } from './vision'
import { fitImageForModel } from './image'
import { readerForMime, type ModelSkipReason, type ReadOptions, type ReadOutcome, type ReadPage } from './types'

/** How many pages the model reads at once for one document. */
const MODEL_PAGE_CONCURRENCY = 3

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/**
 * Decide how a document is read and read it. Text layers first (local, free,
 * with word boxes), the model only for scanned pages and photos.
 */
export async function readDocumentBytes(bytes: Buffer, mimeType: string | null | undefined, opts: ReadOptions = { allowModel: true }): Promise<ReadOutcome> {
  const reader = readerForMime(mimeType)
  if (reader === null) return { ok: false, skipped: 'unsupported_mime' }
  if (reader === 'structured') return { ok: false, skipped: 'structured' }
  if (bytes.length === 0) return { ok: false, skipped: 'empty' }

  if (reader === 'pdf_text') {
    const local = await readPdfTextLayer(bytes)
    const pages: ReadPage[] = [...local.pages]
    // Scanned pages first, then pictures inside text pages (a table pasted as an image); a budget takes them in that order.
    const candidates = [...local.pagesNeedingVision.map((pageNo) => ({ pageNo, picture: false })), ...(local.pagesWithImages ?? []).map((pageNo) => ({ pageNo, picture: true }))]
    let partial: ModelSkipReason | undefined
    let wanted = candidates
    if (candidates.length > 0 && !opts.allowModel) {
      partial = 'ai_gated'
      wanted = []
    } else if (opts.maxModelPages != null && candidates.length > opts.maxModelPages) {
      partial = 'budget'
      wanted = candidates.slice(0, opts.maxModelPages)
    }
    // The model reads pages a few at a time: one after the other, a 20-page scan was a minute-long wait.
    const read = await mapLimit(wanted, MODEL_PAGE_CONCURRENCY, async (c) => {
      const single = await extractSinglePagePdf(bytes, c.pageNo)
      return { ...c, out: await transcribeWithModel({ kind: 'pdf', data: single, fileName: `page-${c.pageNo}.pdf` }, { tier: opts.tier }) }
    })
    for (const { pageNo, picture, out } of read) {
      if (!out.ok) {
        partial = 'ai_unconfigured'
        continue
      }
      if (!out.text) continue
      if (picture) {
        // The text layer stays until the model has read the whole page.
        const at = pages.findIndex((p) => p.pageNo === pageNo)
        if (at >= 0) pages[at] = { ...pages[at], text: out.text, reader: 'claude_vision', hasTextLayer: true }
      } else {
        pages.push({ pageNo, text: out.text, reader: 'claude_vision', hasTextLayer: false })
      }
    }
    pages.sort((a, b) => a.pageNo - b.pageNo)
    // Text pages are worth keeping on their own; the scanned ones wait for the model.
    if (pages.length === 0) return { ok: false, skipped: partial ?? 'empty' }
    const readerUsed = local.pages.length > 0 ? 'pdf_text' : 'claude_vision'
    return { ok: true, pages, reader: readerUsed, pageCount: local.pageCount, ...(partial ? { partial } : {}) }
  }

  if (reader === 'claude_vision') {
    if (!opts.allowModel) return { ok: false, skipped: 'ai_gated' }
    const fitted = await fitImageForModel(bytes, mimeType!)
    if (!fitted) return { ok: false, skipped: 'unsupported_mime' }
    const out = await readImageWithModel(fitted.bytes, fitted.mediaType, { tier: opts.tier })
    if (!out.ok) return { ok: false, skipped: 'ai_unconfigured' }
    if (out.pages.length === 0) return { ok: false, skipped: 'empty' }
    return { ok: true, pages: out.pages, reader: 'claude_vision', pageCount: 1 }
  }

  if (reader === 'office') {
    const pages = await readOfficeDocument(bytes)
    if (pages.length === 0) return { ok: false, skipped: 'empty' }
    return { ok: true, pages, reader: 'office', pageCount: pages.length }
  }

  const pages = readTextDocument(bytes, mimeType!)
  if (pages.length === 0) return { ok: false, skipped: 'empty' }
  return { ok: true, pages, reader, pageCount: 1 }
}
