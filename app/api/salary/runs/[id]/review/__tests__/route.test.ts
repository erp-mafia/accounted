import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createQueuedMockSupabase,
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
} from '@/tests/helpers'

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

import { POST } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { requireWritePermission } from '@/lib/auth/require-write'

const mockUser = { id: 'user-1', email: 'test@test.se' }

function authed() {
  const { supabase, enqueueMany } = createQueuedMockSupabase()
  vi.mocked(requireAuth).mockResolvedValue({
    user: mockUser as never,
    supabase: supabase as never,
    error: null,
  })
  return { supabase, enqueueMany }
}

describe('POST /api/salary/runs/[id]/review', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(requireWritePermission).mockResolvedValue({ ok: true } as never)
  })

  it('returns 401 when not authenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      user: null,
      supabase: null as never,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const response = await POST(
      createMockRequest('/api/salary/runs/run-1/review', { method: 'POST' }),
      createMockRouteParams({ id: 'run-1' }),
    )
    expect(response.status).toBe(401)
  })

  it('returns 403 for a viewer', async () => {
    authed()
    vi.mocked(requireWritePermission).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    } as never)
    const response = await POST(
      createMockRequest('/api/salary/runs/run-1/review', { method: 'POST' }),
      createMockRouteParams({ id: 'run-1' }),
    )
    expect(response.status).toBe(403)
  })

  it('moves a draft run to review', async () => {
    const { enqueueMany } = authed()
    enqueueMany([
      { data: [] }, // salary_run_employees (F-skatt check, no warnings)
      { data: { id: 'run-1', status: 'review' } }, // update draft → review
    ])
    const response = await POST(
      createMockRequest('/api/salary/runs/run-1/review', { method: 'POST' }),
      createMockRouteParams({ id: 'run-1' }),
    )
    const { status, body } = await parseJsonResponse<{ data: { status: string } }>(response)
    expect(status).toBe(200)
    expect(body.data.status).toBe('review')
  })

  it('surfaces an F-skatt warning when an employee is unverified', async () => {
    const { enqueueMany } = authed()
    enqueueMany([
      { data: [{ employee: { first_name: 'Anna', last_name: 'A', f_skatt_status: 'not_verified' } }] },
      { data: { id: 'run-1', status: 'review' } },
    ])
    const response = await POST(
      createMockRequest('/api/salary/runs/run-1/review', { method: 'POST' }),
      createMockRouteParams({ id: 'run-1' }),
    )
    const { status, body } = await parseJsonResponse<{ warnings?: string[] }>(response)
    expect(status).toBe(200)
    expect(body.warnings?.[0]).toContain('F-skatt ej verifierad')
  })

  it('returns 400 when the run is not a draft', async () => {
    const { enqueueMany } = authed()
    enqueueMany([
      { data: [] }, // F-skatt check
      { data: null, error: { message: 'no rows' } }, // update finds no draft row
    ])
    const response = await POST(
      createMockRequest('/api/salary/runs/run-1/review', { method: 'POST' }),
      createMockRouteParams({ id: 'run-1' }),
    )
    const { status, body } = await parseJsonResponse<{ error: string }>(response)
    expect(status).toBe(400)
    expect(body.error).toContain('utkaststatus')
  })
})
