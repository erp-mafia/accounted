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
const SRE_UUID = '22222222-2222-4222-8222-222222222222'

function authed() {
  const { supabase, enqueueMany } = createQueuedMockSupabase()
  vi.mocked(requireAuth).mockResolvedValue({
    user: mockUser as never,
    supabase: supabase as never,
    error: null,
  })
  return { supabase, enqueueMany }
}

const validBody = {
  salary_run_employee_id: SRE_UUID,
  item_type: 'bonus',
  description: 'Bonus',
  amount: 5000,
}

describe('POST /api/salary/runs/[id]/lines', () => {
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
      createMockRequest('/api/salary/runs/run-1/lines', { method: 'POST', body: validBody }),
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
      createMockRequest('/api/salary/runs/run-1/lines', { method: 'POST', body: validBody }),
      createMockRouteParams({ id: 'run-1' }),
    )
    expect(response.status).toBe(403)
  })

  it('creates a line item on a draft run and returns 201', async () => {
    const { enqueueMany } = authed()
    enqueueMany([
      { data: { id: 'run-1', status: 'draft' } }, // salary_runs lookup
      { data: { id: SRE_UUID, employee_id: 'emp-1' } }, // salary_run_employees membership
      { data: { id: 'li-1' } }, // insert line item
    ])

    const response = await POST(
      createMockRequest('/api/salary/runs/run-1/lines', { method: 'POST', body: validBody }),
      createMockRouteParams({ id: 'run-1' }),
    )
    const { status, body } = await parseJsonResponse<{ data: { id: string } }>(response)

    expect(status).toBe(201)
    expect(body.data.id).toBe('li-1')
  })
})
