import { beforeEach, describe, expect, it, vi } from 'vitest'

const toMarkdownBytes = vi.hoisted(() => vi.fn())
vi.mock('@firecrawl/anydoc', () => ({ toMarkdownBytes }))

import { readOfficeDocument } from '../office'

beforeEach(() => {
  vi.clearAllMocks()
  toMarkdownBytes.mockResolvedValue(new TextEncoder().encode('| Datum | Belopp |\n| --- | --- |\n| 2026-10-01 | -125,50 |\n'))
})

describe('readOfficeDocument', () => {
  it('names the format for a CSV, which has no signature to be detected by', async () => {
    const pages = await readOfficeDocument(Buffer.from('Datum;Belopp\n2026-10-01;-125,50\n'), 'text/csv')
    expect(toMarkdownBytes).toHaveBeenCalledWith(expect.any(Uint8Array), 'csv')
    expect(pages).toEqual([{ pageNo: 1, text: '| Datum | Belopp |\n| --- | --- |\n| 2026-10-01 | -125,50 |', reader: 'office', hasTextLayer: true }])
  })

  it('leaves the format to detection for files that carry a signature', async () => {
    await readOfficeDocument(Buffer.from('PK'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    expect(toMarkdownBytes).toHaveBeenCalledWith(expect.any(Uint8Array), null)
  })
})
