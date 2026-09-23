import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
  createQueuedMockSupabase,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const mockRequireWrite = vi.fn().mockResolvedValue({ ok: true })
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => mockRequireWrite(...args),
}))

import { POST, DELETE } from '../route'

const mockUser = { id: 'user-1', email: 'test@test.se' }

describe('POST /api/bookkeeping/journal-entries/[id]/no-document-required', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockRequireWrite.mockResolvedValue({ ok: true })
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

    const request = createMockRequest(
      '/api/bookkeeping/journal-entries/entry-1/no-document-required',
      { method: 'POST', body: { reason: 'Bankavgift' } }
    )
    const response = await POST(request, createMockRouteParams({ id: 'entry-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns 403 when the user only has read access', async () => {
    mockRequireWrite.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: 'forbidden' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }),
    })

    const request = createMockRequest(
      '/api/bookkeeping/journal-entries/entry-1/no-document-required',
      { method: 'POST', body: {} }
    )
    const response = await POST(request, createMockRouteParams({ id: 'entry-1' }))

    expect(response.status).toBe(403)
  })

  it('returns 404 when the entry does not belong to the active company', async () => {
    enqueue({ data: null, error: null }) // journal_entries lookup misses

    const request = createMockRequest(
      '/api/bookkeeping/journal-entries/entry-1/no-document-required',
      { method: 'POST', body: { reason: 'Bankavgift' } }
    )
    const response = await POST(request, createMockRouteParams({ id: 'entry-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(404)
    expect(body).toEqual({ error: 'Verifikationen hittades inte.' })
  })

  it('rejects a reason longer than 200 chars (Zod validation)', async () => {
    const longReason = 'a'.repeat(201)

    const request = createMockRequest(
      '/api/bookkeeping/journal-entries/entry-1/no-document-required',
      { method: 'POST', body: { reason: longReason } }
    )
    const response = await POST(request, createMockRouteParams({ id: 'entry-1' }))

    expect(response.status).toBe(400)
  })

  it('upserts the exemption and returns exempted: true', async () => {
    enqueue({ data: { id: 'entry-1' }, error: null }) // entry lookup
    enqueue({ data: null, error: null }) // upsert

    const request = createMockRequest(
      '/api/bookkeeping/journal-entries/entry-1/no-document-required',
      { method: 'POST', body: { reason: 'Bankavgift' } }
    )
    const response = await POST(request, createMockRouteParams({ id: 'entry-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(body).toEqual({ data: { exempted: true } })
  })

  it('accepts an empty body (no reason)', async () => {
    enqueue({ data: { id: 'entry-1' }, error: null })
    enqueue({ data: null, error: null })

    const request = createMockRequest(
      '/api/bookkeeping/journal-entries/entry-1/no-document-required',
      { method: 'POST', body: {} }
    )
    const response = await POST(request, createMockRouteParams({ id: 'entry-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(body).toEqual({ data: { exempted: true } })
  })
})

describe('DELETE /api/bookkeeping/journal-entries/[id]/no-document-required', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockRequireWrite.mockResolvedValue({ ok: true })
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

    const request = createMockRequest(
      '/api/bookkeeping/journal-entries/entry-1/no-document-required',
      { method: 'DELETE' }
    )
    const response = await DELETE(request, createMockRouteParams({ id: 'entry-1' }))
    expect(response.status).toBe(401)
  })

  it('returns exempted: false on successful delete', async () => {
    enqueue({ data: null, error: null }) // delete

    const request = createMockRequest(
      '/api/bookkeeping/journal-entries/entry-1/no-document-required',
      { method: 'DELETE' }
    )
    const response = await DELETE(request, createMockRouteParams({ id: 'entry-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(body).toEqual({ data: { exempted: false } })
  })
})
