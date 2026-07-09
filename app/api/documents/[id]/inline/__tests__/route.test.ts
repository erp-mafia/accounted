import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  parseJsonResponse,
  createMockRouteParams,
  createQueuedMockSupabase,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

const downloadMock = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    storage: {
      from: () => ({ download: downloadMock }),
    },
  }),
}))

import { GET } from '../route'
import { NextResponse } from 'next/server'

const mockUser = { id: 'user-1', email: 'test@test.se' }

// NFD filename as macOS/iOS uploads produce them: o + combining diaeresis
// U+0308 (char code 776). This is the exact shape that made the raw header
// build throw in prod (undici Headers require code units <= 0xFF).
const NFD_FILE_NAME = 'kvitto fo\u0308rvaring.pdf'

function makeDoc(overrides: Record<string, unknown> = {}) {
  return {
    id: 'doc-1',
    company_id: 'company-1',
    file_name: NFD_FILE_NAME,
    mime_type: 'application/pdf',
    storage_path: 'documents/user-1/doc-1.pdf',
    ...overrides,
  }
}

function makeReq() {
  return new Request('http://localhost/api/documents/doc-1/inline')
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: mockUser, supabase: mockSupabase, error: null })
  downloadMock.mockResolvedValue({ data: new Blob(['%PDF-1.4']), error: null })
})

describe('GET /api/documents/[id]/inline', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await GET(makeReq(), createMockRouteParams({ id: 'doc-1' }))
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(401)
  })

  it('returns 404 when the document is not found', async () => {
    enqueue({ data: null, error: { message: 'not found' } }) // doc lookup
    const res = await GET(makeReq(), createMockRouteParams({ id: 'doc-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(res)
    expect(status).toBe(404)
    expect(body.error).toBe('Document not found')
  })

  it('returns 404 when the user is not a member of the document company', async () => {
    enqueue({ data: makeDoc(), error: null }) // doc lookup
    enqueue({ data: null, error: null }) // membership lookup
    const res = await GET(makeReq(), createMockRouteParams({ id: 'doc-1' }))
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(404)
  })

  it('returns 500 when the storage download fails', async () => {
    enqueue({ data: makeDoc(), error: null })
    enqueue({ data: { company_id: 'company-1' }, error: null })
    downloadMock.mockResolvedValue({ data: null, error: { message: 'boom' } })
    const res = await GET(makeReq(), createMockRouteParams({ id: 'doc-1' }))
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(500)
  })

  it('streams the file with an RFC 5987 Content-Disposition for an NFD filename', async () => {
    enqueue({ data: makeDoc(), error: null })
    enqueue({ data: { company_id: 'company-1' }, error: null })

    const res = await GET(makeReq(), createMockRouteParams({ id: 'doc-1' }))

    expect(res.status).toBe(200)
    const disposition = res.headers.get('Content-Disposition') ?? ''
    expect(disposition).toContain('inline')
    // Extended form carries the NFC-composed UTF-8 percent-encoded name.
    expect(disposition).toContain(`filename*=UTF-8''kvitto%20f%C3%B6rvaring.pdf`)
    // ASCII fallback replaces the non-ASCII character.
    expect(disposition).toContain('filename="kvitto f_rvaring.pdf"')
    expect(res.headers.get('Content-Type')).toBe('application/pdf')
  })
})
