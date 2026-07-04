import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { makeDocumentAttachment } from '@/tests/helpers'

// ============================================================
// Mock: separate client (no .then) from query builder (thenable)
// ============================================================

let resultIdx: number
let results: Array<{ data?: unknown; error?: unknown }>

function makeBuilder() {
  const b: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'insert', 'update', 'delete', 'lte', 'gte', 'in', 'not', 'or', 'order', 'limit', 'is']) {
    b[m] = vi.fn().mockReturnValue(b)
  }
  b.single = vi.fn().mockImplementation(async () => results[resultIdx++] ?? { data: null, error: null })
  b.maybeSingle = vi.fn().mockImplementation(async () => results[resultIdx++] ?? { data: null, error: null })
  b.then = (resolve: (v: unknown) => void) => resolve(results[resultIdx++] ?? { data: null, error: null })
  return b
}

function makeClient(storageOverrides: Record<string, unknown> = {}) {
  return {
    from: vi.fn().mockImplementation(() => makeBuilder()),
    rpc: vi.fn().mockImplementation(async () => results[resultIdx++] ?? { data: null, error: null }),
    storage: {
      getBucket: vi.fn().mockResolvedValue({ data: { id: 'documents' }, error: null }),
      createBucket: vi.fn().mockResolvedValue({ data: { name: 'documents' }, error: null }),
      from: vi.fn().mockReturnValue({
        upload: vi.fn().mockResolvedValue({ data: {}, error: null }),
        download: vi.fn().mockResolvedValue({
          data: new Blob(['test content']),
          error: null,
        }),
        remove: vi.fn().mockResolvedValue({ data: [], error: null }),
        getPublicUrl: vi.fn().mockReturnValue({
          data: { publicUrl: 'https://example.com/file.pdf' },
        }),
        ...storageOverrides,
      }),
    },
  }
}

vi.mock('@/lib/auth/api-keys', () => ({
  createServiceClientNoCookies: vi.fn(() => makeClient()),
}))

import {
  uploadDocument,
  createNewVersion,
  verifyIntegrity,
  validateDocumentMagicBytes,
  _resetBucketVerified,
} from '../document-service'

// A minimal valid PDF byte sequence (header + EOF): passes magic-byte check.
function pdfBuffer(payload = 'test'): ArrayBuffer {
  return new TextEncoder().encode(`%PDF-1.4\n${payload}\n%%EOF\n`).buffer as ArrayBuffer
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  _resetBucketVerified()
  resultIdx = 0
  results = []
})

describe('validateDocumentMagicBytes: application/xhtml+xml', () => {
  const toBuffer = (text: string, bom = false): ArrayBuffer => {
    const bytes = new TextEncoder().encode(bom ? `﻿${text}` : text)
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  }

  it('accepts content starting with an XML declaration', () => {
    const xhtml = '<?xml version="1.0" encoding="UTF-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml"></html>'
    expect(validateDocumentMagicBytes(toBuffer(xhtml), 'application/xhtml+xml')).toBeNull()
  })

  it('accepts content starting with an HTML doctype or <html>, case-insensitively', () => {
    expect(
      validateDocumentMagicBytes(toBuffer('<!DOCTYPE html>\n<html></html>'), 'application/xhtml+xml'),
    ).toBeNull()
    expect(
      validateDocumentMagicBytes(toBuffer('<!doctype HTML><html></html>'), 'application/xhtml+xml'),
    ).toBeNull()
    expect(
      validateDocumentMagicBytes(toBuffer('<HTML xmlns="http://www.w3.org/1999/xhtml"></HTML>'), 'application/xhtml+xml'),
    ).toBeNull()
  })

  it('accepts a UTF-8 BOM and leading whitespace before the marker', () => {
    expect(
      validateDocumentMagicBytes(toBuffer('\n  <?xml version="1.0"?><html></html>', true), 'application/xhtml+xml'),
    ).toBeNull()
  })

  it('rejects content that is not XHTML/XML', () => {
    expect(validateDocumentMagicBytes(toBuffer('just some text'), 'application/xhtml+xml')).toMatch(
      /kunde inte verifieras/,
    )
    expect(validateDocumentMagicBytes(pdfBuffer(), 'application/xhtml+xml')).toMatch(
      /kunde inte verifieras/,
    )
  })

  it('does not loosen validation for other declared types', () => {
    // XHTML bytes declared as PDF must still be rejected.
    expect(validateDocumentMagicBytes(toBuffer('<?xml version="1.0"?>'), 'application/pdf')).toMatch(
      /kunde inte verifieras/,
    )
    // And a real PDF still passes as PDF.
    expect(validateDocumentMagicBytes(pdfBuffer(), 'application/pdf')).toBeNull()
  })
})

