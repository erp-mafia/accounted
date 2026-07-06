import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createQueuedMockSupabase,
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
} from '@/tests/helpers'

// The route is wrapped in withRouteContext (auth via requireAuth, company via
// getActiveCompanyId, write gate via requireWritePermission): mock those.
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock('@/lib/events', () => ({ eventBus: { emit: vi.fn().mockResolvedValue(undefined) } }))

import { POST } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'

const mockUser = { id: 'user-1', email: 'test@test.se' }

function authed(supabase: unknown) {
  vi.mocked(requireAuth).mockResolvedValue({
    user: mockUser as never,
    supabase: supabase as never,
    error: null,
  })
}

/** A salary_run_employees row joined with its employee, as the route selects it. */
function runEmp(opts: {
  first_name: string
  last_name: string
  net_salary: number
  tax_withheld?: number
  tax_withheld_override?: number | null
  clearing_number?: string | null
  bank_account_number?: string | null
}) {
  return {
    net_salary: opts.net_salary,
    tax_withheld: opts.tax_withheld ?? 0,
    tax_withheld_override: opts.tax_withheld_override ?? null,
    calculation_breakdown: { steps: [] },
    employee: {
      first_name: opts.first_name,
      last_name: opts.last_name,
      clearing_number: opts.clearing_number ?? null,
      bank_account_number: opts.bank_account_number ?? null,
      email: 'employee@example.com',
    },
  }
}

describe('POST /api/salary/runs/[id]/approve: bank-detail guard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('approves a nollkörning where a zero-net employee has no bank details', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    authed(supabase)

    enqueueMany([
      { data: { id: 'run-1', status: 'review', company_id: 'company-1' } }, // run lookup
      {
        data: [
          runEmp({ first_name: 'Test', last_name: 'Testsson', net_salary: 0 }),
          runEmp({ first_name: 'Anna', last_name: 'Exempelsson', net_salary: 0 }),
        ],
      }, // run employees
      { data: { id: 'run-1', status: 'approved' } }, // update
    ])

    const request = createMockRequest('/api/salary/runs/run-1/approve', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'run-1' }))
    const { status, body } = await parseJsonResponse<{ data: { status: string } }>(response)

    expect(status).toBe(200)
    expect(body.data.status).toBe('approved')
  })

  it('still blocks when an employee who is actually paid has no bank details', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    authed(supabase)

    enqueueMany([
      { data: { id: 'run-1', status: 'review', company_id: 'company-1' } },
      {
        data: [
          // Paid 24 000 but no clearing/account → must block.
          runEmp({ first_name: 'Test', last_name: 'Testsson', net_salary: 24000, tax_withheld: 8000 }),
        ],
      },
    ])

    const request = createMockRequest('/api/salary/runs/run-1/approve', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'run-1' }))
    const { status, body } = await parseJsonResponse<{ error: string; details: string[] }>(response)

    expect(status).toBe(400)
    expect(body.details).toHaveLength(1)
    expect(body.details[0]).toContain('Test Testsson')
    expect(body.details[0]).toContain('Bankuppgifter saknas')
  })

  it('approves a mixed run: pays the one with bank details, ignores the zero-net one without', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    authed(supabase)

    enqueueMany([
      { data: { id: 'run-1', status: 'review', company_id: 'company-1' } },
      {
        data: [
          runEmp({
            first_name: 'Anna',
            last_name: 'Exempelsson',
            net_salary: 24000,
            tax_withheld: 8000,
            clearing_number: '8327',
            bank_account_number: '1234567',
          }),
          // Zero payout, no bank details: should not block.
          runEmp({ first_name: 'Test', last_name: 'Testsson', net_salary: 0 }),
        ],
      },
      { data: { id: 'run-1', status: 'approved' } },
    ])

    const request = createMockRequest('/api/salary/runs/run-1/approve', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'run-1' }))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
  })

  it('flags the bank-detail block as overridable so the UI can offer "Godkänn ändå"', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    authed(supabase)

    enqueueMany([
      { data: { id: 'run-1', status: 'review', company_id: 'company-1' } },
      { data: [runEmp({ first_name: 'Test', last_name: 'Testsson', net_salary: 24000, tax_withheld: 8000 })] },
    ])

    const request = createMockRequest('/api/salary/runs/run-1/approve', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'run-1' }))
    const { status, body } = await parseJsonResponse<{ code: string; overridable: boolean }>(response)

    expect(status).toBe(400)
    expect(body.code).toBe('SALARY_APPROVE_BANK_DETAILS_MISSING')
    expect(body.overridable).toBe(true)
  })

  it('approves past missing bank details when ?force=true, surfacing the reminder as a warning', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    authed(supabase)

    enqueueMany([
      { data: { id: 'run-1', status: 'review', company_id: 'company-1' } },
      { data: [runEmp({ first_name: 'Test', last_name: 'Testsson', net_salary: 24000, tax_withheld: 8000 })] },
      { data: { id: 'run-1', status: 'approved' } }, // update
    ])

    const request = createMockRequest('/api/salary/runs/run-1/approve', {
      method: 'POST',
      searchParams: { force: 'true' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'run-1' }))
    const { status, body } = await parseJsonResponse<{ data: { status: string }; warnings: string[] }>(response)

    expect(status).toBe(200)
    expect(body.data.status).toBe('approved')
    expect(body.warnings.some((w) => w.includes('Bankuppgifter saknas'))).toBe(true)
  })

  it('does not let ?force=true bypass a missing calculation (hard block)', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    authed(supabase)

    enqueueMany([
      { data: { id: 'run-1', status: 'review', company_id: 'company-1' } },
      {
        data: [
          {
            net_salary: 24000,
            tax_withheld: 8000,
            tax_withheld_override: null,
            calculation_breakdown: null, // never calculated → hard block
            employee: {
              first_name: 'Test',
              last_name: 'Testsson',
              clearing_number: '8327',
              bank_account_number: '1234567',
              email: 'employee@example.com',
            },
          },
        ],
      },
    ])

    const request = createMockRequest('/api/salary/runs/run-1/approve', {
      method: 'POST',
      searchParams: { force: 'true' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'run-1' }))
    const { status, body } = await parseJsonResponse<{ code: string; overridable: boolean; details: string[] }>(response)

    expect(status).toBe(400)
    expect(body.code).toBe('SALARY_APPROVE_BLOCKED')
    expect(body.overridable).toBe(false)
    expect(body.details[0]).toContain('Beräkning saknas')
  })
})
