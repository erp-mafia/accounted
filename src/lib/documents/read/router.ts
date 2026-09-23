import { extractSinglePagePdf, readPdfTextLayer } from './pdf'
import { readOfficeDocument } from './office'
import { readTextDocument } from './text'
import { readImageWithModel, transcribeWithModel } from './vision'
import { fitImageForModel } from './image'
import { readerForMime, type ModelSkipReason, type ReadOptions, type ReadOutcome, type ReadPage } from './types'

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
    let partial: ModelSkipReason | undefined
    let modelPages = 0
    for (const pageNo of local.pagesNeedingVision) {
      if (!opts.allowModel) { partial = 'ai_gated'; break }
      if (opts.maxModelPages != null && modelPages >= opts.maxModelPages) { partial = 'budget'; break }
      const single = await extractSinglePagePdf(bytes, pageNo)
      const out = await transcribeWithModel({ kind: 'pdf', data: single, fileName: `page-${pageNo}.pdf` }, { tier: opts.tier })
      if (!out.ok) { partial = 'ai_unconfigured'; break }
      modelPages++
      if (out.text) pages.push({ pageNo, text: out.text, reader: 'claude_vision', hasTextLayer: false })
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
