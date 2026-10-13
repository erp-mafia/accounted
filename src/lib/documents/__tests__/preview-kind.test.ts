import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { documentPreviewKind } from '@/lib/documents/preview-kind'

describe('documentPreviewKind', () => {
  it('reads the stored type first', () => {
    expect(documentPreviewKind('application/pdf', 'kvitto.jpg')).toBe('pdf')
    expect(documentPreviewKind('image/heic', null)).toBe('image')
    expect(documentPreviewKind('text/html')).toBe('html')
    expect(documentPreviewKind('application/zip', 'arkiv.pdf')).toBeNull()
  })

  it('falls back to the file name on legacy rows without a usable type', () => {
    expect(documentPreviewKind(null, 'Faktura 12.PDF')).toBe('pdf')
    expect(documentPreviewKind('application/octet-stream', 'IMG_0001.HEIC')).toBe('image')
    expect(documentPreviewKind('', 'kvitto.webp')).toBe('image')
    expect(documentPreviewKind(null, 'underlag.xlsx')).toBeNull()
    expect(documentPreviewKind(undefined)).toBeNull()
  })
})

/*
 * Every surface that shows a stored document renders it through the one
 * DocumentPreview body and asks documentPreviewKind what it is. A local
 * <object>/<embed> or a local isImageType/isPdfType is a copy coming back.
 */
describe('document viewers on the shared preview body', () => {
  const root = path.resolve(__dirname, '../../../')
  it.each([
    'components/bookkeeping/DocumentViewerPane.tsx',
    'components/bookkeeping/AttachmentPreviewSheet.tsx',
    'components/bookkeeping/JournalEntryAttachments.tsx',
    'components/bookkeeping/InboxDocumentPicker.tsx',
    'components/extensions/general/InvoiceInboxWorkspace.tsx',
  ])('%s', (rel) => {
    const src = fs.readFileSync(path.join(root, rel), 'utf8')
    expect(src).toMatch(/<DocumentPreview(Body)?\b/)
    expect(src).toContain('documentPreviewKind(')
    expect(src).not.toMatch(/<object\b|<embed\b/)
    expect(src).not.toMatch(/function is(Image|Pdf)Type\b/)
  })
})
