/**
 * Tests for /api/deadlines/[id] — validated PUT and count-checked DELETE.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))

import { PUT, DELETE } from '../route'

const idParams = { params: Promise.resolve({ id: 'deadline-1' }) }

function createCapturingSupabase(
  results: { data?: unknown; error?: unknown; count?: number | null }[]
) {
  let idx = 0
  const makeBuilder = () => {
    const result = results[idx++] ?? { data: null, error: null, count: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {}
    for (const m of ['select', 'eq', 'update', 'delete', 'single', 'maybeSingle']) {
      b[m] = () => b
    }
    b.then = (resolve: (v: unknown) => void) =>
      resolve({ data: result.data ?? null, error: result.error ?? null, count: result.count ?? null })
    return b
  }
  return { from: () => makeBuilder() }
}

beforeEach(() => {
  vi.clearAllMocks()
  requireWriteMock.mockResolvedValue({ ok: true })
})

function auth(supabase: unknown) {
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
}

describe('PUT /api/deadlines/[id]', () => {
  it('rejects a malformed body (bad due_date) with 400', async () => {
    auth(createCapturingSupabase([]))
    const req = createMockRequest('/api/deadlines/deadline-1', {
      method: 'PUT',
      body: { due_date: 'banana' },
    })
    const { status } = await parseJsonResponse(await PUT(req, idParams))
    expect(status).toBe(400)
  })

  it('rejects an empty body with 400', async () => {
    auth(createCapturingSupabase([]))
    const req = createMockRequest('/api/deadlines/deadline-1', { method: 'PUT', body: {} })
    const { status } = await parseJsonResponse(await PUT(req, idParams))
    expect(status).toBe(400)
  })

  it('maps zero-rows to 404', async () => {
    auth(createCapturingSupabase([{ error: { code: 'PGRST116', message: 'no rows' } }]))
    const req = createMockRequest('/api/deadlines/deadline-1', {
      method: 'PUT',
      body: { title: 'Momsdeklaration Q3' },
    })
    const { status } = await parseJsonResponse(await PUT(req, idParams))
    expect(status).toBe(404)
  })

  it('updates the deadline', async () => {
    auth(createCapturingSupabase([{ data: { id: 'deadline-1', title: 'Momsdeklaration Q3' } }]))
    const req = createMockRequest('/api/deadlines/deadline-1', {
      method: 'PUT',
      body: { title: 'Momsdeklaration Q3' },
    })
    const { status, body } = await parseJsonResponse<{ data: { title: string } }>(
      await PUT(req, idParams)
    )
    expect(status).toBe(200)
    expect(body.data.title).toBe('Momsdeklaration Q3')
  })
})

describe('DELETE /api/deadlines/[id]', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: {},
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await DELETE(createMockRequest('/x', { method: 'DELETE' }), idParams)
    expect(res.status).toBe(401)
  })

  it('returns 404 instead of phantom success when no row matches', async () => {
    // First result: the source lookup finds nothing.
    auth(createCapturingSupabase([{ data: null }]))
    const { status } = await parseJsonResponse(
      await DELETE(createMockRequest('/x', { method: 'DELETE' }), idParams)
    )
    expect(status).toBe(404)
  })

  it('hard-deletes a user-created deadline', async () => {
    auth(createCapturingSupabase([
      { data: { id: 'deadline-1', source: 'user' } },
      { count: 1 },
    ]))
    const { status, body } = await parseJsonResponse<{ success: boolean; dismissed?: boolean }>(
      await DELETE(createMockRequest('/x', { method: 'DELETE' }), idParams)
    )
    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.dismissed).toBeUndefined()
  })

  it('dismisses a system deadline instead of deleting it', async () => {
    // A hard-deleted system row is recreated by the nightly backfill cron;
    // the route must soft-dismiss so the opt-out is durable.
    auth(createCapturingSupabase([
      { data: { id: 'deadline-1', source: 'system' } },
      { data: [{ id: 'deadline-1' }] },
    ]))
    const { status, body } = await parseJsonResponse<{ success: boolean; dismissed?: boolean }>(
      await DELETE(createMockRequest('/x', { method: 'DELETE' }), idParams)
    )
    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.dismissed).toBe(true)
  })

  it('returns 404 when the system row vanished before the dismissal landed', async () => {
    // Concurrent regeneration can delete the row between lookup and update;
    // a phantom "dismissed" success would persist nothing.
    auth(createCapturingSupabase([
      { data: { id: 'deadline-1', source: 'system' } },
      { data: [] },
    ]))
    const { status } = await parseJsonResponse(
      await DELETE(createMockRequest('/x', { method: 'DELETE' }), idParams)
    )
    expect(status).toBe(404)
  })
})
