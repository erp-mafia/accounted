/**
 * Tests for the payslip YTD ("Ackumulerat") snapshot: which prior runs count
 * toward it, how cutover opening balances interact with it, and the refresh
 * that keeps it from rotting when runs are calculated out of order.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  computePriorYtd,
  loadOpeningBalances,
  refreshRunYtd,
  YTD_COUNTED_STATUSES,
} from '../ytd'

const COMPANY = 'company-1'

const makePrior = (overrides: Record<string, unknown> = {}) => ({
  employee_id: 'e1',
  gross_salary: 25000,
  tax_withheld: 4346,
  net_salary: 20654,
  salary_run: { period_year: 2026, period_month: 6, status: 'booked' },
  ...overrides,
})

describe('YTD_COUNTED_STATUSES', () => {
  it('retains a mid-month starter first salary in the following month YTD', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: [makePrior({ salary_run: { period_year: 2026, period_month: 8, status: 'booked' } })] })
    const totals = await computePriorYtd(mock.supabase as never, { companyId: COMPANY, periodYear: 2026, periodMonth: 9,
      employeeIds: ['e1'], openingRows: [{ employee_id: 'e1', cutover_date: '2026-08-01', ytd_gross: 0, ytd_tax: 0, ytd_net: 0 }] })
    expect(totals.get('e1')).toEqual({ gross: 25000, tax: 4346, net: 20654 })
  })
  it('preserves unknown historical net rather than deriving it from gross and tax', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: [] })
    const totals = await computePriorYtd(mock.supabase as never, { companyId: COMPANY, periodYear: 2026, periodMonth: 8,
      employeeIds: ['e1'], openingRows: [{ employee_id: 'e1', cutover_date: '2026-08-01', ytd_gross: 210000, ytd_tax: 48000, ytd_net: null }] })
    expect(totals.get('e1')).toEqual({ gross: 210000, tax: 48000, net: null })
  })
  it('counts every authorized status but never draft, review or corrected', () => {
    // A month in `paid` has left the building; a month in `corrected` is
    // superseded by its correction run and would double the month.
    expect([...YTD_COUNTED_STATUSES]).toEqual(['approved', 'paid', 'booked'])
  })
})

describe('loadOpeningBalances', () => {
  let mock: ReturnType<typeof createQueuedMockSupabase>

  beforeEach(() => {
    mock = createQueuedMockSupabase()
  })

  it('short-circuits an empty roster without querying', async () => {
    expect(await loadOpeningBalances(mock.supabase as never, COMPANY, [])).toEqual([])
    expect(mock.calls).toHaveLength(0)
  })

  it('reads the karens carry-over alongside the YTD columns, ordered for paging', async () => {
    mock.enqueue({ data: [] })

    await loadOpeningBalances(mock.supabase as never, COMPANY, ['e1'])

    // karens_periods_adjustment feeds sjuklön, so it rides along with the YTD
    // columns rather than costing a second read of the same row.
    expect(mock.findCall('employee_opening_balances', 'select')).toEqual([
      'employee_id, cutover_date, ytd_gross, ytd_tax, ytd_net, karens_periods_adjustment, vacation_balance',
    ])
    expect(mock.findCall('employee_opening_balances', 'order')).toEqual(['id'])
  })

  it('throws rather than reporting nobody has a cutover balance', async () => {
    mock.enqueue({ error: { message: 'opening down' } })

    await expect(
      loadOpeningBalances(mock.supabase as never, COMPANY, ['e1']),
    ).rejects.toThrow('opening down')
  })
})

describe('computePriorYtd', () => {
  let mock: ReturnType<typeof createQueuedMockSupabase>

  beforeEach(() => {
    mock = createQueuedMockSupabase()
  })

  it('returns an empty map without querying when the roster is empty', async () => {
    const ytd = await computePriorYtd(mock.supabase as never, {
      companyId: COMPANY,
      periodYear: 2026,
      periodMonth: 8,
      employeeIds: [],
    })

    expect(ytd.size).toBe(0)
    expect(mock.calls).toHaveLength(0)
  })

  it('sums prior months and filters on every authorized status', async () => {
    mock.enqueue({ data: [] }) // employee_opening_balances
    mock.enqueue({
      data: [
        makePrior({ salary_run: { period_year: 2026, period_month: 6, status: 'booked' } }),
        makePrior({
          gross_salary: 35000,
          tax_withheld: 6709,
          net_salary: 28291,
          // The regression: an earlier month approved but not yet booked was
          // silently worth 0, so the next payslip understated Ackumulerat.
          salary_run: { period_year: 2026, period_month: 7, status: 'approved' },
        }),
      ],
    })

    const ytd = await computePriorYtd(mock.supabase as never, {
      companyId: COMPANY,
      periodYear: 2026,
      periodMonth: 8,
      employeeIds: ['e1'],
    })

    expect(ytd.get('e1')).toEqual({ gross: 60000, tax: 11055, net: 48945 })
    expect(mock.findCalls('salary_run_employees', 'in')).toContainEqual([
      'salary_run.status',
      YTD_COUNTED_STATUSES,
    ])
    expect(mock.findCall('salary_run_employees', 'lt')).toEqual(['salary_run.period_month', 8])
  })

  it('carries actual withholding and payout rather than superseded computed tax', async () => {
    mock.enqueue({ data: [makePrior({ tax_withheld_override: 5000 })] })
    const ytd = await computePriorYtd(mock.supabase as never, { companyId: COMPANY,
      periodYear: 2026, periodMonth: 8, employeeIds: ['e1'], openingRows: [] })
    expect(ytd.get('e1')).toEqual({ gross: 25000, tax: 5000, net: 20000 })
  })

  it('lets the opening balance own the pre-cutover months', async () => {
    mock.enqueue({
      data: [
        // Backdated into a month the opening balance already carries: skipped
        // so the pre-cutover pay is not counted twice.
        makePrior({ salary_run: { period_year: 2026, period_month: 2, status: 'booked' } }),
        makePrior({
          gross_salary: 30000,
          tax_withheld: 6000,
          net_salary: 24000,
          salary_run: { period_year: 2026, period_month: 5, status: 'booked' },
        }),
      ],
    })

    const ytd = await computePriorYtd(mock.supabase as never, {
      companyId: COMPANY,
      periodYear: 2026,
      periodMonth: 8,
      employeeIds: ['e1'],
      openingRows: [
        {
          employee_id: 'e1',
          cutover_date: '2026-04-01',
          ytd_gross: 90000,
          ytd_tax: 18000,
          ytd_net: 72000,
        },
      ],
    })

    expect(ytd.get('e1')).toEqual({ gross: 120000, tax: 24000, net: 96000 })
  })

  it('ignores an opening balance from a different year', async () => {
    mock.enqueue({ data: [makePrior()] })

    const ytd = await computePriorYtd(mock.supabase as never, {
      companyId: COMPANY,
      periodYear: 2026,
      periodMonth: 8,
      employeeIds: ['e1'],
      openingRows: [
        {
          employee_id: 'e1',
          cutover_date: '2025-04-01',
          ytd_gross: 90000,
          ytd_tax: 18000,
          ytd_net: 72000,
        },
      ],
    })

    expect(ytd.get('e1')).toEqual({ gross: 25000, tax: 4346, net: 20654 })
  })

  it('orders the paged prior-run read on the primary key', async () => {
    mock.enqueue({ data: [] })
    mock.enqueue({ data: [] })

    await computePriorYtd(mock.supabase as never, {
      companyId: COMPANY,
      periodYear: 2026,
      periodMonth: 8,
      employeeIds: ['e1'],
    })

    // Without a stable total order, a roster wide enough to page would skip
    // or double a month across the page boundary.
    expect(mock.findCall('salary_run_employees', 'order')).toEqual(['id'])
  })

  it('throws rather than reporting an empty carry-in when the read fails', async () => {
    mock.enqueue({ data: [] })
    mock.enqueue({ error: { message: 'boom' } })

    // Returning an empty map here would silently rewrite the snapshot to the
    // current month alone, which is the exact failure this module exists to
    // prevent.
    await expect(
      computePriorYtd(mock.supabase as never, {
        companyId: COMPANY,
        periodYear: 2026,
        periodMonth: 8,
        employeeIds: ['e1'],
      }),
    ).rejects.toThrow('boom')
  })

  it('skips the opening-balance query when the caller already loaded them', async () => {
    mock.enqueue({ data: [] }) // prior runs

    await computePriorYtd(mock.supabase as never, {
      companyId: COMPANY,
      periodYear: 2026,
      periodMonth: 8,
      employeeIds: ['e1'],
      openingRows: [],
    })

    expect(mock.calls.some((c) => c.table === 'employee_opening_balances')).toBe(false)
  })
})

describe('refreshRunYtd', () => {
  let mock: ReturnType<typeof createQueuedMockSupabase>

  beforeEach(() => {
    mock = createQueuedMockSupabase()
  })

  const enqueueRun = () =>
    mock.enqueue({ data: { id: 'run-1', period_year: 2026, period_month: 8 } })

  it('refreshes current-month YTD with an explicit zero-tax override', async () => {
    enqueueRun()
    mock.enqueue({ data: [{ id: 'sre-1', employee_id: 'e1', gross_salary: 35000,
      tax_withheld: 6709, tax_withheld_override: 0, net_salary: 28291,
      ytd_gross: 35000, ytd_tax: 6709, ytd_net: 28291 }] })
    mock.enqueue({ data: [] })
    mock.enqueue({ data: [] })
    mock.enqueue({ data: null })
    expect(await refreshRunYtd(mock.supabase as never, { companyId: COMPANY, salaryRunId: 'run-1' }))
      .toEqual({ ok: true, updated: 1 })
    expect(mock.findCall('salary_run_employees', 'update')).toEqual([{ ytd_gross: 35000, ytd_tax: 0, ytd_net: 35000 }])
  })

  it('rewrites a snapshot that was frozen before an earlier month was booked', async () => {
    enqueueRun()
    mock.enqueue({
      data: [
        {
          id: 'sre-1',
          employee_id: 'e1',
          gross_salary: 35000,
          tax_withheld: 6709,
          net_salary: 28291,
          // Stale: captured when only June (25 000) had been booked.
          ytd_gross: 60000,
          ytd_tax: 11055,
          ytd_net: 48945,
        },
      ],
    })
    mock.enqueue({ data: [] }) // opening balances
    mock.enqueue({
      data: [
        makePrior({ salary_run: { period_year: 2026, period_month: 6, status: 'booked' } }),
        makePrior({
          gross_salary: 35000,
          tax_withheld: 6709,
          net_salary: 28291,
          salary_run: { period_year: 2026, period_month: 7, status: 'booked' },
        }),
      ],
    })
    mock.enqueue({ data: null }) // the update

    const result = await refreshRunYtd(mock.supabase as never, {
      companyId: COMPANY,
      salaryRunId: 'run-1',
    })

    expect(result).toEqual({ ok: true, updated: 1 })
    expect(mock.findCall('salary_run_employees', 'update')).toEqual([
      { ytd_gross: 95000, ytd_tax: 17764, ytd_net: 77236 },
    ])
  })

  it('leaves an already-correct snapshot untouched', async () => {
    enqueueRun()
    mock.enqueue({
      data: [
        {
          id: 'sre-1',
          employee_id: 'e1',
          gross_salary: 35000,
          tax_withheld: 6709,
          net_salary: 28291,
          ytd_gross: 60000,
          ytd_tax: 11055,
          ytd_net: 48945,
        },
      ],
    })
    mock.enqueue({ data: [] })
    mock.enqueue({ data: [makePrior()] })

    const result = await refreshRunYtd(mock.supabase as never, {
      companyId: COMPANY,
      salaryRunId: 'run-1',
    })

    expect(result).toEqual({ ok: true, updated: 0 })
    expect(mock.findCall('salary_run_employees', 'update')).toBeUndefined()
  })

  it('reports a missing run instead of throwing', async () => {
    mock.enqueue({ data: null })

    const result = await refreshRunYtd(mock.supabase as never, {
      companyId: COMPANY,
      salaryRunId: 'run-1',
    })

    expect(result).toEqual({ ok: false, message: 'salary run not found' })
  })

  it('reports a database error instead of throwing', async () => {
    mock.enqueue({ error: { message: 'boom' } })

    const result = await refreshRunYtd(mock.supabase as never, {
      companyId: COMPANY,
      salaryRunId: 'run-1',
    })

    expect(result).toEqual({ ok: false, message: 'boom' })
  })

  it('reports a failed prior-run read instead of writing a truncated snapshot', async () => {
    enqueueRun()
    mock.enqueue({
      data: [
        {
          id: 'sre-1',
          employee_id: 'e1',
          gross_salary: 35000,
          tax_withheld: 6709,
          net_salary: 28291,
          ytd_gross: 60000,
          ytd_tax: 11055,
          ytd_net: 48945,
        },
      ],
    })
    mock.enqueue({ data: [] }) // opening balances
    mock.enqueue({ error: { message: 'boom' } }) // prior runs

    const result = await refreshRunYtd(mock.supabase as never, {
      companyId: COMPANY,
      salaryRunId: 'run-1',
    })

    expect(result).toEqual({ ok: false, message: 'boom' })
    expect(mock.findCall('salary_run_employees', 'update')).toBeUndefined()
  })

  it('is a no-op for a run with no roster', async () => {
    enqueueRun()
    mock.enqueue({ data: [] })

    const result = await refreshRunYtd(mock.supabase as never, {
      companyId: COMPANY,
      salaryRunId: 'run-1',
    })

    expect(result).toEqual({ ok: true, updated: 0 })
  })
})
