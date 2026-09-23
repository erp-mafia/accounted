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
const EMP_UUID = '11111111-1111-4111-8111-111111111111'

function authed() {
  const { supabase, enqueueMany } = createQueuedMockSupabase()
  vi.mocked(requireAuth).mockResolvedValue({
    user: mockUser as never,
    supabase: supabase as never,
    error: null,
  })
  return { supabase, enqueueMany }
}

describe('POST /api/salary/runs/[id]/employees', () => {
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
      createMockRequest('/api/salary/runs/run-1/employees', {
        method: 'POST',
        body: { employee_id: EMP_UUID },
      }),
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
      createMockRequest('/api/salary/runs/run-1/employees', {
        method: 'POST',
        body: { employee_id: EMP_UUID },
      }),
      createMockRouteParams({ id: 'run-1' }),
    )
    expect(response.status).toBe(403)
  })

  it('returns 400 on an invalid body', async () => {
    authed()
    const response = await POST(
      createMockRequest('/api/salary/runs/run-1/employees', {
        method: 'POST',
        body: { employee_id: 'not-a-uuid' },
      }),
      createMockRouteParams({ id: 'run-1' }),
    )
    expect(response.status).toBe(400)
  })

  it('adds an employee to a draft run and returns 201', async () => {
    const { enqueueMany } = authed()
    enqueueMany([
      { data: { id: 'run-1', status: 'draft' } }, // salary_runs lookup
      {
        data: {
          id: EMP_UUID,
          employment_degree: 100,
          monthly_salary: 30000,
          salary_type: 'monthly',
          tax_table_number: 31,
          tax_column: 1,
          employment_type: 'employee',
          hourly_rate: null,
        },
      }, // employees lookup
      { data: null }, // already-added check (not present)
      { data: { id: 'sre-1', employee_id: EMP_UUID } }, // insert salary_run_employees
      { data: null }, // insert base line item
    ])

    const response = await POST(
      createMockRequest('/api/salary/runs/run-1/employees', {
        method: 'POST',
        body: { employee_id: EMP_UUID },
      }),
      createMockRouteParams({ id: 'run-1' }),
    )
    const { status, body } = await parseJsonResponse<{ data: { id: string } }>(response)

    expect(status).toBe(201)
    expect(body.data.id).toBe('sre-1')
  })
})
