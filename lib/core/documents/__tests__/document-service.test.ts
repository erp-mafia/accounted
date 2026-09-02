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
        createSignedUploadUrl: vi.fn().mockResolvedValue({
          data: { signedUrl: 'https://example.com/signed-upload' },
          error: null,
        }),
        download: vi.fn().mockResolvedValue({
          data: new Blob(['test content']),
          error: null,
        }),
        list: vi.fn().mockResolvedValue({ data: [], error: null }),
        move: vi.fn().mockResolvedValue({ data: {}, error: null }),
        remove: vi.fn().mockResolvedValue({ data: [], error: null }),
        getPublicUrl: vi.fn().mockReturnValue({
          data: { publicUrl: 'https://example.com/file.pdf' },
        }),
        ...storageOverrides,
      }),
    },
  }
}

// verifyIntegrity downloads via the service-role client (the storage SELECT
// policy is per-uploader-folder); tests set this override to control the
// downloaded bytes.
let serviceClientOverride: ReturnType<typeof makeClient> | null = null

vi.mock('@/lib/auth/api-keys', () => ({
  createServiceClientNoCookies: vi.fn(() => serviceClientOverride ?? makeClient()),
}))

import {
  uploadDocument,
  createNewVersion,
  deleteDocument,
  verifyIntegrity,
  detectFileMagic,
  validateDocumentMagicBytes,
  buildDocumentStoragePath,
  buildPendingDocumentStoragePath,
  buildReservedDocumentStoragePath,
  cleanupExpiredPendingDocumentUploads,
  createPendingDocumentUpload,
  completePendingDocumentUpload,
  computeSHA256,
  resolveStoredMimeType,
  PENDING_DOCUMENT_UPLOAD_RETENTION_MS,
  SIGNED_DOCUMENT_UPLOAD_TTL_MS,
  isCompanyScopedDocumentPath,
  companyScopedDocumentPath,
  legacyDocumentPath,
  documentStoragePathCandidates,
  downloadDocumentObject,
  createDocumentSignedUrl,
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
  serviceClientOverride = null
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

describe('validateDocumentMagicBytes: text/html', () => {
  const toBuffer = (text: string): ArrayBuffer => {
    const bytes = new TextEncoder().encode(text)
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  }

  it('accepts a full HTML document (mail-body underlag from the invoice inbox)', () => {
    expect(
      validateDocumentMagicBytes(toBuffer('<!doctype html>\n<html><body>Faktura 123</body></html>'), 'text/html'),
    ).toBeNull()
    expect(
      validateDocumentMagicBytes(toBuffer('<html><body>x</body></html>'), 'text/html'),
    ).toBeNull()
  })

  it('rejects fragment-shaped or plain-text content', () => {
    // The inbound pipeline wraps fragments before upload: an unwrapped
    // fragment reaching the document service is a caller bug.
    expect(validateDocumentMagicBytes(toBuffer('<div>Faktura 123</div>'), 'text/html')).toMatch(
      /kunde inte verifieras/,
    )
    expect(validateDocumentMagicBytes(toBuffer('just some text'), 'text/html')).toMatch(
      /kunde inte verifieras/,
    )
  })
})

describe('validateDocumentMagicBytes: application/json', () => {
  const toBuffer = (text: string, bom = false): ArrayBuffer => {
    const bytes = new TextEncoder().encode(bom ? `﻿${text}` : text)
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  }

  it('accepts a JSON object (raw PSD2 response archive shape)', () => {
    const psd2Page = JSON.stringify({ transactions: [{ amount: '100.00' }], continuation_key: null })
    expect(validateDocumentMagicBytes(toBuffer(psd2Page), 'application/json')).toBeNull()
  })

  it('accepts a JSON array, leading whitespace, and a UTF-8 BOM', () => {
    expect(validateDocumentMagicBytes(toBuffer('[1, 2, 3]'), 'application/json')).toBeNull()
    expect(validateDocumentMagicBytes(toBuffer('\n  {"a": 1}'), 'application/json')).toBeNull()
    expect(validateDocumentMagicBytes(toBuffer('{"a": 1}', true), 'application/json')).toBeNull()
  })

  it('rejects prose placeholders and bare JSON scalars', () => {
    expect(validateDocumentMagicBytes(toBuffer('summary of the response'), 'application/json')).toMatch(
      /kunde inte verifieras/,
    )
    // Scalars parse as JSON but are not a plausible archived API response:
    // the object/array root requirement keeps the anti-placeholder defense.
    expect(validateDocumentMagicBytes(toBuffer('"just a string"'), 'application/json')).toMatch(
      /kunde inte verifieras/,
    )
    expect(validateDocumentMagicBytes(toBuffer('42'), 'application/json')).toMatch(
      /kunde inte verifieras/,
    )
    expect(validateDocumentMagicBytes(toBuffer('null'), 'application/json')).toMatch(
      /kunde inte verifieras/,
    )
  })

  it('rejects truncated JSON', () => {
    expect(validateDocumentMagicBytes(toBuffer('{"transactions": [{"amount":'), 'application/json')).toMatch(
      /kunde inte verifieras/,
    )
  })

  it('does not loosen validation for other declared types', () => {
    expect(validateDocumentMagicBytes(toBuffer('{"a": 1}'), 'application/pdf')).toMatch(
      /kunde inte verifieras/,
    )
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

describe('validateDocumentMagicBytes: HEIC/HEIF (ISO-BMFF ftyp brands)', () => {
  // Minimal ISO-BMFF head: a 16-byte ftyp box whose major brand is `brand`.
  // Real files carry compatible brands and media data after this, but the
  // detector only reads the first 12 bytes.
  const isoBmff = (brand: string): ArrayBuffer => {
    const bytes = new Uint8Array(16)
    bytes[3] = 16 // box size (big-endian 0x00000010)
    bytes.set([0x66, 0x74, 0x79, 0x70], 4) // 'ftyp'
    bytes.set(new TextEncoder().encode(brand), 8)
    return bytes.buffer as ArrayBuffer
  }
  const jpegBytes = (): ArrayBuffer =>
    new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46]).buffer as ArrayBuffer

  it('detects HEVC-coded brands as image/heic and MIAF brands as image/heif', () => {
    for (const brand of ['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs']) {
      expect(detectFileMagic(new Uint8Array(isoBmff(brand)))).toBe('image/heic')
    }
    for (const brand of ['mif1', 'msf1']) {
      expect(detectFileMagic(new Uint8Array(isoBmff(brand)))).toBe('image/heif')
    }
    // Other ISO-BMFF brands (video containers) stay undetected.
    expect(detectFileMagic(new Uint8Array(isoBmff('isom')))).toBeNull()
    expect(detectFileMagic(new Uint8Array(isoBmff('qt  ')))).toBeNull()
  })

  it('accepts a heic-brand file under both declared family members', () => {
    expect(validateDocumentMagicBytes(isoBmff('heic'), 'image/heic')).toBeNull()
    expect(validateDocumentMagicBytes(isoBmff('heic'), 'image/heif')).toBeNull()
  })

  it('accepts a mif1-brand file under both declared family members', () => {
    expect(validateDocumentMagicBytes(isoBmff('mif1'), 'image/heif')).toBeNull()
    expect(validateDocumentMagicBytes(isoBmff('mif1'), 'image/heic')).toBeNull()
  })

  it('rejects garbage bytes declared image/heic (formerly blanket-exempted)', () => {
    const garbage = new TextEncoder().encode('this is not an image at all')
    const buffer = garbage.buffer.slice(garbage.byteOffset, garbage.byteOffset + garbage.byteLength) as ArrayBuffer
    expect(validateDocumentMagicBytes(buffer, 'image/heic')).toMatch(/kunde inte verifieras/)
    expect(validateDocumentMagicBytes(buffer, 'image/heif')).toMatch(/kunde inte verifieras/)
  })

  it('rejects JPEG bytes declared image/heic as a type mismatch', () => {
    expect(validateDocumentMagicBytes(jpegBytes(), 'image/heic')).toMatch(/matchar inte/)
  })

  it('does not loosen validation for other declared types', () => {
    // HEIC bytes declared as JPEG must still be rejected as a mismatch.
    expect(validateDocumentMagicBytes(isoBmff('heic'), 'image/jpeg')).toMatch(/matchar inte/)
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

  it('returns the existing document instead of storing a copy when dedupeByContent hits', async () => {
    const existing = makeDocumentAttachment({ id: 'doc-orig', sha256_hash: 'same' })
    results = [
      { data: [existing], error: null }, // dedupe lookup
    ]

    const handler = vi.fn()
    eventBus.on('document.uploaded', handler)

    const upload = vi.fn().mockResolvedValue({ data: {}, error: null })
    const supabase = makeClient({ upload })
    const result = await uploadDocument(supabase as never, 'user-1', 'company-1', {
      name: 'kvitto.pdf',
      buffer: pdfBuffer(),
      type: 'application/pdf',
    }, { dedupeByContent: true })

    expect(result.id).toBe('doc-orig')
    expect(result.deduplicated).toBe(true)
    // Nothing reaches storage and no document.uploaded fires: the archive
    // already holds this content, so re-extraction must not run either.
    expect(upload).not.toHaveBeenCalled()
    expect(handler).not.toHaveBeenCalled()
  })

  it('rejects when the dedupe lookup itself fails, touching nothing', async () => {
    // Fail closed: treating a broken lookup as "no match" would archive the
    // duplicate the flag exists to prevent, silently, on transient DB errors.
    results = [{ data: null, error: { message: 'connection reset' } }]

    const handler = vi.fn()
    eventBus.on('document.uploaded', handler)

    const upload = vi.fn().mockResolvedValue({ data: {}, error: null })
    const supabase = makeClient({ upload })

    await expect(
      uploadDocument(supabase as never, 'user-1', 'company-1', {
        name: 'kvitto.pdf',
        buffer: pdfBuffer(),
        type: 'application/pdf',
      }, { dedupeByContent: true }),
    ).rejects.toThrow(/dedupe lookup failed/i)
    expect(upload).not.toHaveBeenCalled()
    expect(handler).not.toHaveBeenCalled()
  })

  it('stores normally when dedupeByContent finds no match', async () => {
    results = [
      { data: [], error: null }, // dedupe lookup: miss
      { data: makeDocumentAttachment({ id: 'doc-new' }), error: null }, // insert
    ]

    const upload = vi.fn().mockResolvedValue({ data: {}, error: null })
    const supabase = makeClient({ upload })
    const result = await uploadDocument(supabase as never, 'user-1', 'company-1', {
      name: 'kvitto.pdf',
      buffer: pdfBuffer(),
      type: 'application/pdf',
    }, { dedupeByContent: true })

    expect(result.id).toBe('doc-new')
    expect(result.deduplicated).toBeUndefined()
    expect(upload).toHaveBeenCalledOnce()
  })

  it('writes to the company-scoped key, not the legacy uploader-scoped key', async () => {
    results = [{ data: makeDocumentAttachment({ id: 'doc-1' }), error: null }]

    const upload = vi.fn().mockResolvedValue({ data: {}, error: null })
    const supabase = makeClient({ upload })

    await uploadDocument(supabase as never, 'user-1', 'company-1', {
      name: 'kvitto.pdf',
      buffer: pdfBuffer(),
      type: 'application/pdf',
    })

    const key = upload.mock.calls[0]![0] as string
    expect(key).toMatch(/^documents\/company-1\/user-1\/\d+_kvitto\.pdf$/)
    // The legacy layout put userId directly under `documents/`, which left
    // company_id out of the RLS-visible path entirely.
    expect(key).not.toMatch(/^documents\/user-1\//)
  })

  it('cleans up the uploaded object via the service-role client when the record insert fails', async () => {
    // The documents bucket is WORM (no DELETE policy): a caller-bound
    // remove() is silently blocked by RLS, so the failed-upload cleanup must
    // run on the service-role client or the object is orphaned forever.
    results = [{ data: null, error: { message: 'insert exploded' } }]

    const serviceRemove = vi.fn().mockResolvedValue({ data: [], error: null })
    serviceClientOverride = makeClient({ remove: serviceRemove })

    const callerRemove = vi.fn().mockResolvedValue({ data: [], error: null })
    const upload = vi.fn().mockResolvedValue({ data: {}, error: null })
    const supabase = makeClient({ upload, remove: callerRemove })

    await expect(
      uploadDocument(supabase as never, 'user-1', 'company-1', {
        name: 'kvitto.pdf',
        buffer: pdfBuffer(),
        type: 'application/pdf',
      }),
    ).rejects.toThrow(/Failed to create document record/)

    const uploadedKey = upload.mock.calls[0]![0] as string
    expect(serviceRemove).toHaveBeenCalledWith([uploadedKey])
    expect(callerRemove).not.toHaveBeenCalled()
  })

  it('coalesces concurrent idempotent uploads on one immutable document row', async () => {
    const rows = new Map<string, ReturnType<typeof makeDocumentAttachment>>()
    const upload = vi.fn().mockResolvedValue({ data: {}, error: null })
    const serviceRemove = vi.fn().mockResolvedValue({ data: [], error: null })
    serviceClientOverride = makeClient({ remove: serviceRemove })

    let arrivals = 0
    let releaseInserts = () => {}
    const insertBarrier = new Promise<void>((resolve) => {
      releaseInserts = resolve
    })

    const client = {
      from: vi.fn(() => {
        let insertPayload: Record<string, unknown> | null = null
        let queriedId = ''
        const builder: Record<string, unknown> = {}
        builder.insert = vi.fn((payload: Record<string, unknown>) => {
          insertPayload = payload
          return builder
        })
        builder.select = vi.fn(() => builder)
        builder.eq = vi.fn((column: string, value: string) => {
          if (column === 'id') queriedId = value
          return builder
        })
        builder.single = vi.fn(async () => {
          arrivals++
          if (arrivals === 2) releaseInserts()
          await insertBarrier
          const payload = insertPayload as Record<string, unknown>
          const id = payload.id as string
          if (rows.has(id)) {
            return { data: null, error: { code: '23505', message: 'duplicate key' } }
          }
          const row = makeDocumentAttachment(payload)
          rows.set(id, row)
          return { data: row, error: null }
        })
        builder.maybeSingle = vi.fn(async () => ({
          data: rows.get(queriedId) ?? null,
          error: null,
        }))
        return builder
      }),
      storage: {
        getBucket: vi.fn().mockResolvedValue({ data: { id: 'documents' }, error: null }),
        createBucket: vi.fn().mockResolvedValue({ data: { name: 'documents' }, error: null }),
        from: vi.fn().mockReturnValue({ upload }),
      },
    }

    const handler = vi.fn()
    eventBus.on('document.uploaded', handler)
    const file = {
      name: 'kvitto.pdf',
      buffer: pdfBuffer('same retained receipt'),
      type: 'application/pdf',
    }
    const metadata = {
      upload_source: 'api' as const,
      journal_entry_id: 'je-1',
      idempotency_key: 'je-1',
    }

    const documents = await Promise.all([
      uploadDocument(client as never, 'user-1', 'company-1', file, metadata),
      uploadDocument(client as never, 'user-1', 'company-1', file, metadata),
    ])

    expect(documents[0].id).toBe(documents[1].id)
    expect(rows.size).toBe(1)
    expect(upload).toHaveBeenCalledTimes(2)
    expect(upload.mock.calls[0]![0]).not.toBe(upload.mock.calls[1]![0])
    expect(serviceRemove).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('does not treat a non-unique insert error as an idempotent winner', async () => {
    results = [
      { data: null, error: { code: '42501', message: 'row-level security denied' } },
    ]
    const serviceRemove = vi.fn().mockResolvedValue({ data: [], error: null })
    serviceClientOverride = makeClient({ remove: serviceRemove })
    const supabase = makeClient()

    await expect(
      uploadDocument(
        supabase as never,
        'user-1',
        'company-1',
        {
          name: 'kvitto.pdf',
          buffer: pdfBuffer('retained receipt'),
          type: 'application/pdf',
        },
        { journal_entry_id: 'je-1', idempotency_key: 'je-1' },
      ),
    ).rejects.toThrow('Failed to create document record: row-level security denied')

    expect(supabase.from).toHaveBeenCalledTimes(1)
    expect(serviceRemove).toHaveBeenCalledTimes(1)
  })
})

describe('model-free signed document uploads', () => {
  const company = '11111111-1111-4111-8111-111111111111'
  const user = '22222222-2222-4222-8222-222222222222'
  const uploadId = '33333333-3333-4333-8333-333333333333'

  it('creates a company-scoped signed upload reservation with a two-hour expiry', async () => {
    const now = Date.parse('2026-08-03T10:00:00.000Z')
    const createSignedUploadUrl = vi.fn().mockResolvedValue({
      data: { signedUrl: 'https://storage.example/upload?token=signed' },
      error: null,
    })
    const supabase = makeClient({ createSignedUploadUrl })

    const reservation = await createPendingDocumentUpload(
      supabase as never,
      company,
      user,
      uploadId,
      'Leverantör faktura.pdf',
      now,
    )

    expect(createSignedUploadUrl).toHaveBeenCalledWith(
      `documents/${company}/${user}/pending/${uploadId}_Leverant_r_faktura.pdf`,
      { upsert: false },
    )
    expect(reservation).toEqual({
      uploadId,
      signedUrl: 'https://storage.example/upload?token=signed',
      expiresAt: new Date(now + SIGNED_DOCUMENT_UPLOAD_TTL_MS).toISOString(),
    })
  })

  it('adopts uploaded bytes under the reserved UUID and permanent WORM path', async () => {
    const buffer = pdfBuffer('presigned upload')
    const document = makeDocumentAttachment({
      id: uploadId,
      user_id: user,
      company_id: company,
      file_name: 'invoice.pdf',
      mime_type: 'application/pdf',
      storage_path: buildReservedDocumentStoragePath(company, user, uploadId, 'invoice.pdf'),
      sha256_hash: await computeSHA256(buffer),
    })
    results = [
      { data: null, error: null },
      { data: document, error: null },
    ]

    const move = vi.fn().mockResolvedValue({ data: {}, error: null })
    const download = vi.fn().mockResolvedValue({ data: new Blob([buffer]), error: null })
    serviceClientOverride = makeClient({ download, move })

    const completed = await completePendingDocumentUpload(
      makeClient() as never,
      company,
      user,
      uploadId,
      'invoice.pdf',
      'application/pdf',
    )

    expect(completed.document.id).toBe(uploadId)
    expect(move).toHaveBeenCalledWith(
      buildPendingDocumentStoragePath(company, user, uploadId, 'invoice.pdf'),
      buildReservedDocumentStoragePath(company, user, uploadId, 'invoice.pdf'),
    )
  })

  it('returns the existing immutable document on retry after verifying its hash', async () => {
    const buffer = pdfBuffer('already complete')
    const document = makeDocumentAttachment({
      id: uploadId,
      user_id: user,
      company_id: company,
      file_name: 'invoice.pdf',
      mime_type: 'application/pdf',
      storage_path: buildReservedDocumentStoragePath(company, user, uploadId, 'invoice.pdf'),
      sha256_hash: await computeSHA256(buffer),
    })
    results = [{ data: document, error: null }]

    const move = vi.fn().mockResolvedValue({ data: {}, error: null })
    serviceClientOverride = makeClient({
      download: vi.fn().mockResolvedValue({ data: new Blob([buffer]), error: null }),
      move,
    })

    const completed = await completePendingDocumentUpload(
      makeClient() as never,
      company,
      user,
      uploadId,
      'invoice.pdf',
      'application/pdf',
    )

    expect(completed.document).toEqual(document)
    expect(move).not.toHaveBeenCalled()
  })

  it('removes corrupt pending bytes before rejecting completion', async () => {
    results = [{ data: null, error: null }]
    const pendingPath = buildPendingDocumentStoragePath(company, user, uploadId, 'invoice.pdf')
    const remove = vi.fn().mockResolvedValue({ data: [], error: null })
    serviceClientOverride = makeClient({
      download: vi.fn().mockResolvedValue({ data: new Blob(['not a pdf']), error: null }),
      remove,
    })

    await expect(
      completePendingDocumentUpload(
        makeClient() as never,
        company,
        user,
        uploadId,
        'invoice.pdf',
        'application/pdf',
      ),
    ).rejects.toMatchObject({
      code: 'DOC_UPLOAD_INVALID_CONTENT',
      message: expect.stringMatching(/kunde inte verifieras/),
      messageSv: expect.stringMatching(/kunde inte verifieras/),
    })
    expect(remove).toHaveBeenCalledWith([pendingPath])
  })

  it('codes an empty pending object as DOC_UPLOAD_EMPTY and removes it', async () => {
    results = [{ data: null, error: null }]
    const pendingPath = buildPendingDocumentStoragePath(company, user, uploadId, 'invoice.pdf')
    const remove = vi.fn().mockResolvedValue({ data: [], error: null })
    serviceClientOverride = makeClient({
      download: vi.fn().mockResolvedValue({ data: new Blob([]), error: null }),
      remove,
    })

    await expect(
      completePendingDocumentUpload(makeClient() as never, company, user, uploadId, 'invoice.pdf', 'application/pdf'),
    ).rejects.toMatchObject({ code: 'DOC_UPLOAD_EMPTY' })
    expect(remove).toHaveBeenCalledWith([pendingPath])
  })

  // The insert payload of a completion: from() call #0 is findReservedDocument,
  // #1 the insert (no dedupe lookup in between unless opted in).
  function insertPayloadOf(client: ReturnType<typeof makeClient>, fromIndex: number) {
    const builder = client.from.mock.results[fromIndex]?.value as { insert: ReturnType<typeof vi.fn> }
    return builder.insert.mock.calls[0]?.[0] as Record<string, unknown> | undefined
  }

  it("stamps upload_source 'api' by default (the MCP tools' provenance)", async () => {
    const buffer = pdfBuffer('api upload')
    const document = makeDocumentAttachment({ id: uploadId, sha256_hash: await computeSHA256(buffer) })
    results = [
      { data: null, error: null },
      { data: document, error: null },
    ]
    serviceClientOverride = makeClient({
      download: vi.fn().mockResolvedValue({ data: new Blob([buffer]), error: null }),
    })
    const client = makeClient()

    await completePendingDocumentUpload(client as never, company, user, uploadId, 'invoice.pdf', 'application/pdf')

    expect(insertPayloadOf(client, 1)?.upload_source).toBe('api')
  })

  it("stamps upload_source 'file_upload' for the browser direct-to-storage path", async () => {
    const buffer = pdfBuffer('browser upload')
    const document = makeDocumentAttachment({ id: uploadId, sha256_hash: await computeSHA256(buffer) })
    results = [
      { data: null, error: null },
      { data: document, error: null },
    ]
    serviceClientOverride = makeClient({
      download: vi.fn().mockResolvedValue({ data: new Blob([buffer]), error: null }),
    })
    const client = makeClient()

    await completePendingDocumentUpload(
      client as never,
      company,
      user,
      uploadId,
      'invoice.pdf',
      'application/pdf',
      undefined,
      { uploadSource: 'file_upload' },
    )

    expect(insertPayloadOf(client, 1)?.upload_source).toBe('file_upload')
    // No content-dedupe lookup unless asked for: exactly two from() calls.
    expect(client.from).toHaveBeenCalledTimes(2)
  })

  it('opt-in content dedupe returns the existing document and removes the pending object', async () => {
    const buffer = pdfBuffer('already archived')
    const existingId = '55555555-5555-4555-8555-555555555555'
    const existing = makeDocumentAttachment({
      id: existingId,
      company_id: company,
      sha256_hash: await computeSHA256(buffer),
    })
    results = [
      { data: null, error: null }, // findReservedDocument
      { data: [existing], error: null }, // dedupe lookup
    ]
    const move = vi.fn().mockResolvedValue({ data: {}, error: null })
    const remove = vi.fn().mockResolvedValue({ data: [], error: null })
    serviceClientOverride = makeClient({
      download: vi.fn().mockResolvedValue({ data: new Blob([buffer]), error: null }),
      move,
      remove,
    })
    const client = makeClient()

    const completed = await completePendingDocumentUpload(
      client as never,
      company,
      user,
      uploadId,
      'invoice.pdf',
      'application/pdf',
      undefined,
      { dedupeByContent: true },
    )

    expect(completed.document.id).toBe(existingId)
    expect(completed.document.deduplicated).toBe(true)
    expect(remove).toHaveBeenCalledWith([buildPendingDocumentStoragePath(company, user, uploadId, 'invoice.pdf')])
    expect(move).not.toHaveBeenCalled()
    // findReservedDocument + dedupe lookup, and never an insert
    expect(client.from).toHaveBeenCalledTimes(2)
  })

  it('keeps the SQLSTATE on a rejected document insert so callers can map an RLS denial', async () => {
    const buffer = pdfBuffer('viewer upload')
    results = [
      { data: null, error: null }, // findReservedDocument
      {
        data: null,
        error: {
          code: '42501',
          message: 'new row violates row-level security policy for table "document_attachments"',
        },
      },
      { data: null, error: null }, // concurrent-completion check
    ]
    const remove = vi.fn().mockResolvedValue({ data: [], error: null })
    serviceClientOverride = makeClient({
      download: vi.fn().mockResolvedValue({ data: new Blob([buffer]), error: null }),
      remove,
    })

    await expect(
      completePendingDocumentUpload(makeClient() as never, company, user, uploadId, 'invoice.pdf', 'application/pdf'),
    ).rejects.toMatchObject({ code: '42501' })
    // The moved object is taken back out: no row, no orphan.
    expect(remove).toHaveBeenCalledWith([buildReservedDocumentStoragePath(company, user, uploadId, 'invoice.pdf')])
  })

  it('codes a missing or expired reservation as DOCUMENT_UPLOAD_NOT_FOUND', async () => {
    results = [{ data: null, error: null }]
    serviceClientOverride = makeClient({
      download: vi.fn().mockResolvedValue({ data: null, error: { message: 'Object not found' } }),
    })

    await expect(
      completePendingDocumentUpload(makeClient() as never, company, user, uploadId, 'invoice.pdf', 'application/pdf'),
    ).rejects.toMatchObject({ code: 'DOCUMENT_UPLOAD_NOT_FOUND' })
  })

  it('cleans only expired pending objects in a bounded company and user prefix', async () => {
    const now = Date.parse('2026-08-03T10:00:00.000Z')
    const remove = vi.fn().mockResolvedValue({ data: [], error: null })
    const list = vi.fn().mockResolvedValue({
      data: [
        {
          id: 'old-object',
          name: `${uploadId}_old.pdf`,
          created_at: new Date(now - PENDING_DOCUMENT_UPLOAD_RETENTION_MS - 1).toISOString(),
        },
        {
          id: 'new-object',
          name: `${uploadId}_new.pdf`,
          created_at: new Date(now - 60_000).toISOString(),
        },
      ],
      error: null,
    })
    serviceClientOverride = makeClient({ list, remove })

    const removed = await cleanupExpiredPendingDocumentUploads(company, user, now)

    expect(list).toHaveBeenCalledWith(`documents/${company}/${user}/pending`, {
      limit: 100,
      offset: 0,
      sortBy: { column: 'created_at', order: 'asc' },
    })
    expect(remove).toHaveBeenCalledWith([
      `documents/${company}/${user}/pending/${uploadId}_old.pdf`,
    ])
    expect(removed).toBe(1)
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
      { data: { company_id: 'company-1' }, error: null }, // resolve owning company
      { data: current, error: null },                     // create_document_version RPC
      { data: newVersion, error: null },                  // fetch new version row
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

  it('writes the new version under the ORIGINAL document company prefix', async () => {
    results = [
      { data: { company_id: 'company-1' }, error: null },
      { data: 'doc-2', error: null },
      { data: makeDocumentAttachment({ id: 'doc-2', version: 2 }), error: null },
    ]

    const upload = vi.fn().mockResolvedValue({ data: {}, error: null })
    const supabase = makeClient({ upload })

    await createNewVersion(supabase as never, 'user-1', 'doc-1', {
      name: 'test-v2.pdf',
      buffer: pdfBuffer('new content'),
      type: 'application/pdf',
    })

    expect(upload.mock.calls[0]![0]).toMatch(
      /^documents\/company-1\/user-1\/\d+_test-v2\.pdf$/,
    )
  })

  it('refuses to upload when the original document cannot be resolved', async () => {
    results = [{ data: null, error: null }]

    const upload = vi.fn().mockResolvedValue({ data: {}, error: null })
    const supabase = makeClient({ upload })

    await expect(
      createNewVersion(supabase as never, 'user-1', 'doc-missing', {
        name: 'test-v2.pdf',
        buffer: pdfBuffer('new content'),
        type: 'application/pdf',
      }),
    ).rejects.toThrow(/original document not found/)
    expect(upload).not.toHaveBeenCalled()
  })

  it('cleans up the uploaded object via the service-role client when the version RPC fails', async () => {
    results = [
      { data: { company_id: 'company-1' }, error: null },  // resolve owning company
      { data: null, error: { message: 'rpc exploded' } },  // create_document_version RPC
    ]

    const serviceRemove = vi.fn().mockResolvedValue({ data: [], error: null })
    serviceClientOverride = makeClient({ remove: serviceRemove })

    const callerRemove = vi.fn().mockResolvedValue({ data: [], error: null })
    const upload = vi.fn().mockResolvedValue({ data: {}, error: null })
    const supabase = makeClient({ upload, remove: callerRemove })

    await expect(
      createNewVersion(supabase as never, 'user-1', 'doc-1', {
        name: 'test-v2.pdf',
        buffer: pdfBuffer('new content'),
        type: 'application/pdf',
      }),
    ).rejects.toThrow(/Failed to create new version: rpc exploded/)

    // WORM bucket: the cleanup must go through the service-role client, not
    // the caller-bound client (whose remove() RLS silently blocks).
    const uploadedKey = upload.mock.calls[0]![0] as string
    expect(serviceRemove).toHaveBeenCalledWith([uploadedKey])
    expect(callerRemove).not.toHaveBeenCalled()
  })
})

describe('storage key layout helpers', () => {
  const company = '11111111-1111-4111-8111-111111111111'
  const user = '22222222-2222-4222-8222-222222222222'

  it('builds a company-scoped key and sanitizes the filename', () => {
    // sanitizeFileName replaces non-ASCII with '_', collapses runs, and trims
    // leading/trailing underscores: "Kvitto å ä ö" ends up as "Kvitto".
    expect(buildDocumentStoragePath(company, user, 'Kvitto å ä ö.pdf', 1700000000000)).toBe(
      `documents/${company}/${user}/1700000000000_Kvitto.pdf`,
    )
    expect(buildDocumentStoragePath(company, user, 'faktura 2026-05.pdf', 1700000000000)).toBe(
      `documents/${company}/${user}/1700000000000_faktura_2026-05.pdf`,
    )
  })

  it('builds deterministic pending and permanent keys for a reserved upload', () => {
    const uploadId = '33333333-3333-4333-8333-333333333333'
    expect(buildPendingDocumentStoragePath(company, user, uploadId, 'faktura 1.pdf')).toBe(
      `documents/${company}/${user}/pending/${uploadId}_faktura_1.pdf`,
    )
    expect(buildReservedDocumentStoragePath(company, user, uploadId, 'faktura 1.pdf')).toBe(
      `documents/${company}/${user}/${uploadId}_faktura_1.pdf`,
    )
  })

  it('recognises company-scoped keys', () => {
    expect(isCompanyScopedDocumentPath(`documents/${company}/${user}/1_a.pdf`, company)).toBe(true)
    expect(isCompanyScopedDocumentPath(`documents/${user}/1_a.pdf`, company)).toBe(false)
  })

  it('translates legacy to company-scoped and back', () => {
    const legacy = `documents/${user}/1_a.pdf`
    const scoped = `documents/${company}/${user}/1_a.pdf`
    expect(companyScopedDocumentPath(legacy, company)).toBe(scoped)
    expect(legacyDocumentPath(scoped, company)).toBe(legacy)
    // Already in the target layout: no translation offered.
    expect(companyScopedDocumentPath(scoped, company)).toBeNull()
    expect(legacyDocumentPath(legacy, company)).toBeNull()
  })

  it('offers no alternate for keys outside the documents/ root', () => {
    // The MCP audit-package tool writes `{userId}/audit-packages/...`, which
    // is not a document_attachments key and must never be rewritten.
    const foreign = `${user}/audit-packages/1_archive.zip`
    expect(companyScopedDocumentPath(foreign, company)).toBeNull()
    expect(documentStoragePathCandidates(foreign, company)).toEqual([foreign])
  })

  it('lists the stored pointer first, then the alternate layout', () => {
    const legacy = `documents/${user}/1_a.pdf`
    const scoped = `documents/${company}/${user}/1_a.pdf`
    expect(documentStoragePathCandidates(legacy, company)).toEqual([legacy, scoped])
    expect(documentStoragePathCandidates(scoped, company)).toEqual([scoped, legacy])
    // No companyId: nothing to derive, stored pointer only.
    expect(documentStoragePathCandidates(legacy, null)).toEqual([legacy])
  })
})

describe('dual-layout read helpers', () => {
  const company = 'company-1'
  const user = 'user-1'
  const legacy = `documents/${user}/1_a.pdf`
  const scoped = `documents/${company}/${user}/1_a.pdf`

  it('downloadDocumentObject falls back to the company-scoped key', async () => {
    const download = vi.fn(async (path: string) =>
      path === scoped
        ? { data: new Blob(['ok']), error: null }
        : { data: null, error: { message: 'Object not found' } },
    )
    const supabase = makeClient({ download })

    const result = await downloadDocumentObject(supabase as never, legacy, company)

    expect(result.blob).not.toBeNull()
    expect(result.resolvedPath).toBe(scoped)
    expect(download).toHaveBeenCalledTimes(2)
    expect(download.mock.calls[0]![0]).toBe(legacy)
  })

  it('downloadDocumentObject falls back to the legacy key', async () => {
    const download = vi.fn(async (path: string) =>
      path === legacy
        ? { data: new Blob(['ok']), error: null }
        : { data: null, error: { message: 'Object not found' } },
    )
    const supabase = makeClient({ download })

    const result = await downloadDocumentObject(supabase as never, scoped, company)
    expect(result.resolvedPath).toBe(legacy)
  })

  it('downloadDocumentObject reports the stored-pointer error when both fail', async () => {
    const download = vi.fn(async (path: string) => ({
      data: null,
      error: { message: `missing:${path}` },
    }))
    const supabase = makeClient({ download })

    const result = await downloadDocumentObject(supabase as never, legacy, company)
    expect(result.blob).toBeNull()
    expect(result.resolvedPath).toBeNull()
    expect(result.error?.message).toBe(`missing:${legacy}`)
  })

  it('createDocumentSignedUrl falls back to the alternate layout', async () => {
    const createSignedUrl = vi.fn(async (path: string) =>
      path === scoped
        ? { data: { signedUrl: 'https://example.com/signed' }, error: null }
        : { data: null, error: { message: 'Object not found' } },
    )
    const supabase = makeClient({ createSignedUrl })

    const result = await createDocumentSignedUrl(supabase as never, legacy, company, 3600)
    expect(result.signedUrl).toBe('https://example.com/signed')
    expect(result.resolvedPath).toBe(scoped)
  })
})

describe('deleteDocument', () => {
  it('removes BOTH key layouts via the service-role client so no readable orphan copy survives', async () => {
    const company = 'company-1'
    const legacy = 'documents/user-1/1_a.pdf'

    results = [
      {
        data: {
          id: 'doc-1',
          file_name: 'a.pdf',
          storage_path: legacy,
          journal_entry_id: null,
          user_id: 'user-1',
        },
        error: null,
      },
      { data: null, error: null }, // delete
    ]

    const serviceRemove = vi.fn().mockResolvedValue({ data: [], error: null })
    serviceClientOverride = makeClient({ remove: serviceRemove })

    const callerRemove = vi.fn().mockResolvedValue({ data: [], error: null })
    const supabase = makeClient({ remove: callerRemove })

    const result = await deleteDocument(supabase as never, company, 'doc-1')

    expect(result.ok).toBe(true)
    expect(serviceRemove).toHaveBeenCalledWith([legacy, `documents/${company}/user-1/1_a.pdf`])
    // The documents bucket is WORM (no DELETE policy on storage.objects): a
    // caller-bound remove() is silently blocked by RLS and reports success
    // without deleting, so it must never be used for the removal.
    expect(callerRemove).not.toHaveBeenCalled()
  })

  it('does not touch storage when the company-filtered fetch finds nothing (authz-first)', async () => {
    results = [{ data: null, error: null }]

    const serviceRemove = vi.fn().mockResolvedValue({ data: [], error: null })
    serviceClientOverride = makeClient({ remove: serviceRemove })

    const result = await deleteDocument(makeClient() as never, 'company-1', 'doc-1')

    expect(result).toMatchObject({ ok: false, reason: 'not_found', status: 404 })
    expect(serviceRemove).not.toHaveBeenCalled()
  })

  it('refuses to delete a document linked to a journal entry (BFL 7 kap 2§)', async () => {
    results = [
      {
        data: {
          id: 'doc-1',
          file_name: 'a.pdf',
          storage_path: 'documents/user-1/1_a.pdf',
          journal_entry_id: 'entry-1',
          user_id: 'user-1',
        },
        error: null,
      },
    ]

    const serviceRemove = vi.fn().mockResolvedValue({ data: [], error: null })
    serviceClientOverride = makeClient({ remove: serviceRemove })

    const callerRemove = vi.fn().mockResolvedValue({ data: [], error: null })
    const supabase = makeClient({ remove: callerRemove })

    const result = await deleteDocument(supabase as never, 'company-1', 'doc-1')

    expect(result).toMatchObject({ ok: false, reason: 'linked_to_entry', status: 409 })
    expect(callerRemove).not.toHaveBeenCalled()
    expect(serviceRemove).not.toHaveBeenCalled()
  })

  it('keeps the storage objects when the DB row delete is blocked by the trigger', async () => {
    results = [
      {
        data: {
          id: 'doc-1',
          file_name: 'a.pdf',
          storage_path: 'documents/user-1/1_a.pdf',
          journal_entry_id: null,
          user_id: 'user-1',
        },
        error: null,
      },
      { data: null, error: { message: 'blocked by Bokföringslagen retention trigger' } },
    ]

    const serviceRemove = vi.fn().mockResolvedValue({ data: [], error: null })
    serviceClientOverride = makeClient({ remove: serviceRemove })

    const result = await deleteDocument(makeClient() as never, 'company-1', 'doc-1')

    expect(result).toMatchObject({ ok: false, reason: 'linked_to_entry', status: 409 })
    expect(serviceRemove).not.toHaveBeenCalled()
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

    // The download runs on the service-role client; give it matching bytes.
    serviceClientOverride = makeClient({
      download: vi.fn().mockResolvedValue({
        data: new Blob([content]),
        error: null,
      }),
    })

    const result = await verifyIntegrity(makeClient() as never, 'user-1', 'doc-1')
    expect(result.valid).toBe(true)
    expect(result.storedHash).toBe(expectedHash)
    expect(result.computedHash).toBe(expectedHash)
  })

  it('returns invalid when hashes do not match', async () => {
    results = [
      { data: { storage_path: 'docs/test.pdf', sha256_hash: 'stored-hash-abc' }, error: null },
    ]

    serviceClientOverride = makeClient({
      download: vi.fn().mockResolvedValue({
        data: new Blob(['different content']),
        error: null,
      }),
    })

    const result = await verifyIntegrity(makeClient() as never, 'user-1', 'doc-1')
    expect(result.valid).toBe(false)
    expect(result.storedHash).toBe('stored-hash-abc')
    expect(result.computedHash).not.toBe('stored-hash-abc')
  })
})

describe('validated mime type persistence (stored type is what the bytes are)', () => {
  const company = '11111111-1111-4111-8111-111111111111'
  const user = '22222222-2222-4222-8222-222222222222'
  const uploadId = '33333333-3333-4333-8333-333333333333'

  // 16-byte ISO-BMFF ftyp box with the given major brand (see the HEIC tests).
  const isoBmff = (brand: string): ArrayBuffer => {
    const bytes = new Uint8Array(16)
    bytes[3] = 16
    bytes.set([0x66, 0x74, 0x79, 0x70], 4)
    bytes.set(new TextEncoder().encode(brand), 8)
    return bytes.buffer as ArrayBuffer
  }
  const pngBytes = (): ArrayBuffer =>
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer as ArrayBuffer
  const textBytes = (text: string): ArrayBuffer => {
    const bytes = new TextEncoder().encode(text)
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  }

  function insertPayloadOf(client: ReturnType<typeof makeClient>, fromIndex: number) {
    const builder = client.from.mock.results[fromIndex]?.value as { insert: ReturnType<typeof vi.fn> }
    return builder.insert.mock.calls[0]?.[0] as Record<string, unknown> | undefined
  }

  describe('resolveStoredMimeType', () => {
    it('returns the sniffed type for binary formats, including the HEIC/HEIF family swap', () => {
      expect(resolveStoredMimeType(pdfBuffer(), 'application/pdf')).toBe('application/pdf')
      expect(resolveStoredMimeType(pngBytes(), 'image/png')).toBe('image/png')
      expect(resolveStoredMimeType(isoBmff('heic'), 'image/heif')).toBe('image/heic')
      expect(resolveStoredMimeType(isoBmff('mif1'), 'image/heic')).toBe('image/heif')
    })

    it('keeps the declared type for the shape-checked text formats (no magic number)', () => {
      expect(resolveStoredMimeType(textBytes('<?xml version="1.0"?><Invoice/>'), 'application/xml')).toBe('application/xml')
      expect(resolveStoredMimeType(textBytes('<?xml version="1.0"?><Invoice/>'), 'text/xml')).toBe('text/xml')
      expect(resolveStoredMimeType(textBytes('<!doctype html><html></html>'), 'text/html')).toBe('text/html')
      expect(resolveStoredMimeType(textBytes('<?xml version="1.0"?><html/>'), 'application/xhtml+xml')).toBe('application/xhtml+xml')
      expect(resolveStoredMimeType(textBytes('{"a":1}'), 'application/json')).toBe('application/json')
    })

    it('sniffs an undeclared type and stores null rather than an unverified string', () => {
      expect(resolveStoredMimeType(pdfBuffer(), undefined)).toBe('application/pdf')
      expect(resolveStoredMimeType(pdfBuffer(), '')).toBe('application/pdf')
      expect(resolveStoredMimeType(textBytes('just text'), undefined)).toBeNull()
    })
  })

  it('uploadDocument stores and stamps the sniffed type, not the declared one', async () => {
    results = [{ data: makeDocumentAttachment({ id: 'doc-1' }), error: null }]
    const upload = vi.fn().mockResolvedValue({ data: {}, error: null })
    const client = makeClient({ upload })

    await uploadDocument(client as never, 'user-1', 'company-1', {
      name: 'IMG_0001.heif',
      buffer: isoBmff('heic'),
      type: 'image/heif',
    })

    expect(insertPayloadOf(client, 0)?.mime_type).toBe('image/heic')
    expect((upload.mock.calls[0]?.[2] as { contentType: string }).contentType).toBe('image/heic')
  })

  it('uploadDocument sniffs an undeclared type instead of storing null for a real PDF', async () => {
    results = [{ data: makeDocumentAttachment({ id: 'doc-1' }), error: null }]
    const upload = vi.fn().mockResolvedValue({ data: {}, error: null })
    const client = makeClient({ upload })

    await uploadDocument(client as never, 'user-1', 'company-1', {
      name: 'kvitto.pdf',
      buffer: pdfBuffer('undeclared'),
    })

    expect(insertPayloadOf(client, 0)?.mime_type).toBe('application/pdf')
    expect((upload.mock.calls[0]?.[2] as { contentType: string }).contentType).toBe('application/pdf')
  })

  it('completePendingDocumentUpload persists the sniffed type', async () => {
    const buffer = isoBmff('heic')
    const document = makeDocumentAttachment({
      id: uploadId,
      mime_type: 'image/heic',
      sha256_hash: await computeSHA256(buffer),
    })
    results = [
      { data: null, error: null },
      { data: document, error: null },
    ]
    serviceClientOverride = makeClient({
      download: vi.fn().mockResolvedValue({ data: new Blob([buffer]), error: null }),
    })
    const client = makeClient()

    await completePendingDocumentUpload(client as never, company, user, uploadId, 'IMG_0001.heif', 'image/heif')

    expect(insertPayloadOf(client, 1)?.mime_type).toBe('image/heic')
  })

  it('completePendingDocumentUpload retry accepts the stored family member for the declared one', async () => {
    const buffer = isoBmff('heic')
    const document = makeDocumentAttachment({
      id: uploadId,
      user_id: user,
      company_id: company,
      file_name: 'IMG_0001.heif',
      mime_type: 'image/heic',
      storage_path: buildReservedDocumentStoragePath(company, user, uploadId, 'IMG_0001.heif'),
      sha256_hash: await computeSHA256(buffer),
    })
    results = [{ data: document, error: null }]
    const move = vi.fn().mockResolvedValue({ data: {}, error: null })
    serviceClientOverride = makeClient({
      download: vi.fn().mockResolvedValue({ data: new Blob([buffer]), error: null }),
      move,
    })

    const completed = await completePendingDocumentUpload(
      makeClient() as never,
      company,
      user,
      uploadId,
      'IMG_0001.heif',
      'image/heif',
    )

    expect(completed.document).toEqual(document)
    expect(move).not.toHaveBeenCalled()
  })

  it('completePendingDocumentUpload retry still rejects a genuinely different stored type', async () => {
    const buffer = isoBmff('heic')
    const document = makeDocumentAttachment({
      id: uploadId,
      file_name: 'IMG_0001.heif',
      mime_type: 'image/jpeg',
      sha256_hash: await computeSHA256(buffer),
    })
    results = [{ data: document, error: null }]
    serviceClientOverride = makeClient({
      download: vi.fn().mockResolvedValue({ data: new Blob([buffer]), error: null }),
    })

    await expect(
      completePendingDocumentUpload(makeClient() as never, company, user, uploadId, 'IMG_0001.heif', 'image/heif'),
    ).rejects.toThrow(/different file metadata/)
  })

  it('createNewVersion passes the sniffed type to the versioning RPC and the storage object', async () => {
    results = [
      { data: { company_id: 'company-1' }, error: null },
      { data: 'doc-2', error: null },
      { data: makeDocumentAttachment({ id: 'doc-2', version: 2 }), error: null },
    ]
    const upload = vi.fn().mockResolvedValue({ data: {}, error: null })
    const client = makeClient({ upload })

    await createNewVersion(client as never, 'user-1', 'doc-1', {
      name: 'IMG_0002.heif',
      buffer: isoBmff('heic'),
      type: 'image/heif',
    })

    expect((client.rpc.mock.calls[0]?.[1] as { p_mime_type: string }).p_mime_type).toBe('image/heic')
    expect((upload.mock.calls[0]?.[2] as { contentType: string }).contentType).toBe('image/heic')
  })
})
