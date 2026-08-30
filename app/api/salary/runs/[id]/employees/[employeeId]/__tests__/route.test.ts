import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createQueuedMockSupabase,
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
} from '@/tests/helpers'

// ── Mocks ────────────────────────────────────────────────────
// The route is wrapped in withRouteContext. We inject a queued Supabase mock
// through requireAuth and mock the company/write helpers the wrapper uses.

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))
import { GET, PATCH } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { requireWritePermission } from '@/lib/auth/require-write'
import { encryptPersonnummer } from '@/lib/salary/personnummer'

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

describe('GET /api/salary/runs/[id]/employees/[employeeId]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(requireWritePermission).mockResolvedValue({ ok: true } as never)
  })

  it('masks the embedded employee: no ciphertext, no personnummer_last4', async () => {
    // The embed is employees(*), so personnummer_last4 rides along from the DB.
    // The mask is YYYYMMDD-XXXX: mask + last4 in the same payload would
    // reassemble the full personnummer, so both pn-derived columns must be
    // stripped before the payload leaves the server.
    const STORED_PNR = '190203040000' // synthetic
    const { enqueueMany } = authed()
    enqueueMany([
      {
        data: {
          id: 'sre-1',
          gross_salary: 30000,
          employee: {
            id: 'emp-1',
            first_name: 'Test',
            last_name: 'Testsson',
            personnummer: encryptPersonnummer(STORED_PNR),
            personnummer_last4: '0000',
            employment_type: 'employee',
          },
          line_items: [],
        },
      },
    ])

    const response = await GET(
      createMockRequest('/api/salary/runs/run-1/employees/emp-1'),
      createMockRouteParams({ id: 'run-1', employeeId: 'emp-1' }),
    )
    const { status, body } = await parseJsonResponse<{
      data: { employee: Record<string, unknown> }
    }>(response)

    expect(status).toBe(200)
    expect(body.data.employee.personnummer_masked).toBe('19020304-XXXX')
    expect(body.data.employee).not.toHaveProperty('personnummer')
    expect(body.data.employee).not.toHaveProperty('personnummer_last4')
    expect(JSON.stringify(body)).not.toContain(STORED_PNR)
  })
})

describe('PATCH /api/salary/runs/[id]/employees/[employeeId]: monthly salary edit', () => {
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

    const request = createMockRequest('/api/salary/runs/run-1/employees/emp-1', {
      method: 'PATCH',
      body: { monthly_salary: 30000 },
    })
    const response = await PATCH(
      request,
      createMockRouteParams({ id: 'run-1', employeeId: 'emp-1' }),
    )
    expect(response.status).toBe(401)
  })

  it('returns 403 for a viewer (no write permission)', async () => {
    authed()
    vi.mocked(requireWritePermission).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    } as never)

    const request = createMockRequest('/api/salary/runs/run-1/employees/emp-1', {
      method: 'PATCH',
      body: { monthly_salary: 30000 },
    })
    const response = await PATCH(
      request,
      createMockRouteParams({ id: 'run-1', employeeId: 'emp-1' }),
    )
    expect(response.status).toBe(403)
  })

  it('updates the per-run monthly salary while the run is a draft', async () => {
    const { enqueueMany } = authed()
    enqueueMany([
      { data: { id: 'run-1', status: 'draft' } }, // service: salary_runs draft gate
      {
        data: { id: 'sre-1', employee_id: 'emp-1', employment_degree: 100, salary_type: 'monthly', monthly_salary: 25000 },
      }, // service: salary_run_employees select
      { data: null }, // service: salary_run_employees update
      { data: null }, // service: salary_line_items Grundlön refresh
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
    const { enqueueMany } = authed()
    enqueueMany([
      { data: { id: 'run-1', status: 'draft' } },
      { data: { id: 'sre-1', employee_id: 'emp-1', employment_degree: 100, salary_type: 'monthly', monthly_salary: 25000 } },
      { data: null },
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
    const { enqueueMany } = authed()
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
    authed()

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
