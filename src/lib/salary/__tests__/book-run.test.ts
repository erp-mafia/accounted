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
// The rows -> engine-input mapper stays real (it is the contract under test
// via the createSalaryRunEntries call args); only the posting is mocked.
vi.mock('@/lib/salary/salary-entries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/salary/salary-entries')>()),
  createSalaryRunEntries: vi.fn(),
}))
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

// The token claim_salary_run_booking hands the call that may book the run.
const BOOKING_CLAIM = 'booking-claim-1'

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
      { data: BOOKING_CLAIM }, // claim_salary_run_booking
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

  it('warns by name when stored bank details name no payable account, without the number', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: makeRun({ status: 'review' }) },
      // Invented number: 11 digits that do not repeat the clearing.
      {
        data: [
          makeSre({
            employee: { ...makeSre().employee, clearing_number: '5037', bank_account_number: '96123456789' },
          }),
        ],
      },
      { data: { id: 'run-1' } },
      { data: { id: 'run-1' } },
      { data: BOOKING_CLAIM }, // claim_salary_run_booking
      { data: { id: 'run-1', status: 'booked' } },
    ])

    const result = await advanceAndBookSalaryRun(supabase as never, ARGS)

    expect(result.ok).toBe(true)
    if (result.ok) {
      const remark = result.data.warnings.find((w) => w.includes('kontonumret är ogiltigt'))
      expect(remark).toBeDefined()
      expect(result.data.warnings.join(' ')).not.toContain('96123456789')
    }
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
      { data: BOOKING_CLAIM }, // claim_salary_run_booking
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
      { data: BOOKING_CLAIM }, // claim_salary_run_booking
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
      { data: BOOKING_CLAIM }, // claim_salary_run_booking
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
      { data: BOOKING_CLAIM }, // claim_salary_run_booking
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
      { data: BOOKING_CLAIM }, // claim_salary_run_booking
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
      { data: BOOKING_CLAIM }, // claim_salary_run_booking
      { data: { id: 'run-1', status: 'booked' } },
    ])

    const result = await bookPaidSalaryRun(supabase as never, ARGS)

    expect(result.ok).toBe(true)
    expect(settleExpenseClaimsForBookedRun).not.toHaveBeenCalled()
  })

  it('posts a run that only repays utlägg (gross 0, net > 0) instead of treating it as a nollkörning', async () => {
    const { supabase, enqueueMany, findCalls } = createQueuedMockSupabase()
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
      { data: BOOKING_CLAIM }, // claim_salary_run_booking
      { data: [{ id: 'claim-1', status: 'registered', employee_id: 'e1', amount_sek: 800 }] },
      { data: { id: 'run-1', status: 'booked' } },
    ])

    // No avgifter in an utlägg-only run: createSalaryRunEntries posts no
    // avgifter voucher, and the run records none.
    vi.mocked(createSalaryRunEntries).mockResolvedValue({
      salaryEntry: { id: 'je-1' },
      avgifterEntry: null,
      vacationEntry: null,
      pensionEntry: null,
    } as never)

    const result = await bookPaidSalaryRun(supabase as never, ARGS)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.nollkorning).toBe(false)
      expect(result.data.entryIds).toEqual(['je-1'])
    }
    expect(createSalaryRunEntries).toHaveBeenCalledTimes(1)
    expect(settleExpenseClaimsForBookedRun).toHaveBeenCalledTimes(1)
    const runUpdate = findCalls('salary_runs', 'update').at(-1)?.[0] as Record<string, unknown>
    expect(runUpdate).toMatchObject({ status: 'booked', salary_entry_id: 'je-1' })
    expect(runUpdate).not.toHaveProperty('avgifter_entry_id')
  })
})

