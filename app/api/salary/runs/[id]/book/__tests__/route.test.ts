import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createQueuedMockSupabase,
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
} from '@/tests/helpers'

// ── Mocks ────────────────────────────────────────────────────
// The route is wrapped in withRouteContext (auth via requireAuth, company via
// getActiveCompanyId, write-gate via requireWritePermission). createSalaryRunEntries
// is mocked so we can assert it is NOT called for a nollkörning (zero-amount run),
// where the bookkeeping engine would otherwise reject a zero voucher.

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock('@/lib/events', () => ({
  eventBus: { emit: vi.fn().mockResolvedValue(undefined) },
}))
vi.mock('@/lib/salary/salary-entries', () => ({ createSalaryRunEntries: vi.fn() }))

import { POST } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { eventBus } from '@/lib/events'
import { createSalaryRunEntries } from '@/lib/salary/salary-entries'

const mockUser = { id: 'user-1', email: 'test@test.se' }

const makePaidRun = (overrides = {}) => ({
  id: 'run-1',
  company_id: 'company-1',
  status: 'paid',
  period_year: 2026,
  period_month: 4,
  payment_date: '2026-04-25',
  voucher_series: 'A',
  total_gross: 0,
  total_tax: 0,
  total_net: 0,
  total_avgifter: 0,
  total_vacation_accrual: 0,
  ...overrides,
})

describe('POST /api/salary/runs/[id]/book: nollkörning', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('books an empty-roster zero-total run without creating journal entries', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    vi.mocked(requireAuth).mockResolvedValue({
      user: mockUser as never,
      supabase: supabase as never,
      error: null,
    })

    enqueueMany([
      { data: makePaidRun() }, // salary_runs (paid) lookup
      { data: [] }, // salary_run_employees roster (empty)
      { data: { id: 'run-1', status: 'booked' } }, // salary_runs update → booked
    ])

    const request = createMockRequest('/api/salary/runs/run-1/book', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'run-1' }))
    const { status, body } = await parseJsonResponse<{ data: { id: string; status: string } }>(
      response,
    )

    expect(status).toBe(200)
    expect(body.data.status).toBe('booked')
    expect(createSalaryRunEntries).not.toHaveBeenCalled()
    expect(eventBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'salary_run.booked' }),
    )
  })

  it('books a run whose employees were all set to 0 kr as a nollkörning (no vouchers)', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    vi.mocked(requireAuth).mockResolvedValue({
      user: mockUser as never,
      supabase: supabase as never,
      error: null,
    })

    enqueueMany([
      { data: makePaidRun() }, // salary_runs (paid) lookup
      { data: [{ employee_id: 'e1', gross_salary: 0, line_items: [] }] }, // roster present but zero
      { data: { id: 'run-1', status: 'booked' } }, // salary_runs update → booked
    ])

    const request = createMockRequest('/api/salary/runs/run-1/book', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'run-1' }))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(createSalaryRunEntries).not.toHaveBeenCalled()
  })

  it('passes each employee default_dimensions bag from the join to the engine (PR8)', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    vi.mocked(requireAuth).mockResolvedValue({
      user: mockUser as never,
      supabase: supabase as never,
      error: null,
    })
    vi.mocked(createSalaryRunEntries).mockResolvedValue({
      salaryEntry: { id: 'je-1' },
      avgifterEntry: { id: 'je-2' },
      vacationEntry: null,
      pensionEntry: null,
    } as never)

    enqueueMany([
      { data: makePaidRun({ total_gross: 30000, total_tax: 7000, total_net: 23000, total_avgifter: 9426 }) },
      {
        data: [
          {
            employee_id: 'e1',
            employee: { employment_type: 'employee', default_dimensions: { '1': 'KS01' } },
            gross_salary: 30000,
            tax_withheld: 7000,
            net_salary: 23000,
            avgifter_amount: 9426,
            avgifter_rate: 0.3142,
            vacation_accrual: 0,
            vacation_accrual_avgifter: 0,
            line_items: [],
          },
        ],
      }, // roster with dims from the employees join
      { data: { id: 'run-1', status: 'booked' } }, // salary_runs update → booked
    ])

    const request = createMockRequest('/api/salary/runs/run-1/book', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'run-1' }))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(createSalaryRunEntries).toHaveBeenCalledTimes(1)
    const runInput = vi.mocked(createSalaryRunEntries).mock.calls[0][3] as {
      employees: Array<{ employee_id: string; default_dimensions?: Record<string, string> }>
    }
    expect(runInput.employees[0].default_dimensions).toEqual({ '1': 'KS01' })
  })
})
