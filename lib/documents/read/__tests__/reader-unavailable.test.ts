import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * The native readers load a platform binding at runtime. When the deployed
 * function ships without it, the loader's failure must surface as
 * ReaderUnavailableError (an outcome about the environment), never as an
 * ordinary read failure that would be stamped on the document.
 */
describe('native reader loaders', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('pdf: a reader that cannot be loaded is ReaderUnavailableError, and the next call tries again', async () => {
    vi.doMock('unpdf', () => {
      throw new Error('Cannot load module')
    })
    const { readPdfTextLayer } = await import('../pdf')
    const { ReaderUnavailableError } = await import('../types')
    await expect(readPdfTextLayer(Buffer.from('%PDF-1.4'))).rejects.toBeInstanceOf(ReaderUnavailableError)
    // The failed load is not cached: a later call loads again (and names the reader that was missing).
    await expect(readPdfTextLayer(Buffer.from('%PDF-1.4'))).rejects.toThrow(/^pdf_text: /)
    vi.doUnmock('unpdf')
  })

  it('office: the same for AnyDoc', async () => {
    vi.doMock('@firecrawl/anydoc', () => {
      throw new Error('Cannot find native binding')
    })
    const { readOfficeDocument } = await import('../office')
    const { ReaderUnavailableError } = await import('../types')
    await expect(readOfficeDocument(Buffer.from('x'))).rejects.toBeInstanceOf(ReaderUnavailableError)
    vi.doUnmock('@firecrawl/anydoc')
  })
})
