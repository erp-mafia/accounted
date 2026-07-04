import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  createMockRouteParams,
  parseJsonResponse,
  createQueuedMockSupabase,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

const getActiveCompanyIdMock = vi.fn()
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: (...args: unknown[]) => getActiveCompanyIdMock(...args),
}))

const requireWritePermissionMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWritePermissionMock(...args),
}))

import { GET, POST } from '../route'
import { PATCH } from '../[id]/route'

const mockUser = { id: 'user-1', email: 'test@test.se' }

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  getActiveCompanyIdMock.mockResolvedValue('company-1')
  requireWritePermissionMock.mockResolvedValue({ ok: true })
})

describe('GET /api/agent/memory', () => {
  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const response = await GET(createMockRequest('/api/agent/memory'))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)
    expect(status).toBe(401)
    expect(body.error).toBe('Unauthorized')
  })

  it('returns 400 when no active company', async () => {
    getActiveCompanyIdMock.mockResolvedValue(null)
    const response = await GET(createMockRequest('/api/agent/memory'))
    const { status } = await parseJsonResponse(response)
    expect(status).toBe(400)
  })

  it('returns rows for the active company', async () => {
    const rows = [
      {
        id: 'mem-1',
        kind: 'fact',
        content: 'Räkenskapsår jan-dec',
        source: 'composer',
        source_ref: null,
        relevance_score: 0.5,
        is_pinned: false,
        is_active: true,
        last_accessed_at: null,
        created_at: '2026-05-10T09:00:00Z',
        updated_at: '2026-05-10T09:00:00Z',
      },
    ]
    enqueue({ data: rows })
    const response = await GET(createMockRequest('/api/agent/memory'))
    const { status, body } = await parseJsonResponse<{ data: typeof rows }>(response)
    expect(status).toBe(200)
    expect(body.data).toHaveLength(1)
    expect(body.data[0].id).toBe('mem-1')
  })

  it('does not require write permission for read', async () => {
    enqueue({ data: [] })
    await GET(createMockRequest('/api/agent/memory'))
    expect(requireWritePermissionMock).not.toHaveBeenCalled()
  })
})

describe('POST /api/agent/memory', () => {
  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const response = await POST(
      createMockRequest('/api/agent/memory', {
        method: 'POST',
        body: { content: 'hello world' },
      }),
    )
    expect(response.status).toBe(401)
  })

  it('blocks viewers via requireWritePermission', async () => {
    const { NextResponse } = await import('next/server')
    requireWritePermissionMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'forbidden' }, { status: 403 }),
    })
    const response = await POST(
      createMockRequest('/api/agent/memory', {
        method: 'POST',
        body: { content: 'hello world' },
      }),
    )
    expect(response.status).toBe(403)
  })

  it('rejects too-short content', async () => {
    const response = await POST(
      createMockRequest('/api/agent/memory', {
        method: 'POST',
        body: { content: 'x' },
      }),
    )
    expect(response.status).toBe(400)
  })

  it('inserts and returns the row on happy path', async () => {
    const inserted = {
      id: 'mem-2',
      kind: 'fact',
      content: 'En sak att komma ihåg',
      source: 'user_taught',
      source_ref: null,
      relevance_score: 1,
      is_pinned: false,
      is_active: true,
      last_accessed_at: null,
      created_at: '2026-05-18T10:00:00Z',
      updated_at: '2026-05-18T10:00:00Z',
    }
    // Defense-in-depth: body company_id membership re-check happens after
    // requireWritePermission. POST flow now is: (1) company_members lookup,
    // (2) insert.
    enqueue({ data: { role: 'member' } })
    enqueue({ data: inserted })
    const response = await POST(
      createMockRequest('/api/agent/memory', {
        method: 'POST',
        body: { content: 'En sak att komma ihåg' },
      }),
    )
    const { status, body } = await parseJsonResponse<{ data: typeof inserted }>(response)
    expect(status).toBe(200)
    expect(body.data.id).toBe('mem-2')
  })

  it('rejects when user is a viewer in the target company', async () => {
    enqueue({ data: { role: 'viewer' } })
    const response = await POST(
      createMockRequest('/api/agent/memory', {
        method: 'POST',
        body: { content: 'En sak att komma ihåg' },
      }),
    )
    expect(response.status).toBe(403)
  })
})

