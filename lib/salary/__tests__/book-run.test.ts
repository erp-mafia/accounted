/**
 * Tests for the shared salary-run booking orchestration (lib/salary/book-run.ts):
 * the dashboard book route's extracted core plus the advance-walk used by the
 * book_salary_run pending-operation executor (MCP gnubok_book_salary_run).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/events', () => ({
  eventBus: { emit: vi.fn().mockResolvedValue(undefined) },
}))
vi.mock('@/lib/salary/salary-entries', () => ({ createSalaryRunEntries: vi.fn() }))
vi.mock('@/lib/salary/vacation-ledger', () => ({
  syncVacationLedgerForEmployees: vi.fn(),
}))
vi.mock('@/lib/salary/ytd', () => ({
  refreshRunYtd: vi.fn().mockResolvedValue({ ok: true, updated: 0 }),
}))
// The pre-booking claim check stays real (zero queries without linked lines,
// one queued expense_claims read with them); only the settle RPC is mocked.
vi.mock('@/lib/salary/expense-claim-lines', async () => {
  const actual = await vi.importActual<typeof import('@/lib/salary/expense-claim-lines')>(
    '@/lib/salary/expense-claim-lines',
  )
  return { ...actual, settleExpenseClaimsForBookedRun: vi.fn() }
})

import { advanceAndBookSalaryRun, bookPaidSalaryRun } from '../book-run'
import { createSalaryRunEntries } from '@/lib/salary/salary-entries'
import { settleExpenseClaimsForBookedRun } from '@/lib/salary/expense-claim-lines'
import { syncVacationLedgerForEmployees } from '@/lib/salary/vacation-ledger'
import { refreshRunYtd } from '@/lib/salary/ytd'
import { eventBus } from '@/lib/events'

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
} as never

const ARGS = { companyId: 'company-1', userId: 'user-1', salaryRunId: 'run-1', log }

const makeRun = (overrides: Record<string, unknown> = {}) => ({
  id: 'run-1',
  company_id: 'company-1',
  status: 'review',
  period_year: 2026,
  period_month: 6,
  payment_date: '2026-06-25',
  voucher_series: 'L',
  total_gross: 30000,
  total_tax: 7000,
  total_net: 23000,
  total_avgifter: 9426,
  total_vacation_accrual: 0,
  calculation_params: { slpRate: 0.2426 },
  ...overrides,
})

const makeSre = (overrides: Record<string, unknown> = {}) => ({
  employee_id: 'e1',
  gross_salary: 30000,
  tax_withheld: 7000,
  tax_withheld_override: null,
  net_salary: 23000,
  avgifter_amount: 9426,
  avgifter_amount_override: null,
  avgifter_rate: 0.3142,
  vacation_accrual: 0,
  vacation_accrual_avgifter: 0,
  calculation_breakdown: { steps: [] },
  line_items: [],
  employee: {
    first_name: 'Anna',
    last_name: 'Svensson',
    employment_type: 'employee',
    default_dimensions: null,
    f_skatt_status: 'a_skatt',
    clearing_number: '8327',
    bank_account_number: '123456789',
    email: 'anna@example.se',
  },
  ...overrides,
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(syncVacationLedgerForEmployees).mockResolvedValue({ ok: true } as never)
  vi.mocked(createSalaryRunEntries).mockResolvedValue({
    salaryEntry: { id: 'je-1' },
    avgifterEntry: { id: 'je-2' },
    vacationEntry: null,
    pensionEntry: null,
  } as never)
})

describe('advanceAndBookSalaryRun', () => {
  it('refuses an already-booked run', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: makeRun({ status: 'booked' }) })

    const result = await advanceAndBookSalaryRun(supabase as never, ARGS)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('SALARY_RUN_ALREADY_BOOKED')
  })

  it('blocks a draft run whose roster lacks a calculation', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: makeRun({ status: 'draft' }) },
      { data: [makeSre({ calculation_breakdown: null })] },
    ])

    const result = await advanceAndBookSalaryRun(supabase as never, ARGS)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('SALARY_RUN_NOT_CALCULATED')
      expect(result.details?.employees).toEqual(['Anna Svensson'])
    }
    expect(createSalaryRunEntries).not.toHaveBeenCalled()
  })

  it('walks review → approved → paid → booked and surfaces bank-detail warnings', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: makeRun({ status: 'review' }) },
      { data: [makeSre({ employee: { ...makeSre().employee, clearing_number: null } })] },
      { data: { id: 'run-1' } }, // review → approved
      { data: { id: 'run-1' } }, // approved → paid
      { data: { id: 'run-1', status: 'booked' } }, // paid → booked
    ])

    const result = await advanceAndBookSalaryRun(supabase as never, ARGS)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.entryIds).toEqual(['je-1', 'je-2'])
      expect(result.data.nollkorning).toBe(false)
      expect(result.data.warnings.some((w) => w.includes('Bankuppgifter saknas'))).toBe(true)
    }
    expect(createSalaryRunEntries).toHaveBeenCalledTimes(1)
    expect(eventBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'salary_run.approved' }),
    )
    expect(eventBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'salary_run.booked' }),
    )
  })

  it('books a paid zero-total run as nollkörning without journal entries', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      {
        data: makeRun({
          status: 'paid',
          total_gross: 0,
          total_tax: 0,
          total_net: 0,
          total_avgifter: 0,
        }),
      },
      { data: [] }, // empty roster
      { data: { id: 'run-1', status: 'booked' } }, // → booked
    ])

    const result = await advanceAndBookSalaryRun(supabase as never, ARGS)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.nollkorning).toBe(true)
      expect(result.data.entryIds).toEqual([])
      expect(result.data.warnings).toEqual([])
    }
    expect(createSalaryRunEntries).not.toHaveBeenCalled()
    expect(eventBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'salary_run.booked' }),
    )
  })
})

describe('bookPaidSalaryRun', () => {
  it('requires the run to be in paid status', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'No rows' } }) // status filter misses

    const result = await bookPaidSalaryRun(supabase as never, ARGS)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('SALARY_RUN_NOT_CALCULATED')
      expect(result.details).toEqual({ reason: 'must_be_paid_status' })
    }
  })

  it('books a paid run and returns the entry ids', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: makeRun({ status: 'paid' }) },
      { data: [makeSre()] },
      { data: { id: 'run-1', status: 'booked' } },
    ])

    const result = await bookPaidSalaryRun(supabase as never, ARGS)

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.entryIds).toEqual(['je-1', 'je-2'])
    // Booking is the last chance to correct the payslip's Ackumulerat block
    // before the run becomes immutable.
    expect(refreshRunYtd).toHaveBeenCalledWith(expect.anything(), {
      companyId: 'company-1',
      salaryRunId: 'run-1',
    })
    expect(createSalaryRunEntries).toHaveBeenCalledTimes(1)
    expect(createSalaryRunEntries).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({ calculation_params: { slpRate: 0.2426 } }),
    )
  })
})

describe('bookPaidSalaryRun: utlägg repaid with the salary (#2331)', () => {
  const claimLine = (claimId: string, amount: number) => ({
    item_type: 'expense_reimbursement',
    amount,
    account_number: '2820',
    is_net_deduction: false,
    is_gross_deduction: false,
    source_expense_claim_id: claimId,
  })

  beforeEach(() => {
    vi.mocked(settleExpenseClaimsForBookedRun).mockResolvedValue({
      ok: true,
      data: { claim_count: 1, already_settled: 0, total_sek: 500, batches: [] },
    })
  })

  it('refuses to post anything when a linked claim is no longer open', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: makeRun({ status: 'paid', total_net: 23500 }) },
      { data: [makeSre({ net_salary: 23500, line_items: [claimLine('claim-1', 500)] })] },
      { data: [{ id: 'claim-1', status: 'paid', employee_id: 'e1', amount_sek: 500 }] }, // paid by bank meanwhile
    ])

    const result = await bookPaidSalaryRun(supabase as never, ARGS)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('SALARY_RUN_EXPENSE_CLAIM_NOT_OPEN')
      expect(result.details).toEqual({ claims: [{ claim_id: 'claim-1', reason: 'not_open' }] })
    }
    expect(createSalaryRunEntries).not.toHaveBeenCalled()
    expect(settleExpenseClaimsForBookedRun).not.toHaveBeenCalled()
  })

  it('posts the verifikat, books the run, then settles the claims against it', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: makeRun({ status: 'paid', total_net: 23500 }) },
      { data: [makeSre({ net_salary: 23500, line_items: [claimLine('claim-1', 500)] })] },
      { data: [{ id: 'claim-1', status: 'registered', employee_id: 'e1', amount_sek: '500.00' }] },
      { data: { id: 'run-1', status: 'booked' } },
    ])

    const result = await bookPaidSalaryRun(supabase as never, ARGS)

    expect(result.ok).toBe(true)
    expect(createSalaryRunEntries).toHaveBeenCalledTimes(1)
    expect(settleExpenseClaimsForBookedRun).toHaveBeenCalledWith(expect.anything(), {
      companyId: 'company-1',
      userId: 'user-1',
      salaryRunId: 'run-1',
    })
    expect(eventBus.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'salary_run.booked' }))
  })

  it('keeps the booking and logs loudly when the settle step fails after posting', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: makeRun({ status: 'paid', total_net: 23500 }) },
      { data: [makeSre({ net_salary: 23500, line_items: [claimLine('claim-1', 500)] })] },
      { data: [{ id: 'claim-1', status: 'registered', employee_id: 'e1', amount_sek: 500 }] },
      { data: { id: 'run-1', status: 'booked' } },
    ])
    vi.mocked(settleExpenseClaimsForBookedRun).mockResolvedValue({ ok: false, code: 'SETTLE_FAILED', detail: 'boom' })

    const result = await bookPaidSalaryRun(supabase as never, ARGS)

    expect(result.ok).toBe(true)
    const logError = (log as unknown as { error: ReturnType<typeof vi.fn> }).error
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining('NOT settled'),
      expect.any(Error),
      expect.objectContaining({ salaryRunId: 'run-1', code: 'SETTLE_FAILED' }),
    )
  })

  it('never touches the settle step for a run without linked lines', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: makeRun({ status: 'paid' }) },
      { data: [makeSre()] },
      { data: { id: 'run-1', status: 'booked' } },
    ])

    const result = await bookPaidSalaryRun(supabase as never, ARGS)

    expect(result.ok).toBe(true)
    expect(settleExpenseClaimsForBookedRun).not.toHaveBeenCalled()
  })

  it('posts a run that only repays utlägg (gross 0, net > 0) instead of treating it as a nollkörning', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: makeRun({ status: 'paid', total_gross: 0, total_tax: 0, total_net: 800, total_avgifter: 0 }) },
      {
        data: [
          makeSre({
            gross_salary: 0,
            tax_withheld: 0,
            net_salary: 800,
            avgifter_amount: 0,
            line_items: [claimLine('claim-1', 800)],
          }),
        ],
      },
      { data: [{ id: 'claim-1', status: 'registered', employee_id: 'e1', amount_sek: 800 }] },
      { data: { id: 'run-1', status: 'booked' } },
    ])

    const result = await bookPaidSalaryRun(supabase as never, ARGS)

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.nollkorning).toBe(false)
    expect(createSalaryRunEntries).toHaveBeenCalledTimes(1)
    expect(settleExpenseClaimsForBookedRun).toHaveBeenCalledTimes(1)
  })
})
