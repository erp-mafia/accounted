import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ATTACHMENTS = fs.readFileSync(
  path.resolve(__dirname, '../JournalEntryAttachments.tsx'),
  'utf8',
)
const UPLOAD_ZONE = fs.readFileSync(
  path.resolve(__dirname, '../DocumentUploadZone.tsx'),
  'utf8',
)

function slice(source: string, from: string, to: string): string {
  const start = source.indexOf(from)
  expect(start).toBeGreaterThan(-1)
  const end = source.indexOf(to, start + from.length)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

/**
 * Rage-click regressions on the verifikat underlag list (/bookkeeping and the
 * verifikat page). The repo does not render components in tests, so the
 * source shape is pinned, as for the JournalEntryList copy affordance.
 */
describe('JournalEntryAttachments: "Lägg till underlag"', () => {
  it('opens the file picker in the same click instead of only toggling the zone', () => {
    const handler = slice(ATTACHMENTS, 'const handleAddClick = () => {', '\n  }\n')
    expect(handler).toContain('setShowUpload(true)')
    expect(handler).toContain('addFileInputRef.current?.click()')
    expect(ATTACHMENTS).toContain('onClick={handleAddClick}')
    // A second click on a toggle closed the zone the first click opened.
    expect(ATTACHMENTS).not.toContain('setShowUpload(!showUpload)')
  })

  it('keeps the upload zone mounted, so its file input exists before the first click', () => {
    expect(ATTACHMENTS).not.toMatch(/\{showUpload && \(\s*<div className="mb-3">\s*<DocumentUploadZone/)
    expect(ATTACHMENTS).toContain("<div className={showUpload ? 'mb-3' : 'hidden'}>")
    expect(ATTACHMENTS).toContain('fileInputRef={addFileInputRef}')
  })

  it('hands the zone its file input through fileInputRef', () => {
    expect(UPLOAD_ZONE).toContain('fileInputRef?: React.RefObject<HTMLInputElement | null>')
    expect(UPLOAD_ZONE).toContain('if (fileInputRef) fileInputRef.current = element')
  })
})

describe('JournalEntryAttachments: underlag preview toggle', () => {
  it('expands at once, with no request before the preview opens', () => {
    const handler = slice(ATTACHMENTS, 'const handlePreviewToggle = ', '\n  }\n')
    expect(handler).not.toContain('async')
    expect(handler).not.toContain('fetch(')
    expect(handler).not.toContain('await')
  })

  it('shows the preview without waiting for a signed download URL', () => {
    expect(ATTACHMENTS).toContain('{isExpanded && previewable && (')
    expect(ATTACHMENTS).not.toContain('doc.download_url')
  })

  it('makes the chevron and the file name one toggle with aria-expanded', () => {
    const toggle = slice(ATTACHMENTS, 'onClick={() => handlePreviewToggle(doc)}', '</button>')
    expect(toggle).toContain('aria-expanded={isExpanded}')
    expect(toggle).toContain('{doc.file_name}')
  })
})
