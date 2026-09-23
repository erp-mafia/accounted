import { ReaderUnavailableError, type ReadPage } from './types'

/** Office, OpenDocument, RTF and CSV files: AnyDoc converts to Markdown locally. One page, no boxes. */
export async function readOfficeDocument(bytes: Buffer): Promise<ReadPage[]> {
  const anydoc = await import('@firecrawl/anydoc').catch((err) => {
    throw new ReaderUnavailableError('office', err)
  })
  const md = Buffer.from(await anydoc.toMarkdownBytes(new Uint8Array(bytes))).toString('utf8').trim()
  if (!md) return []
  return [{ pageNo: 1, text: md, reader: 'office', hasTextLayer: true }]
}
