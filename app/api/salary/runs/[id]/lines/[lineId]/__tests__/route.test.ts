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

import { PATCH, DELETE } from '../route'
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

const params = () => createMockRouteParams({ id: 'run-1', lineId: 'line-1' })

describe('PATCH /api/salary/runs/[id]/lines/[lineId]', () => {
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
    const response = await PATCH(
      createMockRequest('/api/salary/runs/run-1/lines/line-1', { method: 'PATCH', body: { amount: 100 } }),
      params(),
    )
    expect(response.status).toBe(401)
  })

  it('returns 403 for a viewer', async () => {
    authed()
    vi.mocked(requireWritePermission).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    } as never)
    const response = await PATCH(
      createMockRequest('/api/salary/runs/run-1/lines/line-1', { method: 'PATCH', body: { amount: 100 } }),
      params(),
    )
    expect(response.status).toBe(403)
  })

  it('updates a line on a draft run', async () => {
    const { enqueueMany } = authed()
    enqueueMany([
      { data: { id: 'run-1', status: 'draft' } }, // salary_runs lookup
      { data: { id: 'line-1', amount: 100 } }, // update returning
    ])
    const response = await PATCH(
      createMockRequest('/api/salary/runs/run-1/lines/line-1', { method: 'PATCH', body: { amount: 100 } }),
      params(),
    )
    const { status, body } = await parseJsonResponse<{ data: { id: string } }>(response)
    expect(status).toBe(200)
    expect(body.data.id).toBe('line-1')
  })
})

describe('DELETE /api/salary/runs/[id]/lines/[lineId]', () => {
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
    const response = await DELETE(
      createMockRequest('/api/salary/runs/run-1/lines/line-1', { method: 'DELETE' }),
      params(),
    )
    expect(response.status).toBe(401)
  })

  it('returns 403 for a viewer', async () => {
    authed()
    vi.mocked(requireWritePermission).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    } as never)
    const response = await DELETE(
      createMockRequest('/api/salary/runs/run-1/lines/line-1', { method: 'DELETE' }),
      params(),
    )
    expect(response.status).toBe(403)
  })

  it('deletes a line on a draft run', async () => {
    const { enqueueMany } = authed()
    enqueueMany([
      { data: { id: 'run-1', status: 'draft' } }, // salary_runs lookup
      { data: null }, // delete (error null)
    ])
    const response = await DELETE(
      createMockRequest('/api/salary/runs/run-1/lines/line-1', { method: 'DELETE' }),
      params(),
    )
    const { status, body } = await parseJsonResponse<{ data: { deleted: boolean } }>(response)
    expect(status).toBe(200)
    expect(body.data.deleted).toBe(true)
  })
})
