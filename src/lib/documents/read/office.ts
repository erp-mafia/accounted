import type { toMarkdownBytes } from '@firecrawl/anydoc'
import { ReaderUnavailableError, type ReadPage } from './types'

type AnyDocFormat = Parameters<typeof toMarkdownBytes>[1]

/**
 * Office, OpenDocument, RTF and CSV files: AnyDoc converts to Markdown locally. One page, no boxes.
 * AnyDoc detects a format from its signature, and CSV has none: unnamed, every CSV was refused as
 * "unrecognized file content" five times and then left unread (414 files, seen 2026-09-24..10-28).
 */
export async function readOfficeDocument(bytes: Buffer, mimeType?: string | null): Promise<ReadPage[]> {
  const anydoc = await import('@firecrawl/anydoc').catch((err) => {
    throw new ReaderUnavailableError('office', err)
  })
  // Format is an ambient const enum, which isolatedModules cannot reference: its value is the string.
  const format = (mimeType === 'text/csv' ? 'csv' : null) as unknown as AnyDocFormat
  const md = Buffer.from(await anydoc.toMarkdownBytes(new Uint8Array(bytes), format)).toString('utf8').trim()
  if (!md) return []
  return [{ pageNo: 1, text: md, reader: 'office', hasTextLayer: true }]
}