describe('PATCH /api/agent/memory/[id]', () => {
  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const response = await PATCH(
      createMockRequest('/api/agent/memory/mem-1', {
        method: 'PATCH',
        body: { is_pinned: true },
      }),
      createMockRouteParams({ id: 'mem-1' }),
    )
    expect(response.status).toBe(401)
  })

  it('blocks viewers via requireWritePermission', async () => {
    const { NextResponse } = await import('next/server')
    requireWritePermissionMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'forbidden' }, { status: 403 }),
    })
    const response = await PATCH(
      createMockRequest('/api/agent/memory/mem-1', {
        method: 'PATCH',
        body: { is_pinned: true },
      }),
      createMockRouteParams({ id: 'mem-1' }),
    )
    expect(response.status).toBe(403)
  })

  it('rejects empty patch body', async () => {
    const response = await PATCH(
      createMockRequest('/api/agent/memory/mem-1', { method: 'PATCH', body: {} }),
      createMockRouteParams({ id: 'mem-1' }),
    )
    expect(response.status).toBe(400)
  })

  it('returns 404 when row not found / not visible via RLS', async () => {
    // Row lookup returns null → defense-in-depth 404 before update.
    enqueue({ data: null })
    const response = await PATCH(
      createMockRequest('/api/agent/memory/mem-x', {
        method: 'PATCH',
        body: { is_pinned: true },
      }),
      createMockRouteParams({ id: 'mem-x' }),
    )
    expect(response.status).toBe(404)
  })

  it('returns 404 when user has no membership in row company', async () => {
    enqueue({ data: { company_id: 'company-2' } })
    enqueue({ data: null }) // company_members lookup
    const response = await PATCH(
      createMockRequest('/api/agent/memory/mem-1', {
        method: 'PATCH',
        body: { is_pinned: true },
      }),
      createMockRouteParams({ id: 'mem-1' }),
    )
    expect(response.status).toBe(404)
  })

  it('pins a row', async () => {
    const updated = {
      id: 'mem-1',
      kind: 'fact',
      content: 'X',
      source: 'composer',
      source_ref: null,
      relevance_score: 0.5,
      is_pinned: true,
      is_active: true,
      last_accessed_at: null,
      created_at: '2026-05-10T09:00:00Z',
      updated_at: '2026-05-18T10:00:00Z',
    }
    // PATCH flow: (1) row lookup, (2) membership lookup, (3) update.
    enqueue({ data: { company_id: 'company-1' } })
    enqueue({ data: { role: 'member' } })
    enqueue({ data: updated })
    const response = await PATCH(
      createMockRequest('/api/agent/memory/mem-1', {
        method: 'PATCH',
        body: { is_pinned: true },
      }),
      createMockRouteParams({ id: 'mem-1' }),
    )
    const { status, body } = await parseJsonResponse<{ data: typeof updated }>(response)
    expect(status).toBe(200)
    expect(body.data.is_pinned).toBe(true)
  })

  it('dismisses a row by setting is_active=false', async () => {
    const updated = {
      id: 'mem-1',
      kind: 'fact',
      content: 'X',
      source: 'composer',
      source_ref: null,
      relevance_score: 0.5,
      is_pinned: false,
      is_active: false,
      last_accessed_at: null,
      created_at: '2026-05-10T09:00:00Z',
      updated_at: '2026-05-18T10:00:00Z',
    }
    enqueue({ data: { company_id: 'company-1' } })
    enqueue({ data: { role: 'member' } })
    enqueue({ data: updated })
    const response = await PATCH(
      createMockRequest('/api/agent/memory/mem-1', {
        method: 'PATCH',
        body: { is_active: false },
      }),
      createMockRouteParams({ id: 'mem-1' }),
    )
    const { status, body } = await parseJsonResponse<{ data: typeof updated }>(response)
    expect(status).toBe(200)
    expect(body.data.is_active).toBe(false)
  })

  it('rejects content shorter than 2 chars', async () => {
    const response = await PATCH(
      createMockRequest('/api/agent/memory/mem-1', {
        method: 'PATCH',
        body: { content: 'x' },
      }),
      createMockRouteParams({ id: 'mem-1' }),
    )
    expect(response.status).toBe(400)
  })
})