// accounted#3251: two concurrent book calls on the same run could both read
// it as 'paid' and both post its vouchers. The run is now claimed in the
// database (claim_salary_run_booking) before anything is posted, and only the
// claim holder can flip it to 'booked'.
describe('salary run booking claim (#3251)', () => {
  type Call = { table: string; method: string; args: unknown[] }

  /** The .eq filters of the paid -> booked UPDATE chain. */
  const flipFilters = (calls: Call[]) => {
    const start = calls.findIndex(
      (c) => c.table === 'salary_runs' && c.method === 'update' && (c.args[0] as { status?: string }).status === 'booked',
    )
    if (start === -1) return null
    const end = calls.findIndex((c, i) => i > start && c.method === 'maybeSingle')
    return calls.slice(start + 1, end).filter((c) => c.method === 'eq').map((c) => c.args)
  }

  /** The .eq filters of the claim release UPDATE, or null when there was none. */
  const releaseFilters = (calls: Call[]) => {
    const start = calls.findIndex(
      (c) =>
        c.table === 'salary_runs' &&
        c.method === 'update' &&
        (c.args[0] as Record<string, unknown>).status === undefined &&
        'booking_claim_id' in (c.args[0] as Record<string, unknown>),
    )
    if (start === -1) return null
    return calls.slice(start + 1, start + 4).map((c) => c.args)
  }

  it('claims the run with company and run id before posting', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: makeRun({ status: 'paid' }) },
      { data: [makeSre()] },
      { data: BOOKING_CLAIM },
      { data: { id: 'run-1', status: 'booked' } },
    ])

    const result = await bookPaidSalaryRun(supabase as never, ARGS)

    expect(result.ok).toBe(true)
    expect(supabase.rpc).toHaveBeenCalledWith('claim_salary_run_booking', {
      p_company_id: 'company-1',
      p_salary_run_id: 'run-1',
    })
  })

  it('answers 409 SALARY_RUN_BOOKING_IN_PROGRESS and posts nothing when another call holds the run', async () => {
    const { supabase, enqueueMany, calls } = createQueuedMockSupabase()
    enqueueMany([
      { data: makeRun({ status: 'paid' }) },
      { data: [makeSre()] },
      { data: null }, // claim refused
      { data: { status: 'paid' } }, // still paid: a live booking holds it
    ])

    const result = await bookPaidSalaryRun(supabase as never, ARGS)

    expect(result).toEqual({ ok: false, code: 'SALARY_RUN_BOOKING_IN_PROGRESS' })
    expect(createSalaryRunEntries).not.toHaveBeenCalled()
    expect(refreshRunYtd).not.toHaveBeenCalled()
    expect(eventBus.emit).not.toHaveBeenCalled()
    // It never held the claim, so it neither flips nor releases the run.
    expect(calls.some((c) => c.table === 'salary_runs' && c.method === 'update')).toBe(false)
  })

  it('answers SALARY_RUN_ALREADY_BOOKED when the concurrent call already booked the run', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: makeRun({ status: 'paid' }) },
      { data: [makeSre()] },
      { data: null },
      { data: { status: 'booked' } },
    ])

    const result = await bookPaidSalaryRun(supabase as never, ARGS)

    expect(result).toEqual({ ok: false, code: 'SALARY_RUN_ALREADY_BOOKED' })
    expect(createSalaryRunEntries).not.toHaveBeenCalled()
  })

  it('surfaces a failed claim call as a database error without posting', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    const dbError = { code: '42501', message: 'row-level security: no write access' }
    enqueueMany([
      { data: makeRun({ status: 'paid' }) },
      { data: [makeSre()] },
      { data: null, error: dbError },
    ])

    const result = await bookPaidSalaryRun(supabase as never, ARGS)

    expect(result).toEqual({ ok: false, code: 'SALARY_RUN_BOOK_FAILED', dbError })
    expect(createSalaryRunEntries).not.toHaveBeenCalled()
  })

  it('flips to booked only for the claim holder and clears the claim in the same update', async () => {
    const { supabase, enqueueMany, calls, findCalls } = createQueuedMockSupabase()
    enqueueMany([
      { data: makeRun({ status: 'paid' }) },
      { data: [makeSre()] },
      { data: BOOKING_CLAIM },
      { data: { id: 'run-1', status: 'booked' } },
    ])

    const result = await bookPaidSalaryRun(supabase as never, ARGS)

    expect(result.ok).toBe(true)
    const updates = findCalls('salary_runs', 'update')
    // One update: the flip. A booked run has no claim left to release.
    expect(updates).toHaveLength(1)
    expect(updates[0][0]).toMatchObject({
      status: 'booked',
      salary_entry_id: 'je-1',
      avgifter_entry_id: 'je-2',
      booked_by: 'user-1',
      booking_claim_id: null,
      booking_claimed_at: null,
    })
    expect(flipFilters(calls as Call[])).toEqual(
      expect.arrayContaining([
        ['id', 'run-1'],
        ['company_id', 'company-1'],
        ['status', 'paid'],
        ['booking_claim_id', BOOKING_CLAIM],
      ]),
    )
  })

  it('claims a nollkörning too, and flips it with the same filters', async () => {
    const { supabase, enqueueMany, calls } = createQueuedMockSupabase()
    enqueueMany([
      { data: makeRun({ status: 'paid', total_gross: 0, total_tax: 0, total_net: 0, total_avgifter: 0 }) },
      { data: [] },
      { data: BOOKING_CLAIM },
      { data: { id: 'run-1', status: 'booked' } },
    ])

    const result = await bookPaidSalaryRun(supabase as never, ARGS)

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.nollkorning).toBe(true)
    expect(supabase.rpc).toHaveBeenCalledWith('claim_salary_run_booking', expect.anything())
    expect(flipFilters(calls as Call[])).toEqual(
      expect.arrayContaining([
        ['status', 'paid'],
        ['booking_claim_id', BOOKING_CLAIM],
      ]),
    )
  })

  it('reports a lost claim at the flip as a failure, never as a booking', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: makeRun({ status: 'paid' }) },
      { data: [makeSre()] },
      { data: BOOKING_CLAIM },
      { data: null }, // the flip matched no row: the claim is no longer ours
    ])

    const result = await bookPaidSalaryRun(supabase as never, ARGS)

    expect(result).toEqual({
      ok: false,
      code: 'SALARY_RUN_BOOK_FAILED',
      details: { reason: 'booking_claim_lost', entry_ids: ['je-1', 'je-2'] },
    })
    expect(eventBus.emit).not.toHaveBeenCalled()
    const logError = (log as unknown as { error: ReturnType<typeof vi.fn> }).error
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining('claim lost'),
      expect.any(Error),
      expect.objectContaining({ salaryRunId: 'run-1', entryIds: ['je-1', 'je-2'] }),
    )
  })

  it('releases the claim when the engine throws, and rethrows', async () => {
    const { supabase, enqueueMany, calls } = createQueuedMockSupabase()
    enqueueMany([
      { data: makeRun({ status: 'paid' }) },
      { data: [makeSre()] },
      { data: BOOKING_CLAIM },
    ])
    vi.mocked(createSalaryRunEntries).mockRejectedValue(new Error('period locked'))

    await expect(bookPaidSalaryRun(supabase as never, ARGS)).rejects.toThrow('period locked')

    expect(releaseFilters(calls as Call[])).toEqual([
      ['id', 'run-1'],
      ['company_id', 'company-1'],
      ['booking_claim_id', BOOKING_CLAIM],
    ])
    expect(flipFilters(calls as Call[])).toBeNull()
  })

  it('releases the claim when a pre-posting check refuses the booking', async () => {
    const { supabase, enqueueMany, calls } = createQueuedMockSupabase()
    enqueueMany([
      { data: makeRun({ status: 'paid', total_net: 23500 }) },
      {
        data: [
          makeSre({
            net_salary: 23500,
            line_items: [
              {
                item_type: 'expense_reimbursement',
                amount: 500,
                account_number: '2820',
                is_net_deduction: false,
                is_gross_deduction: false,
                source_expense_claim_id: 'expense-1',
              },
            ],
          }),
        ],
      },
      { data: BOOKING_CLAIM },
      { data: [{ id: 'expense-1', status: 'paid', employee_id: 'e1', amount_sek: 500 }] },
    ])

    const result = await bookPaidSalaryRun(supabase as never, ARGS)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('SALARY_RUN_EXPENSE_CLAIM_NOT_OPEN')
    expect(createSalaryRunEntries).not.toHaveBeenCalled()
    expect(releaseFilters(calls as Call[])).toEqual([
      ['id', 'run-1'],
      ['company_id', 'company-1'],
      ['booking_claim_id', BOOKING_CLAIM],
    ])
  })

  it('makes the MCP advance-walk wait for the claim like every other door', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: makeRun({ status: 'paid' }) },
      { data: [makeSre()] },
      { data: null },
      { data: { status: 'paid' } },
    ])

    const result = await advanceAndBookSalaryRun(supabase as never, ARGS)

    expect(result).toEqual({ ok: false, code: 'SALARY_RUN_BOOKING_IN_PROGRESS' })
    expect(createSalaryRunEntries).not.toHaveBeenCalled()
  })
})
