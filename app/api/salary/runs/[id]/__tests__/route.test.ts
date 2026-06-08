import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createQueuedMockSupabase,
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
} from '@/tests/helpers'

// ── Mocks ────────────────────────────────────────────────────
// The route is wrapped in withRouteContext, which resolves auth via
// requireAuth() (the only path that enforces MFA/AAL2 on hosted) and the active
// company via getActiveCompanyId(). Mock those, not createClient/getUser.

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: vi.fn(),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

import { DELETE } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'

// ── Test data ────────────────────────────────────────────────

const mockUser = { id: 'user-1', email: 'test@test.se' }

// ── Tests ────────────────────────────────────────────────────

describe('DELETE /api/salary/runs/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when not authenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      user: null as never,
      supabase: {} as never,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const request = createMockRequest('/api/salary/runs/run-1', { method: 'DELETE' })
    const response = await DELETE(request, createMockRouteParams({ id: 'run-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns 404 when salary run not found', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    vi.mocked(requireAuth).mockResolvedValue({
      user: mockUser as never,
      supabase: supabase as never,
      error: null,
    })

    enqueueMany([
      { data: null, error: { message: 'Not found' } }, // salary_runs lookup
    ])

    const request = createMockRequest('/api/salary/runs/run-1', { method: 'DELETE' })
    const response = await DELETE(request, createMockRouteParams({ id: 'run-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(404)
    expect(body.error).toContain('hittades inte')
  })

  it('returns 400 when the run is not a draft (booked must be storno-reversed)', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    vi.mocked(requireAuth).mockResolvedValue({
      user: mockUser as never,
      supabase: supabase as never,
      error: null,
    })

    enqueueMany([
      { data: { id: 'run-1', status: 'booked' } }, // salary_runs lookup
    ])

    const request = createMockRequest('/api/salary/runs/run-1', { method: 'DELETE' })
    const response = await DELETE(request, createMockRouteParams({ id: 'run-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect(body.error).toContain('utkast')
  })

  it('deletes a draft run and returns success', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    vi.mocked(requireAuth).mockResolvedValue({
      user: mockUser as never,
      supabase: supabase as never,
      error: null,
    })

    enqueueMany([
      { data: { id: 'run-1', status: 'draft' } }, // salary_runs lookup
      { data: null },                              // salary_runs delete (cascade handles children)
    ])

    const request = createMockRequest('/api/salary/runs/run-1', { method: 'DELETE' })
    const response = await DELETE(request, createMockRouteParams({ id: 'run-1' }))
    const { status, body } = await parseJsonResponse<{ data: { id: string; deleted: boolean } }>(response)

    expect(status).toBe(200)
    expect(body.data).toEqual({ id: 'run-1', deleted: true })
  })
})
