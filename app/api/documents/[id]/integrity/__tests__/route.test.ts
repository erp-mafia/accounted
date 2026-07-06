import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  parseJsonResponse,
  createMockRouteParams,
  createQueuedMockSupabase,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/core/documents/document-service', () => ({
  validateDocumentMagicBytes: vi.fn(),
}))

import { GET } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { validateDocumentMagicBytes } from '@/lib/core/documents/document-service'
import { NextResponse } from 'next/server'

// v4 UUIDs (variant 'a' / 'b' in the 4th group) so Zod's stricter validators
// accept them: the looser `2222...` style fails on the variant check.
const mockUser = { id: '11111111-1111-4111-a111-111111111111' }
const validDocId = '22222222-2222-4222-a222-222222222222'
const companyId = '33333333-3333-4333-a333-333333333333'

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  vi.mocked(requireAuth).mockResolvedValue({
    user: mockUser as never,
    supabase: mockSupabase as never,
    error: null,
  })
})

function req() {
  return new Request(`http://localhost/api/documents/${validDocId}/integrity`)
}

describe('GET /api/documents/[id]/integrity', () => {
  it('returns 401 when the user is not authenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      user: null as never,
      supabase: mockSupabase as never,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const res = await GET(req(), createMockRouteParams({ id: validDocId }))
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(401)
  })

  it('returns 400 when id is not a UUID', async () => {
    const res = await GET(req(), createMockRouteParams({ id: 'not-a-uuid' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(res)
    expect(status).toBe(400)
    expect(body.error).toMatch(/invalid/i)
  })

  it('returns 404 when document is not found or is superseded', async () => {
    enqueue({ data: null, error: null })
    const res = await GET(req(), createMockRouteParams({ id: validDocId }))
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(404)
  })

  it('returns 404 when caller is not a member of the document company', async () => {
    enqueue({
      data: {
        id: validDocId,
        company_id: companyId,
        mime_type: 'application/pdf',
        storage_path: 'documents/foo/bar.pdf',
      },
      error: null,
    })
    enqueue({ data: null, error: null }) // membership check returns null
    const res = await GET(req(), createMockRouteParams({ id: validDocId }))
    const { status, body } = await parseJsonResponse<{ error: string }>(res)
    expect(status).toBe(404)
    // The endpoint deliberately returns the same 404 as missing-document so
    // the response cannot be used to enumerate documents across companies.
    expect(body.error).toBe('Document not found')
  })

  it('returns { valid: true } and skips download when mime_type is null', async () => {
    enqueue({
      data: {
        id: validDocId,
        company_id: companyId,
        mime_type: null,
        storage_path: 'documents/foo/bar.pdf',
      },
      error: null,
    })
    enqueue({ data: { company_id: companyId }, error: null }) // membership

    const res = await GET(req(), createMockRouteParams({ id: validDocId }))
    const { status, body } = await parseJsonResponse<{ data: { valid: boolean } }>(res)
    expect(status).toBe(200)
    expect(body.data.valid).toBe(true)
    expect(mockSupabase.storage.from).not.toHaveBeenCalled()
  })

  it('returns { valid: true } when the bytes match the declared mime type', async () => {
    enqueue({
      data: {
        id: validDocId,
        company_id: companyId,
        mime_type: 'application/pdf',
        storage_path: 'documents/foo/bar.pdf',
      },
      error: null,
    })
    enqueue({ data: { company_id: companyId }, error: null })

    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])
    const blob = new Blob([pdfBytes], { type: 'application/pdf' })
    mockSupabase.storage.from.mockReturnValue({
      download: vi.fn().mockResolvedValue({ data: blob, error: null }),
    } as never)

    vi.mocked(validateDocumentMagicBytes).mockReturnValue(null)

    const res = await GET(req(), createMockRouteParams({ id: validDocId }))
    const { status, body } = await parseJsonResponse<{ data: { valid: boolean } }>(res)
    expect(status).toBe(200)
    expect(body.data.valid).toBe(true)
    expect(Object.keys(body.data)).toEqual(['valid'])
  })

  it('returns { valid: false } without leaking the reason text', async () => {
    enqueue({
      data: {
        id: validDocId,
        company_id: companyId,
        mime_type: 'application/pdf',
        storage_path: 'documents/foo/bar.pdf',
      },
      error: null,
    })
    enqueue({ data: { company_id: companyId }, error: null })

    const blob = new Blob([new Uint8Array([0x00, 0x00, 0x00, 0x00])])
    mockSupabase.storage.from.mockReturnValue({
      download: vi.fn().mockResolvedValue({ data: blob, error: null }),
    } as never)

    vi.mocked(validateDocumentMagicBytes).mockReturnValue('Internal /storage/v1/object error 42')

    const res = await GET(req(), createMockRouteParams({ id: validDocId }))
    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(res)
    expect(status).toBe(200)
    expect(body.data.valid).toBe(false)
    // The whole point of the V1.2.5 / Art 25(2) hardening: internal text
    // never appears in the response.
    expect(body.data.reason).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain('storage/v1/object')
  })

  it('returns a generic 500 without leaking the underlying storage error', async () => {
    enqueue({
      data: {
        id: validDocId,
        company_id: companyId,
        mime_type: 'application/pdf',
        storage_path: 'documents/foo/bar.pdf',
      },
      error: null,
    })
    enqueue({ data: { company_id: companyId }, error: null })

    mockSupabase.storage.from.mockReturnValue({
      download: vi.fn().mockResolvedValue({
        data: null,
        error: { message: 'storage internal: bucket=documents object=secret/path.pdf' },
      }),
    } as never)

    const res = await GET(req(), createMockRouteParams({ id: validDocId }))
    const { status, body } = await parseJsonResponse<{ error: string }>(res)
    expect(status).toBe(500)
    expect(body.error).toBe('Integrity check unavailable')
    expect(JSON.stringify(body)).not.toContain('secret/path.pdf')
  })

  it('does not import the service-role supabase client', async () => {
    // The download must go through the per-request user-scoped client so
    // RLS on storage.objects can act as defense-in-depth. Statically
    // verifying the source is the cleanest check: runtime mocking of the
    // service-client export would not catch a future regression where
    // someone added an import but conditionally used it.
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const routePath = path.resolve(__dirname, '../route.ts')
    const source = await fs.readFile(routePath, 'utf8')
    expect(source).not.toMatch(/createServiceClient(\b|NoCookies)/)
  })

  it('filters the document lookup to the current version', async () => {
    // The route's first `from('document_attachments')` chain must include
    // `.eq('is_current_version', true)` so superseded versions cannot have
    // their bytes probed via this surface. Source-level check rather than
    // runtime spying: the proxy-based queued mock collapses every chained
    // method into the same handler, so introspecting individual .eq calls
    // is not feasible without rebuilding the mock.
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const routePath = path.resolve(__dirname, '../route.ts')
    const source = await fs.readFile(routePath, 'utf8')
    expect(source).toMatch(/\.eq\(['"]is_current_version['"],\s*true\)/)
  })
})
