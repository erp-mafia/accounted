import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../pdf', () => ({ readPdfTextLayer: vi.fn(), extractSinglePagePdf: vi.fn() }))
vi.mock('../office', () => ({ readOfficeDocument: vi.fn() }))
vi.mock('../vision', () => ({ readImageWithModel: vi.fn(), transcribeWithModel: vi.fn() }))
vi.mock('../image', () => ({ fitImageForModel: vi.fn(async (bytes: Buffer, mimeType: string) => ({ bytes, mediaType: mimeType })) }))

import { readDocumentBytes } from '../router'
import { readPdfTextLayer, extractSinglePagePdf } from '../pdf'
import { readOfficeDocument } from '../office'
import { readImageWithModel, transcribeWithModel } from '../vision'
import { fitImageForModel } from '../image'

const mock = <T>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

describe('readDocumentBytes', () => {
  beforeEach(() => vi.clearAllMocks())

  it('skips structured archives and unknown types without reading', async () => {
    expect(await readDocumentBytes(Buffer.from('<x/>'), 'application/xml')).toEqual({ ok: false, skipped: 'structured' })
    expect(await readDocumentBytes(Buffer.from('zzz'), 'application/zip')).toEqual({ ok: false, skipped: 'unsupported_mime' })
    expect(await readDocumentBytes(Buffer.alloc(0), 'application/pdf')).toEqual({ ok: false, skipped: 'empty' })
    expect(readPdfTextLayer).not.toHaveBeenCalled()
  })

  it('reads a text PDF locally and never calls the model', async () => {
    mock(readPdfTextLayer).mockResolvedValue({
      pages: [{ pageNo: 1, text: 'Hyra 19 300 kr', reader: 'pdf_text', hasTextLayer: true }],
      pagesNeedingVision: [],
      pageCount: 1,
      pdfType: 'TextBased',
    })
    const out = await readDocumentBytes(Buffer.from('%PDF-'), 'application/pdf')
    expect(out).toMatchObject({ ok: true, reader: 'pdf_text', pageCount: 1 })
    expect(transcribeWithModel).not.toHaveBeenCalled()
  })

  it('sends only the scanned pages of a mixed PDF to the model and merges in page order', async () => {
    mock(readPdfTextLayer).mockResolvedValue({
      pages: [
        { pageNo: 1, text: 'Skuldebrev', reader: 'pdf_text', hasTextLayer: true },
        { pageNo: 3, text: 'Villkor', reader: 'pdf_text', hasTextLayer: true },
      ],
      pagesNeedingVision: [2],
      pageCount: 3,
      pdfType: 'Mixed',
    })
    mock(extractSinglePagePdf).mockResolvedValue(Buffer.from('%PDF-page2'))
    mock(transcribeWithModel).mockResolvedValue({ ok: true, text: 'Underskrift' })
    const out = await readDocumentBytes(Buffer.from('%PDF-'), 'application/pdf')
    expect(transcribeWithModel).toHaveBeenCalledTimes(1)
    expect(extractSinglePagePdf).toHaveBeenCalledWith(expect.any(Buffer), 2)
    expect(out.ok && out.pages.map((p) => [p.pageNo, p.reader])).toEqual([
      [1, 'pdf_text'],
      [2, 'claude_vision'],
      [3, 'pdf_text'],
    ])
  })

  it('reads a picture page whole with the model and keeps its text layer when the model may not', async () => {
    const local = {
      pages: [
        { pageNo: 1, text: 'Shareholders Agreement', reader: 'pdf_text', hasTextLayer: true },
        { pageNo: 2, text: 'Schedule 1.2 - Cap Table', reader: 'pdf_text', hasTextLayer: true },
      ],
      pagesNeedingVision: [],
      pagesWithImages: [2],
      pageCount: 2,
    }
    mock(readPdfTextLayer).mockResolvedValue(local)
    mock(extractSinglePagePdf).mockResolvedValue(Buffer.from('%PDF-page2'))
    mock(transcribeWithModel).mockResolvedValue({ ok: true, text: 'Schedule 1.2 - Cap Table\nJakob Wennberg 60 000' })
    const read = await readDocumentBytes(Buffer.from('%PDF-'), 'application/pdf')
    expect(extractSinglePagePdf).toHaveBeenCalledWith(expect.any(Buffer), 2)
    expect(read.ok && read.pages.map((p) => [p.pageNo, p.reader, p.text])).toEqual([
      [1, 'pdf_text', 'Shareholders Agreement'],
      [2, 'claude_vision', 'Schedule 1.2 - Cap Table\nJakob Wennberg 60 000'],
    ])

    vi.clearAllMocks()
    mock(readPdfTextLayer).mockResolvedValue(local)
    const gated = await readDocumentBytes(Buffer.from('%PDF-'), 'application/pdf', { allowModel: false })
    expect(transcribeWithModel).not.toHaveBeenCalled()
    // Nothing is lost: the text layer stays, and the partial read is retried when the model may.
    expect(gated).toMatchObject({ ok: true, reader: 'pdf_text', partial: 'ai_gated' })
    expect(gated.ok && gated.pages.map((p) => p.text)).toEqual(['Shareholders Agreement', 'Schedule 1.2 - Cap Table'])
  })

  it('stops at the page cap and says so, keeping what it read', async () => {
    mock(readPdfTextLayer).mockResolvedValue({ pages: [], pagesNeedingVision: [1, 2, 3], pageCount: 3, pdfType: 'Scanned' })
    mock(extractSinglePagePdf).mockResolvedValue(Buffer.from('x'))
    mock(transcribeWithModel).mockResolvedValue({ ok: true, text: 'Sida' })
    const out = await readDocumentBytes(Buffer.from('%PDF-'), 'application/pdf', { allowModel: true, maxModelPages: 1 })
    expect(transcribeWithModel).toHaveBeenCalledTimes(1)
    expect(out).toMatchObject({ ok: true, reader: 'claude_vision', pageCount: 3, partial: 'budget' })
    expect(out.ok && out.pages.map((p) => p.pageNo)).toEqual([1])
  })

  it('hands the tier to the model for scanned pages and photos', async () => {
    mock(readPdfTextLayer).mockResolvedValue({ pages: [], pagesNeedingVision: [1], pageCount: 1, pdfType: 'Scanned' })
    mock(extractSinglePagePdf).mockResolvedValue(Buffer.from('x'))
    mock(transcribeWithModel).mockResolvedValue({ ok: true, text: 'Sida' })
    await readDocumentBytes(Buffer.from('%PDF-'), 'application/pdf', { allowModel: true, tier: 'cheap' })
    expect(transcribeWithModel).toHaveBeenCalledWith(expect.objectContaining({ kind: 'pdf' }), { tier: 'cheap' })
    mock(readImageWithModel).mockResolvedValue({ ok: true, pages: [{ pageNo: 1, text: 'Kvitto', reader: 'claude_vision', hasTextLayer: false }] })
    await readDocumentBytes(Buffer.from('img'), 'image/jpeg', { allowModel: true })
    expect(readImageWithModel).toHaveBeenCalledWith(expect.any(Buffer), 'image/jpeg', { tier: undefined })
  })

  it('keeps the text pages when the model is unconfigured for the scanned ones', async () => {
    mock(readPdfTextLayer).mockResolvedValue({
      pages: [{ pageNo: 1, text: 'Sida 1', reader: 'pdf_text', hasTextLayer: true }],
      pagesNeedingVision: [2],
      pageCount: 2,
      pdfType: 'Mixed',
    })
    mock(extractSinglePagePdf).mockResolvedValue(Buffer.from('x'))
    mock(transcribeWithModel).mockResolvedValue({ ok: false, skipped: 'ai_unconfigured' })
    const out = await readDocumentBytes(Buffer.from('%PDF-'), 'application/pdf')
    expect(out.ok && out.pages.length).toBe(1)
    expect(out).toMatchObject({ partial: 'ai_unconfigured' })
  })

  it('reports ai_unconfigured for a fully scanned PDF and for a photo when no model is configured', async () => {
    mock(readPdfTextLayer).mockResolvedValue({ pages: [], pagesNeedingVision: [1], pageCount: 1, pdfType: 'Scanned' })
    mock(extractSinglePagePdf).mockResolvedValue(Buffer.from('x'))
    mock(transcribeWithModel).mockResolvedValue({ ok: false, skipped: 'ai_unconfigured' })
    expect(await readDocumentBytes(Buffer.from('%PDF-'), 'application/pdf')).toEqual({ ok: false, skipped: 'ai_unconfigured' })
    mock(readImageWithModel).mockResolvedValue({ ok: false, skipped: 'ai_unconfigured' })
    expect(await readDocumentBytes(Buffer.from('jpg'), 'image/jpeg')).toEqual({ ok: false, skipped: 'ai_unconfigured' })
  })

  it('reads photos with the model and Office files locally', async () => {
    mock(readImageWithModel).mockResolvedValue({
      ok: true,
      pages: [{ pageNo: 1, text: 'Kvitto 673 kr', reader: 'claude_vision', hasTextLayer: false }],
    })
    expect(await readDocumentBytes(Buffer.from('jpg'), 'image/jpeg')).toMatchObject({ ok: true, reader: 'claude_vision' })
    mock(readOfficeDocument).mockResolvedValue([{ pageNo: 1, text: '# Avtal', reader: 'office', hasTextLayer: true }])
    expect(await readDocumentBytes(Buffer.from('PK'), DOCX)).toMatchObject({ ok: true, reader: 'office' })
    expect(readImageWithModel).toHaveBeenCalledTimes(1)
  })

  it('hands the model the fitted photo, and skips a HEIC the build cannot decode', async () => {
    const fitted = Buffer.from('small-jpeg')
    mock(fitImageForModel).mockResolvedValueOnce({ bytes: fitted, mediaType: 'image/jpeg' })
    mock(readImageWithModel).mockResolvedValue({ ok: true, pages: [{ pageNo: 1, text: 'Beslut', reader: 'claude_vision', hasTextLayer: false }] })
    expect(await readDocumentBytes(Buffer.from('big-heic'), 'image/heic')).toMatchObject({ ok: true, reader: 'claude_vision' })
    expect(readImageWithModel).toHaveBeenCalledWith(fitted, 'image/jpeg', { tier: undefined })
    mock(fitImageForModel).mockResolvedValueOnce(null)
    expect(await readDocumentBytes(Buffer.from('big-heic'), 'image/heic')).toEqual({ ok: false, skipped: 'unsupported_mime' })
    expect(readImageWithModel).toHaveBeenCalledTimes(1)
  })

  it('never calls the model when the company is outside the rollout, and says so', async () => {
    mock(readPdfTextLayer).mockResolvedValue({
      pages: [{ pageNo: 1, text: 'Sida 1', reader: 'pdf_text', hasTextLayer: true }],
      pagesNeedingVision: [2],
      pageCount: 2,
      pdfType: 'Mixed',
    })
    const mixed = await readDocumentBytes(Buffer.from('%PDF-'), 'application/pdf', { allowModel: false })
    expect(mixed).toMatchObject({ ok: true, partial: 'ai_gated' })
    expect(mixed.ok && mixed.pages.length).toBe(1)
    expect(await readDocumentBytes(Buffer.from('jpg'), 'image/jpeg', { allowModel: false })).toEqual({ ok: false, skipped: 'ai_gated' })
    expect(transcribeWithModel).not.toHaveBeenCalled()
    expect(readImageWithModel).not.toHaveBeenCalled()
  })

  it('reads HTML mail bodies as text without any reader', async () => {
    const out = await readDocumentBytes(Buffer.from('<html><body><p>Faktura <b>1 249</b> kr</p></body></html>'), 'text/html')
    expect(out).toMatchObject({ ok: true, reader: 'html' })
    expect(out.ok && out.pages[0].text).toBe('Faktura 1 249 kr')
  })
})
