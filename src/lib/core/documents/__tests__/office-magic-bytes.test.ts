import { describe, it, expect } from 'vitest'
import { validateDocumentMagicBytes, resolveStoredMimeType, validateDocumentFile, ALLOWED_DOCUMENT_TYPES } from '../document-service'

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const ODT = 'application/vnd.oasis.opendocument.text'

// Copy into a standalone ArrayBuffer: a small Buffer's .buffer is the shared
// pool slab, not the bytes themselves.
const own = (b: Buffer): ArrayBuffer => Uint8Array.from(b).buffer as ArrayBuffer
// A ZIP local-file header followed by the manifest names the validator looks for.
const zip = (...entries: string[]): ArrayBuffer =>
  own(Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(entries.join(' '), 'latin1')]))
const bytes = (s: string): ArrayBuffer => own(Buffer.from(s, 'latin1'))
const raw = (b: number[]): ArrayBuffer => own(Buffer.from(b))
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]

describe('Office uploads', () => {
  it('are on the allowlist', () => {
    expect(validateDocumentFile({ size: 10, type: DOCX })).toBeNull()
    expect(validateDocumentFile({ size: 10, type: 'text/csv' })).toBeNull()
    expect(ALLOWED_DOCUMENT_TYPES).toContain(ODT)
  })

  it('accepts a ZIP only when its manifest names the declared Office type', () => {
    expect(validateDocumentMagicBytes(zip('[Content_Types].xml', 'word/document.xml'), DOCX)).toBeNull()
    expect(validateDocumentMagicBytes(zip('[Content_Types].xml', 'xl/workbook.xml'), XLSX)).toBeNull()
    expect(validateDocumentMagicBytes(zip('[Content_Types].xml', 'xl/workbook.xml'), DOCX)).toMatch(/matchar inte/)
    expect(validateDocumentMagicBytes(zip('mimetype' + ODT), ODT)).toBeNull()
    expect(validateDocumentMagicBytes(zip('random.txt'), ODT)).toMatch(/matchar inte/)
    expect(validateDocumentMagicBytes(zip('[Content_Types].xml', 'word/document.xml'), 'application/pdf')).toMatch(/matchar inte/)
  })

  it('accepts legacy OLE, RTF and CSV by their own shape', () => {
    expect(validateDocumentMagicBytes(raw(OLE), 'application/msword')).toBeNull()
    expect(validateDocumentMagicBytes(raw(OLE), 'application/pdf')).toMatch(/matchar inte/)
    expect(validateDocumentMagicBytes(bytes('{\\rtf1\\ansi Hej}'), 'application/rtf')).toBeNull()
    expect(validateDocumentMagicBytes(bytes('datum;belopp\n2026-01-01;100'), 'text/csv')).toBeNull()
    expect(validateDocumentMagicBytes(bytes('not a csv at all'), 'text/csv')).toMatch(/CSV/)
  })

  it('stores the declared Office type, not the container type', () => {
    expect(resolveStoredMimeType(zip('[Content_Types].xml', 'word/document.xml'), DOCX)).toBe(DOCX)
    expect(resolveStoredMimeType(bytes('a;b\n1;2'), 'text/csv')).toBe('text/csv')
    expect(resolveStoredMimeType(bytes('%PDF-1.4'), 'application/pdf')).toBe('application/pdf')
  })
})
