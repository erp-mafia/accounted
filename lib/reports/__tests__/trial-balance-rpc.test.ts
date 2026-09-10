import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ============================================================
// generateTrialBalance on the default path (issue #2470): period activity
// comes from the get_trial_balance_aggregates RPC. Same table-keyed FIFO
// mock as trial-balance.test.ts for the reads that stay in JS (period row,
// chart of accounts, opening balances), plus an rpc mock keyed by function
// name so the RPC arguments and the bucket folding are assertable.
// ============================================================

type MockResult = { data?: unknown; error?: unknown }
let mockResults: Record<string, MockResult[]>

function makeBuilder(tableName: string) {
  const b: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in', 'lt', 'lte', 'gte', 'neq', 'or', 'order', 'range', 'contains']) {
    b[m] = vi.fn().mockReturnValue(b)
  }
  const consume = (): MockResult => {
    const queue = mockResults[tableName]
    if (!queue || queue.length === 0) return { data: null, error: null }
    return queue.shift()!
  }
  b.single = vi.fn().mockImplementation(async () => consume())
  b.then = (resolve: (v: unknown) => void) => resolve(consume())
  return b
}

function makeClient() {
  const rpc = vi.fn().mockImplementation(async (fn: string) => {
    const queue = mockResults[`rpc:${fn}`]
    if (!queue || queue.length === 0) return { data: [], error: null }
    return queue.shift()!
  })
  return {
    from: vi.fn().mockImplementation((table: string) => makeBuilder(table)),
    rpc,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

import { generateTrialBalance } from '../trial-balance'

let supabase: ReturnType<typeof makeClient>
const savedFlag = process.env.REPORTS_TB_RPC

beforeEach(() => {
  vi.clearAllMocks()
  mockResults = {}
  supabase = makeClient()
  delete process.env.REPORTS_TB_RPC
})

afterEach(() => {
  if (savedFlag === undefined) delete process.env.REPORTS_TB_RPC
  else process.env.REPORTS_TB_RPC = savedFlag
})

const CHART = {
  data: [
    { account_number: '1930', account_name: 'Företagskonto', account_class: 1 },
    { account_number: '3001', account_name: 'Försäljning', account_class: 3 },
  ],
  error: null,
}

// getOpeningBalances also goes through rpc (compute_prior_opening_balances)
// when the period has no OB entry, so select the aggregates call by name.
function rpcArgs(): Record<string, unknown> {
  const calls = supabase.rpc.mock.calls.filter((c: unknown[]) => c[0] === 'get_trial_balance_aggregates')
  expect(calls).toHaveLength(1)
  return calls[0][1]
}

describe('generateTrialBalance via get_trial_balance_aggregates', () => {
  it('sums the period bucket into rows and never reads journal tables', async () => {
    mockResults = {
      fiscal_periods: [
        { data: { period_start: '2024-01-01', period_end: '2024-12-31', opening_balance_entry_id: null }, error: null },
      ],
      'rpc:get_trial_balance_aggregates': [
        {
          data: [
            { bucket: 'period', account_number: '3001', debit: 0, credit: '700' },
            { bucket: 'period', account_number: '1930', debit: 750, credit: 0 },
          ],
          error: null,
        },
      ],
      chart_of_accounts: [CHART],
    }

    const result = await generateTrialBalance(supabase, 'company-1', 'period-1', { closingEntry: 'include' })

    expect(result.rows.map((r) => r.account_number)).toEqual(['1930', '3001'])
    expect(result.rows[0]).toMatchObject({
      account_name: 'Företagskonto',
      opening_debit: 0,
      period_debit: 750,
      closing_debit: 750,
    })
    // Numeric arrives as a string from some PostgREST configurations: coerced.
    expect(result.rows[1]).toMatchObject({ period_credit: 700, closing_credit: 700 })
    expect(result.totalDebit).toBe(750)
    expect(result.totalCredit).toBe(700)
    expect(result.isBalanced).toBe(false)

    const tables = supabase.from.mock.calls.map((c: unknown[]) => c[0])
    expect(tables).not.toContain('journal_entries')
    expect(tables).not.toContain('journal_entry_lines')
    expect(rpcArgs()).toEqual({
      p_company_id: 'company-1',
      p_fiscal_period_id: 'period-1',
      p_closing_mode: 'include',
      p_from_date: null,
      p_to_date: null,
      p_exclude_entry_id: null,
      p_dimensions: null,
    })
  })

  it('passes the closing mode, the date range and the OB entry through', async () => {
    mockResults = {
      fiscal_periods: [
        {
          data: {
            period_start: '2024-01-01',
            period_end: '2024-12-31',
            opening_balance_entry_id: 'ob-1',
            closing_entry_id: 'closing-1',
            is_closed: true,
          },
          error: null,
        },
      ],
      // getOpeningBalances reads the OB entry's lines through the entry-lines
      // fetch: entries first, then lines.
      journal_entries: [{ data: [{ id: 'ob-1' }], error: null }],
      journal_entry_lines: [
        { data: [{ id: 'l1', account_number: '1930', debit_amount: 100, credit_amount: 0 }], error: null },
      ],
      chart_of_accounts: [CHART],
    }

    const result = await generateTrialBalance(supabase, 'company-1', 'period-1', {
      closingEntry: 'exclude-final',
      fromDate: '2024-04-01',
      toDate: '2024-06-30',
    })

    expect(rpcArgs()).toMatchObject({
      p_closing_mode: 'exclude-final',
      p_from_date: '2024-04-01',
      p_to_date: '2024-06-30',
      p_exclude_entry_id: 'ob-1',
      p_dimensions: null,
    })
    // IB from the OB entry survives an empty activity result.
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({ account_number: '1930', opening_debit: 100, closing_debit: 100 })
  })

  it('folds the rollforward bucket into IB and keeps the period bucket as activity', async () => {
    mockResults = {
      fiscal_periods: [
        { data: { period_start: '2024-01-01', period_end: '2024-12-31', opening_balance_entry_id: null }, error: null },
      ],
      'rpc:get_trial_balance_aggregates': [
        {
          data: [
            { bucket: 'period', account_number: '1930', debit: 500, credit: 0 },
            { bucket: 'period', account_number: '3001', debit: 0, credit: 500 },
            { bucket: 'rollforward', account_number: '1930', debit: 2000, credit: 0 },
            { bucket: 'rollforward', account_number: '3001', debit: 0, credit: 2000 },
          ],
          error: null,
        },
      ],
      chart_of_accounts: [CHART],
    }

    const result = await generateTrialBalance(supabase, 'company-1', 'period-1', {
      closingEntry: 'include',
      fromDate: '2024-04-01',
      toDate: '2024-06-30',
    })

    const acc1930 = result.rows.find((r) => r.account_number === '1930')!
    expect(acc1930.opening_debit).toBe(2000)
    expect(acc1930.period_debit).toBe(500)
    expect(acc1930.closing_debit).toBe(2500)
    const acc3001 = result.rows.find((r) => r.account_number === '3001')!
    expect(acc3001.opening_credit).toBe(2000)
    expect(acc3001.period_credit).toBe(500)
    expect(acc3001.closing_credit).toBe(2500)
    expect(result.isBalanced).toBe(true)
  })

  it('adds a rollforward on top of a prior-period IB for the same account', async () => {
    mockResults = {
      fiscal_periods: [
        { data: { period_start: '2024-01-01', period_end: '2024-12-31', opening_balance_entry_id: null }, error: null },
      ],
      // No OB entry: getOpeningBalances falls back to the prior-period RPC.
      'rpc:compute_prior_opening_balances': [
        { data: [{ account_number: '1930', debit: 1000, credit: 0 }], error: null },
      ],
      'rpc:get_trial_balance_aggregates': [
        {
          data: [
            { bucket: 'rollforward', account_number: '1930', debit: 250, credit: 0 },
            { bucket: 'period', account_number: '1930', debit: 0, credit: 50 },
          ],
          error: null,
        },
      ],
      chart_of_accounts: [CHART],
    }

    const result = await generateTrialBalance(supabase, 'company-1', 'period-1', {
      closingEntry: 'include',
      fromDate: '2024-07-01',
    })

    expect(rpcArgs()).toMatchObject({ p_from_date: '2024-07-01', p_to_date: null })
    expect(result.rows[0]).toMatchObject({
      opening_debit: 1250,
      period_credit: 50,
      closing_debit: 1250,
      closing_credit: 50,
    })
  })

  // The year opening is the IB before the rollforward bucket is folded in, so
  // Balansrapport's Ing balans and Ing saldo can differ on this path too. A
  // P&L account has no IB, so its year opening stays zero however much
  // rollforward it carries.
  it('keeps the year opening at the IB while the window opening takes the rollforward', async () => {
    mockResults = {
      fiscal_periods: [
        { data: { period_start: '2024-01-01', period_end: '2024-12-31', opening_balance_entry_id: null }, error: null },
      ],
      'rpc:compute_prior_opening_balances': [
        { data: [{ account_number: '1930', debit: 1000, credit: 0 }], error: null },
      ],
      'rpc:get_trial_balance_aggregates': [
        {
          data: [
            { bucket: 'rollforward', account_number: '1930', debit: 250, credit: 0 },
            { bucket: 'rollforward', account_number: '3001', debit: 0, credit: 2000 },
            { bucket: 'period', account_number: '3001', debit: 0, credit: 500 },
          ],
          error: null,
        },
      ],
      chart_of_accounts: [CHART],
    }

    const result = await generateTrialBalance(supabase, 'company-1', 'period-1', {
      closingEntry: 'include',
      fromDate: '2024-07-01',
    })

    const bank = result.rows.find((r) => r.account_number === '1930')
    const sales = result.rows.find((r) => r.account_number === '3001')
    expect(bank).toMatchObject({ year_opening_debit: 1000, opening_debit: 1250 })
    expect(sales).toMatchObject({
      year_opening_credit: 0,
      opening_credit: 2000,
      period_credit: 500,
      closing_credit: 2500,
    })
  })

  it('sends the dimension filter and drops company-wide IB for the filtered view', async () => {
    mockResults = {
      fiscal_periods: [
        { data: { period_start: '2024-01-01', period_end: '2024-12-31', opening_balance_entry_id: null }, error: null },
      ],
      'rpc:compute_prior_opening_balances': [
        { data: [{ account_number: '1930', debit: 9000, credit: 0 }], error: null },
      ],
      'rpc:get_trial_balance_aggregates': [
        { data: [{ bucket: 'period', account_number: '1930', debit: 500, credit: 0 }], error: null },
      ],
      chart_of_accounts: [CHART],
    }

    const result = await generateTrialBalance(supabase, 'company-1', 'period-1', {
      closingEntry: 'exclude-all-year-end',
      dimensions: { '6': 'P001' },
    })

    expect(rpcArgs()).toMatchObject({
      p_closing_mode: 'exclude-all-year-end',
      p_dimensions: { '6': 'P001' },
    })
    expect(result.rows[0]).toMatchObject({ opening_debit: 0, period_debit: 500, closing_debit: 500 })
  })

  it('treats an empty dimension object as no filter', async () => {
    mockResults = {
      fiscal_periods: [
        { data: { period_start: '2024-01-01', period_end: '2024-12-31', opening_balance_entry_id: null }, error: null },
      ],
      chart_of_accounts: [CHART],
    }

    await generateTrialBalance(supabase, 'company-1', 'period-1', { closingEntry: 'include', dimensions: {} })

    expect(rpcArgs()).toMatchObject({ p_dimensions: null })
  })

  it('does not fetch reversed year-end ids in JS: the RPC resolves the chain', async () => {
    mockResults = {
      fiscal_periods: [
        { data: { period_start: '2024-01-01', period_end: '2024-12-31', opening_balance_entry_id: null }, error: null },
      ],
      chart_of_accounts: [CHART],
    }

    await generateTrialBalance(supabase, 'company-1', 'period-1', { closingEntry: 'exclude-all-year-end' })

    const tables = supabase.from.mock.calls.map((c: unknown[]) => c[0])
    expect(tables).not.toContain('journal_entries')
    expect(rpcArgs()).toMatchObject({ p_closing_mode: 'exclude-all-year-end' })
  })

  it('fails closed before calling the RPC when a closed period has no closing entry', async () => {
    mockResults = {
      fiscal_periods: [
        {
          data: {
            period_start: '2025-01-01',
            period_end: '2025-12-31',
            opening_balance_entry_id: null,
            closing_entry_id: null,
            is_closed: true,
          },
          error: null,
        },
      ],
      chart_of_accounts: [{ data: [], error: null }],
    }

    await expect(
      generateTrialBalance(supabase, 'company-1', 'period-1', { closingEntry: 'exclude-final' }),
    ).rejects.toThrow(/missing closing_entry_id/i)

    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('surfaces an RPC error instead of an empty report', async () => {
    mockResults = {
      fiscal_periods: [
        { data: { period_start: '2024-01-01', period_end: '2024-12-31', opening_balance_entry_id: null }, error: null },
      ],
      'rpc:get_trial_balance_aggregates': [{ data: null, error: { message: 'statement timeout' } }],
      chart_of_accounts: [CHART],
    }

    await expect(
      generateTrialBalance(supabase, 'company-1', 'period-1', { closingEntry: 'include' }),
    ).rejects.toThrow(/get_trial_balance_aggregates failed: statement timeout/)
  })

  it('returns the empty report when neither IB nor activity exists', async () => {
    mockResults = {
      fiscal_periods: [{ data: null, error: null }],
      chart_of_accounts: [{ data: [], error: null }],
    }

    const result = await generateTrialBalance(supabase, 'company-1', 'period-1', { closingEntry: 'include' })

    expect(result).toEqual({ rows: [], totalDebit: 0, totalCredit: 0, isBalanced: true })
  })

  it('REPORTS_TB_RPC=off selects the entry-lines path', async () => {
    process.env.REPORTS_TB_RPC = 'off'
    mockResults = {
      fiscal_periods: [
        { data: { period_start: '2024-01-01', period_end: '2024-12-31', opening_balance_entry_id: null }, error: null },
      ],
      journal_entries: [{ data: [{ id: 'entry-1' }], error: null }],
      journal_entry_lines: [
        { data: [{ id: 'l1', account_number: '1930', debit_amount: 42, credit_amount: 0 }], error: null },
      ],
      chart_of_accounts: [CHART],
    }

    const result = await generateTrialBalance(supabase, 'company-1', 'period-1', { closingEntry: 'include' })

    expect(supabase.rpc).not.toHaveBeenCalledWith('get_trial_balance_aggregates', expect.anything())
    expect(result.rows[0]).toMatchObject({ account_number: '1930', period_debit: 42 })
  })
})
