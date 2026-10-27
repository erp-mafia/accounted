import { describe, it, expect, vi, beforeEach } from 'vitest'

const extractMock = vi.fn()
vi.mock('../extract-invoice-fields', () => ({
  extractInvoiceFields: (...args: unknown[]) => extractMock(...args),
}))
const mirrorMock = vi.fn()
vi.mock('../mirror-extraction', () => ({
  mirrorExtractionToDocument: (...args: unknown[]) => mirrorMock(...args),
}))

import { extractAndMirror } from '../extract-and-mirror'

const input = { buffer: Buffer.from('pdf'), mimeType: 'application/pdf', fileName: 'f.pdf' }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('extractAndMirror', () => {
  it('mirrors exactly what the extraction answered and hands it back', async () => {
    const answer = { data: { supplier: { name: 'x' } }, rawText: '{}', model: 'm', skipped: null }
    extractMock.mockResolvedValue(answer)

    const result = await extractAndMirror('doc-1', input)

    expect(result).toBe(answer)
    expect(extractMock).toHaveBeenCalledWith(input)
    expect(mirrorMock).toHaveBeenCalledWith('doc-1', {
      data: answer.data,
      rawText: '{}',
      model: 'm',
      skipped: null,
      failure: null,
    })
  })

  it('passes a skip reason through and defaults absent fields to null', async () => {
    extractMock.mockResolvedValue({ data: {}, rawText: null, skipped: 'unsupported_media' })
    await extractAndMirror('doc-1', input)
    expect(mirrorMock).toHaveBeenCalledWith('doc-1', {
      data: {},
      rawText: null,
      model: null,
      skipped: 'unsupported_media',
      failure: null,
    })
  })

  it('passes a provider failure through so the stamp can say the provider was down', async () => {
    extractMock.mockResolvedValue({ data: {}, rawText: null, model: null, failure: 'provider_unavailable' })
    await extractAndMirror('doc-1', input)
    expect(mirrorMock).toHaveBeenCalledWith('doc-1', expect.objectContaining({ failure: 'provider_unavailable' }))
  })

  it('stamps nothing when the extraction throws, so the row keeps its reading', async () => {
    extractMock.mockRejectedValue(new Error('boom'))
    await expect(extractAndMirror('doc-1', input)).rejects.toThrow('boom')
    expect(mirrorMock).not.toHaveBeenCalled()
  })
})
