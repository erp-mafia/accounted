import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createMockRequest,
  createMockRouteParams,
  createQueuedMockSupabase,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

import { GET } from '../route'

const CALCULATED_RUN = {
  id: 'run-1',
  company_id: 'company-1',
  status: 'review',
  period_year: 2026,
  period_month: 7,
  calculation_params: { slpRate: 0.2426, avgifterTotal: 0.3142 },
}

const EMPLOYEE_ROW = {
  employee_id: 'emp-1',
  employee: { employment_type: 'employee' },
  gross_salary: 51158,
  tax_withheld: 12268,
  net_salary: 38890,
  avgifter_amount: 16073.84,
  avgifter_amount_override: null,
  avgifter_basis: 51158,
  avgifter_rate: 0.3142,
  avgifter_category: 'standard',
  vacation_accrual: 0,
  vacation_accrual_avgifter: 0,
  line_items: [],
}

describe('GET /api/salary/runs/[id]/preview', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: mockUser, supabase: mockSupabase, error: null })
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const response = await GET(
      createMockRequest('/api/salary/runs/run-1/preview'),
      createMockRouteParams({ id: 'run-1' }),
    )
    expect(response.status).toBe(401)
  })

  it('returns 404 for an unknown run', async () => {
    enqueue({ data: null, error: { message: 'not found' } })
    const response = await GET(
      createMockRequest('/api/salary/runs/run-1/preview'),
      createMockRouteParams({ id: 'run-1' }),
    )
    expect(response.status).toBe(404)
  })

  it('returns 400 when the run has no calculated employees', async () => {
    enqueue({ data: CALCULATED_RUN }) // salary_runs
    enqueue({ data: [] }) // salary_run_employees: nothing calculated yet
    const response = await GET(
      createMockRequest('/api/salary/runs/run-1/preview'),
      createMockRouteParams({ id: 'run-1' }),
    )
    expect(response.status).toBe(400)
  })

  it('returns 500 when the posted-voucher lookup fails for a booked run', async () => {
    enqueue({
      data: { ...CALCULATED_RUN, status: 'booked', salary_entry_id: 'je-1' },
    }) // salary_runs
    enqueue({ data: null, error: { message: 'rls denied' } }) // journal_entries
    const response = await GET(
      createMockRequest('/api/salary/runs/run-1/preview'),
      createMockRouteParams({ id: 'run-1' }),
    )
    // A failed lookup must not masquerade as "booked run with no vouchers".
    expect(response.status).toBe(500)
  })

  it('previews the whole-krona 2731/3740 split for a calculated run', async () => {
    enqueue({ data: CALCULATED_RUN }) // salary_runs
    enqueue({ data: [EMPLOYEE_ROW] }) // salary_run_employees

    const response = await GET(
      createMockRequest('/api/salary/runs/run-1/preview'),
      createMockRouteParams({ id: 'run-1' }),
    )
    expect(response.status).toBe(200)
    const { data } = await response.json()

    expect(data.booked).toBeUndefined()
    const lines = data.avgifterEntry.lines as Array<{
      account_number: string
      debit_amount: number
      credit_amount: number
    }>
    expect(lines.find((l) => l.account_number === '7510')?.debit_amount).toBe(16073.84)
    expect(lines.find((l) => l.account_number === '2731')?.credit_amount).toBe(16073)
    expect(lines.find((l) => l.account_number === '3740')?.credit_amount).toBe(0.84)
  })

  it('returns the ACTUAL posted verifikat for a booked run, voucher labels included', async () => {
    enqueue({
      data: {
        ...CALCULATED_RUN,
        status: 'booked',
        salary_entry_id: 'je-1',
        avgifter_entry_id: 'je-2',
        vacation_entry_id: null,
        pension_entry_id: null,
      },
    }) // salary_runs
    enqueue({
      data: [
        {
          id: 'je-1',
          description: 'Lön 2026-07',
          voucher_series: 'A',
          voucher_number: 214,
          lines: [
            { account_number: '7210', line_description: 'Lön', debit_amount: 51158, credit_amount: 0 },
            { account_number: '2710', line_description: 'Personalskatt', debit_amount: 0, credit_amount: 12268 },
            { account_number: '1930', line_description: 'Nettolön', debit_amount: 0, credit_amount: 38890 },
          ],
        },
        {
          id: 'je-2',
          description: 'Lön 2026-07: Arbetsgivaravgifter',
          voucher_series: 'A',
          voucher_number: 215,
          // A pre-whole-krona legacy voucher: the view must show the posted
          // öre-exact lines, never a recomputed projection with 3740.
          lines: [
            { account_number: '7510', line_description: 'Arbetsgivaravgifter', debit_amount: 16073.84, credit_amount: 0 },
            { account_number: '2731', line_description: 'Arbetsgivaravgifter', debit_amount: 0, credit_amount: 16073.84 },
          ],
        },
      ],
    }) // journal_entries

    const response = await GET(
      createMockRequest('/api/salary/runs/run-1/preview'),
      createMockRouteParams({ id: 'run-1' }),
    )
    expect(response.status).toBe(200)
    const { data } = await response.json()

    expect(data.booked).toBe(true)
    expect(data.salaryEntry.description).toBe('Lön 2026-07 (A-214)')
    expect(data.avgifterEntry.description).toBe('Lön 2026-07: Arbetsgivaravgifter (A-215)')
    const avgifterLines = data.avgifterEntry.lines as Array<{ account_number: string; credit_amount: number }>
    expect(avgifterLines.find((l) => l.account_number === '2731')?.credit_amount).toBe(16073.84)
    expect(avgifterLines.some((l) => l.account_number === '3740')).toBe(false)
    expect(data.vacationEntry).toBeNull()
    expect(data.pensionEntry).toBeNull()
  })
})