describe('validateDocumentMagicBytes: PDF header offset tolerance', () => {
  const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer

  const withPreamble = (preamble: string): ArrayBuffer => {
    const pdf = new Uint8Array(pdfBuffer())
    const lead = new TextEncoder().encode(preamble)
    const combined = new Uint8Array(lead.length + pdf.length)
    combined.set(lead, 0)
    combined.set(pdf, lead.length)
    return toArrayBuffer(combined)
  }

  it('accepts a PDF with a leading newline before %PDF- (ISO 32000 preamble)', () => {
    expect(validateDocumentMagicBytes(withPreamble('\n'), 'application/pdf')).toBeNull()
  })

  it('accepts a PDF with leading whitespace/junk before %PDF-', () => {
    expect(validateDocumentMagicBytes(withPreamble('   '), 'application/pdf')).toBeNull()
    expect(validateDocumentMagicBytes(withPreamble('\r\n\r\n<junk>'), 'application/pdf')).toBeNull()
  })

  it('accepts a PDF with a UTF-8 BOM before %PDF-', () => {
    const pdf = new Uint8Array(pdfBuffer())
    const combined = new Uint8Array(3 + pdf.length)
    combined.set([0xEF, 0xBB, 0xBF], 0)
    combined.set(pdf, 3)
    expect(validateDocumentMagicBytes(toArrayBuffer(combined), 'application/pdf')).toBeNull()
  })

  it('rejects when %PDF- appears only beyond the first 1024 bytes', () => {
    expect(validateDocumentMagicBytes(withPreamble('x'.repeat(1025)), 'application/pdf')).toMatch(
      /kunde inte verifieras/,
    )
  })

  it('still rejects HTML and plain text declared as PDF', () => {
    const toBuffer = (text: string): ArrayBuffer =>
      toArrayBuffer(new TextEncoder().encode(text))
    expect(
      validateDocumentMagicBytes(toBuffer('<html><body>Your invoice</body></html>'), 'application/pdf'),
    ).toMatch(/kunde inte verifieras/)
    expect(
      validateDocumentMagicBytes(toBuffer('JVBERi0xLjQKJcOkw7zDtsO'), 'application/pdf'),
    ).toMatch(/kunde inte verifieras/)
  })

  it('images stay strict at offset 0: a leading byte still rejects', () => {
    const png = new Uint8Array([0x0A, 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
    expect(validateDocumentMagicBytes(toArrayBuffer(png), 'image/png')).toMatch(
      /kunde inte verifieras/,
    )
  })
})

describe('uploadDocument', () => {
  it('computes SHA-256 hash, stores metadata, emits document.uploaded', async () => {
    const doc = makeDocumentAttachment({
      id: 'doc-1',
      file_name: 'test.pdf',
      sha256_hash: 'computed-hash',
    })

    results = [
      { data: doc, error: null }, // insert record
    ]

    const handler = vi.fn()
    eventBus.on('document.uploaded', handler)

    const supabase = makeClient()
    const result = await uploadDocument(supabase as never, 'user-1', 'company-1', {
      name: 'test.pdf',
      buffer: pdfBuffer('test content'),
      type: 'application/pdf',
    })

    expect(result.id).toBe('doc-1')
    expect(result.file_name).toBe('test.pdf')
    expect(handler).toHaveBeenCalledOnce()
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        document: expect.objectContaining({ id: 'doc-1' }),
        userId: 'user-1',
        companyId: 'company-1',
      })
    )
  })
})

describe('createNewVersion', () => {
  it('increments version and supersedes previous', async () => {
    const current = makeDocumentAttachment({
      id: 'doc-1',
      version: 1,
      is_current_version: true,
      original_id: null,
    })
    const newVersion = makeDocumentAttachment({
      id: 'doc-2',
      version: 2,
      is_current_version: true,
      original_id: 'doc-1',
    })

    results = [
      { data: current, error: null },     // fetch current
      { data: newVersion, error: null },   // insert new version
    ]

    const supabase = makeClient()
    const result = await createNewVersion(supabase as never, 'user-1', 'doc-1', {
      name: 'test-v2.pdf',
      buffer: pdfBuffer('new content'),
      type: 'application/pdf',
    })

    expect(result.version).toBe(2)
    expect(result.original_id).toBe('doc-1')
    expect(result.is_current_version).toBe(true)
  })
})

describe('verifyIntegrity', () => {
  it('returns valid when hashes match', async () => {
    const content = 'test content for integrity check'
    const buffer = new TextEncoder().encode(content)
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer)
    const hashArray = Array.from(new Uint8Array(hashBuffer))
    const expectedHash = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')

    results = [
      { data: { storage_path: 'docs/test.pdf', sha256_hash: expectedHash }, error: null },
    ]

    // Create a client with matching download content
    const supabase = makeClient({
      download: vi.fn().mockResolvedValue({
        data: new Blob([content]),
        error: null,
      }),
    })

    const result = await verifyIntegrity(supabase as never, 'user-1', 'doc-1')
    expect(result.valid).toBe(true)
    expect(result.storedHash).toBe(expectedHash)
    expect(result.computedHash).toBe(expectedHash)
  })

  it('returns invalid when hashes do not match', async () => {
    results = [
      { data: { storage_path: 'docs/test.pdf', sha256_hash: 'stored-hash-abc' }, error: null },
    ]

    const supabase = makeClient({
      download: vi.fn().mockResolvedValue({
        data: new Blob(['different content']),
        error: null,
      }),
    })

    const result = await verifyIntegrity(supabase as never, 'user-1', 'doc-1')
    expect(result.valid).toBe(false)
    expect(result.storedHash).toBe('stored-hash-abc')
    expect(result.computedHash).not.toBe('stored-hash-abc')
  })
})
