import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import {
  slicePdfForExtraction,
  maxPagesForAutoExtract,
  MAX_PAGES_FOR_AUTO_EXTRACT,
  MAX_PAGES_FOR_AUTO_EXTRACT_NATIVE,
} from '@/extensions/general/invoice-inbox/lib/upload-and-extract'

// Pages get index-encoded widths (500 + i) so tests can assert exactly WHICH
// source pages survived the slice, not just how many.
async function makePdf(pageCount: number): Promise<ArrayBuffer> {
  const pdf = await PDFDocument.create()
  for (let i = 0; i < pageCount; i++) pdf.addPage([500 + i, 700])
  const bytes = await pdf.save()
  const out = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(out).set(bytes)
  return out
}

async function pageWidths(buffer: ArrayBuffer): Promise<number[]> {
  const pdf = await PDFDocument.load(buffer)
  return Array.from({ length: pdf.getPageCount() }, (_, i) =>
    Math.round(pdf.getPage(i).getSize().width)
  )
}

describe('slicePdfForExtraction', () => {
  it('keeps the first maxPages-1 pages plus the LAST page (where totals sit)', async () => {
    const sliced = await slicePdfForExtraction(await makePdf(10), 8)
    expect(sliced).not.toBeNull()
    // Pages 0..6 plus page 9: widths 500..506 and 509.
    expect(await pageWidths(sliced!)).toEqual([500, 501, 502, 503, 504, 505, 506, 509])
  })

  it('keeps the last page also on the old 3-page budget', async () => {
    const sliced = await slicePdfForExtraction(await makePdf(5), 3)
    expect(await pageWidths(sliced!)).toEqual([500, 501, 504])
  })

  it('copies the document unchanged when it fits the budget', async () => {
    const sliced = await slicePdfForExtraction(await makePdf(3), 8)
    expect(await pageWidths(sliced!)).toEqual([500, 501, 502])
  })

  it('returns null on an unparseable buffer', async () => {
    const garbage = new TextEncoder().encode('not a pdf').buffer as ArrayBuffer
    expect(await slicePdfForExtraction(garbage, 8)).toBeNull()
  })
})

describe('maxPagesForAutoExtract', () => {
  const ENV = [
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'ANTHROPIC_API_KEY',
    'AI_PROVIDER',
    'AI_BASE_URL',
    'AI_API_KEY',
    'AI_MODEL',
    'AI_PDF_MODE',
  ] as const
  let saved: Record<string, string | undefined> = {}
  beforeEach(() => {
    saved = {}
    for (const k of ENV) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
  })
  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('uses the higher budget when the backend reads PDFs natively (Claude)', () => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIAEXAMPLE'
    process.env.AWS_SECRET_ACCESS_KEY = 'secret'
    expect(maxPagesForAutoExtract()).toBe(MAX_PAGES_FOR_AUTO_EXTRACT_NATIVE)
  })

  it('keeps the conservative budget on a rasterizing OpenAI-compatible backend', () => {
    process.env.AI_PROVIDER = 'openai-compatible'
    process.env.AI_BASE_URL = 'http://localhost:8000/v1'
    process.env.AI_MODEL = 'some-model'
    expect(maxPagesForAutoExtract()).toBe(MAX_PAGES_FOR_AUTO_EXTRACT)
  })

  it('follows AI_PDF_MODE=native on an OpenAI-compatible backend', () => {
    process.env.AI_PROVIDER = 'openai-compatible'
    process.env.AI_BASE_URL = 'http://localhost:8000/v1'
    process.env.AI_MODEL = 'some-model'
    process.env.AI_PDF_MODE = 'native'
    expect(maxPagesForAutoExtract()).toBe(MAX_PAGES_FOR_AUTO_EXTRACT_NATIVE)
  })
})