describe('GET /api/salary/runs/[id]/preview: previews the booking builder (feedback seq 384229)', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: mockUser, supabase: mockSupabase, error: null })
  })

  type Line = { account_number: string; debit_amount: number; credit_amount: number }
  const sum = (lines: Line[], side: 'debit_amount' | 'credit_amount') =>
    Math.round(lines.reduce((s, l) => s + l[side], 0) * 100) / 100

  it('previews a bilförmån run balanced: no 7385 debit without a counterpart', async () => {
    enqueue({ data: CALCULATED_RUN }) // salary_runs
    enqueue({
      data: [
        {
          ...EMPLOYEE_ROW,
          line_items: [
            { item_type: 'base_salary', amount: 51158, account_number: '7210', is_net_deduction: false, is_gross_deduction: false },
            // The benefit raises the tax base but has no cash flow: the
            // booking skips it, so the preview must too.
            { item_type: 'benefit_car', amount: 7049, account_number: '7385', is_net_deduction: false, is_gross_deduction: false },
          ],
        },
      ],
    }) // salary_run_employees

    const response = await GET(
      createMockRequest('/api/salary/runs/run-1/preview'),
      createMockRouteParams({ id: 'run-1' }),
    )
    expect(response.status).toBe(200)
    const { data } = await response.json()

    const lines = data.salaryEntry.lines as Line[]
    expect(lines.some((l) => l.account_number === '7385')).toBe(false)
    expect(lines.find((l) => l.account_number === '7210')?.debit_amount).toBe(51158)
    expect(lines.find((l) => l.account_number === '2710')?.credit_amount).toBe(12268)
    expect(lines.find((l) => l.account_number === '1930')?.credit_amount).toBe(38890)
    expect(sum(lines, 'debit_amount')).toBe(sum(lines, 'credit_amount'))
    expect(data.salaryEntry.balanced).toBe(true)
    expect(data.salaryEntry.difference).toBe(0)
    expect(data.avgifterEntry.balanced).toBe(true)
    expect(data.balanced).toBe(true)
  })

  it('applies the per-employee tax override exactly like the booking', async () => {
    enqueue({ data: CALCULATED_RUN }) // salary_runs
    enqueue({ data: [{ ...EMPLOYEE_ROW, tax_withheld_override: 12000 }] }) // salary_run_employees

    const response = await GET(
      createMockRequest('/api/salary/runs/run-1/preview'),
      createMockRouteParams({ id: 'run-1' }),
    )
    expect(response.status).toBe(200)
    const { data } = await response.json()
    const lines = data.salaryEntry.lines as Line[]
    expect(lines.find((l) => l.account_number === '2710')?.credit_amount).toBe(12000)
    expect(lines.find((l) => l.account_number === '1930')?.credit_amount).toBe(39158)
    expect(data.salaryEntry.balanced).toBe(true)
  })

  it('drops the zero-shaped avgifter entry for a run without avgifter, like the booking', async () => {
    enqueue({ data: CALCULATED_RUN }) // salary_runs
    enqueue({
      data: [{ ...EMPLOYEE_ROW, avgifter_amount: 0, avgifter_basis: 0, employee: { employment_type: 'employee', f_skatt_status: 'f_skatt' } }],
    }) // salary_run_employees

    const response = await GET(
      createMockRequest('/api/salary/runs/run-1/preview'),
      createMockRouteParams({ id: 'run-1' }),
    )
    expect(response.status).toBe(200)
    const { data } = await response.json()
    expect(data.avgifterEntry).toBeNull()
    expect(data.salaryEntry.balanced).toBe(true)
    expect(data.balanced).toBe(true)
  })
})
