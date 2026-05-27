import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { makeDocumentAttachment } from '@/tests/helpers'

// ============================================================
// Mock — separate client (no .then) from query builder (thenable)
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

import { uploadDocument, createNewVersion, verifyIntegrity, _resetBucketVerified } from '../document-service'

// A minimal valid PDF byte sequence (header + EOF) — passes magic-byte check.
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
