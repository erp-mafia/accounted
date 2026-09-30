import { describe, it, expect, vi, beforeEach } from 'vitest'

const extractFromDocument = vi.fn()
vi.mock('@/lib/ai', () => ({ getAiService: () => ({ extractFromDocument }) }))

import { isReaderCommentary, readImageWithModel, transcribeWithModel, NO_TEXT } from '../vision'

beforeEach(() => vi.clearAllMocks())

describe('isReaderCommentary: the reader talking about the page is not the page', () => {
  it('drops NO_TEXT and the short sentences seen in prod', () => {
    for (const t of [
      NO_TEXT,
      'The page is blank.',
      'The page appears to be blank or unreadable (no text content, only a graphic image with circles and a dot).',
      "I'm not able to transcribe this image as it contains a QR code rather than printed text.",
      'The image shows a pair of dark gray work pants with red accent details. There is no text.',
      'This page does not contain any accounting document text - it shows a photograph of a keyboard key.',
      'Sidan verkar vara tom.',
    ]) expect(isReaderCommentary(t)).toBe(true)
  })

  it('keeps real text, even text that starts like a sentence about the document', () => {
    expect(isReaderCommentary('Kvitto\nBröd Salt Bageri AB\nTotalt | 291,14 kr')).toBe(false)
    expect(isReaderCommentary(`This invoice is issued by Vercel Inc.\n${'Line item | 20,00\n'.repeat(30)}`)).toBe(false)
  })
})

describe('transcribeWithModel', () => {
  it('returns no text for commentary, so the page is stored as unreadable instead of as a sentence', async () => {
    extractFromDocument.mockResolvedValue({ ok: true, text: 'The page appears to be blank.' })
    expect(await transcribeWithModel({ kind: 'pdf', data: Buffer.from('x') })).toEqual({ ok: true, text: '' })
    extractFromDocument.mockResolvedValue({ ok: true, text: NO_TEXT })
    expect(await readImageWithModel(Buffer.from('x'), 'image/png')).toEqual({ ok: true, pages: [] })
  })

  it('asks for NO_TEXT in the system prompt and passes real text through', async () => {
    extractFromDocument.mockResolvedValue({ ok: true, text: '  Faktura 107\nSumma 23 080 kr  ' })
    expect(await transcribeWithModel({ kind: 'pdf', data: Buffer.from('x') })).toEqual({ ok: true, text: 'Faktura 107\nSumma 23 080 kr' })
    expect(extractFromDocument.mock.calls[0][0].system).toContain(NO_TEXT)
  })
})
