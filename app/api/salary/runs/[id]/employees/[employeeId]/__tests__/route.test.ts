import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createQueuedMockSupabase,
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
} from '@/tests/helpers'

// ── Mocks ────────────────────────────────────────────────────
// This route hand-rolls auth (createClient + getUser) rather than
// withRouteContext, so we mock createClient and the write/company helpers.

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

const mockCreateClient = vi.fn()
vi.mock('@/lib/supabase/server', () => ({ createClient: () => mockCreateClient() }))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/salary/personnummer', () => ({
  decryptPersonnummer: (x: string) => x,
  maskPersonnummer: (x: string) => x,
}))

import { PATCH } from '../route'

const mockUser = { id: 'user-1', email: 'test@test.se' }

function authedSupabase() {
  const { supabase, enqueueMany } = createQueuedMockSupabase()
  supabase.auth = { getUser: vi.fn().mockResolvedValue({ data: { user: mockUser } }) }
  mockCreateClient.mockResolvedValue(supabase)
  return { supabase, enqueueMany }
}

describe('PATCH /api/salary/runs/[id]/employees/[employeeId]: monthly salary edit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('updates the per-run monthly salary while the run is a draft', async () => {
    const { enqueueMany } = authedSupabase()
    enqueueMany([
      { data: { id: 'run-1', status: 'draft' } }, // salary_runs lookup
      {
        data: { id: 'sre-1', employment_degree: 100, salary_type: 'monthly', monthly_salary: 30000 },
      }, // salary_run_employees update
      { data: null }, // salary_line_items Grundlön refresh
    ])

    const request = createMockRequest('/api/salary/runs/run-1/employees/emp-1', {
      method: 'PATCH',
      body: { monthly_salary: 30000 },
    })
    const response = await PATCH(
      request,
      createMockRouteParams({ id: 'run-1', employeeId: 'emp-1' }),
    )
    const { status, body } = await parseJsonResponse<{ data: { monthly_salary: number } }>(response)

    expect(status).toBe(200)
    expect(body.data.monthly_salary).toBe(30000)
  })

  it('allows a zero monthly salary (nollkörning) on a draft', async () => {
    const { enqueueMany } = authedSupabase()
    enqueueMany([
      { data: { id: 'run-1', status: 'draft' } },
      { data: { id: 'sre-1', employment_degree: 100, salary_type: 'monthly', monthly_salary: 0 } },
      { data: null },
    ])

    const request = createMockRequest('/api/salary/runs/run-1/employees/emp-1', {
      method: 'PATCH',
      body: { monthly_salary: 0 },
    })
    const response = await PATCH(
      request,
      createMockRouteParams({ id: 'run-1', employeeId: 'emp-1' }),
    )
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
  })

  it('rejects a monthly salary edit when the run is no longer a draft', async () => {
    const { enqueueMany } = authedSupabase()
    enqueueMany([
      { data: { id: 'run-1', status: 'review' } }, // not a draft
    ])

    const request = createMockRequest('/api/salary/runs/run-1/employees/emp-1', {
      method: 'PATCH',
      body: { monthly_salary: 30000 },
    })
    const response = await PATCH(
      request,
      createMockRouteParams({ id: 'run-1', employeeId: 'emp-1' }),
    )
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect(body.error).toContain('utkast')
  })

  it('rejects mixing a salary edit with a tax override in one request', async () => {
    authedSupabase()

    const request = createMockRequest('/api/salary/runs/run-1/employees/emp-1', {
      method: 'PATCH',
      body: { monthly_salary: 30000, tax_withheld_override: 5000, reason: 'test' },
    })
    const response = await PATCH(
      request,
      createMockRouteParams({ id: 'run-1', employeeId: 'emp-1' }),
    )
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(400)
  })
})
