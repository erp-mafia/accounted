import { describe, it, expect, vi, beforeEach } from 'vitest'

// The period's unlinked IB verifikat has its own tests
// (opening-balance/unlinked.test.ts, opening-balances.test.ts); here the
// year has none, so the queued journal reads stay the report's own.
vi.mock('@/lib/import/opening-balance/unlinked', () => ({
  findUnlinkedOpeningBalance: vi.fn(async () => null),
}))

// ============================================================
// Mock: table-keyed result queues
//
// Tests queue entry rows (journal_entries, with the entry fields the report
// reads) and line rows that reference them via journal_entry_id
// (journal_entry_lines). The opening-balance entry is read with the two-step
// entry-lines helper (lib/bookkeeping/entry-lines.ts), which consumes them as
// queries; the period's lines come from the get_general_ledger_lines RPC,
// which the mock answers from the next queued entries and lines, joined the
// way the SQL joins them (the SQL's own filtering and order are pinned by
// tests/pg/ledger-account-days.pg.test.ts; the rows come back unsorted here
// so the report's own grouping and sorting are what is tested).
// ============================================================

type MockResult = { data?: unknown; error?: unknown }
let mockResults: Record<string, MockResult[]>

function consume(key: string): MockResult {
  const queue = mockResults[key]
  if (!queue || queue.length === 0) return { data: null, error: null }
  return queue.shift()!
}

function makeBuilder(tableName: string) {
  const b: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in', 'lt', 'neq', 'order', 'range', 'contains']) {
    b[m] = vi.fn().mockReturnValue(b)
  }
  b.single = vi.fn().mockImplementation(async () => consume(tableName))
  b.then = (resolve: (v: unknown) => void) => resolve(consume(tableName))
  return b
}

/** get_general_ledger_lines' rows from the next queued entries and lines. */
function ledgerLineRows(): unknown[] {
  const entries = (consume('journal_entries').data ?? []) as Array<Record<string, unknown>>
  const lines = (consume('journal_entry_lines').data ?? []) as Array<Record<string, unknown>>
  const byId = new Map(entries.map((e) => [e.id, e]))
  return lines
    .filter((l) => byId.has(l.journal_entry_id))
    .map((l, i) => {
      const e = byId.get(l.journal_entry_id)!
      return {
        line_id: l.id ?? `line-${i}`,
        account_number: l.account_number,
        debit_amount: l.debit_amount,
        credit_amount: l.credit_amount,
        dimensions: l.dimensions ?? {},
        journal_entry_id: l.journal_entry_id,
        entry_date: e.entry_date,
        voucher_series: e.voucher_series,
        voucher_number: e.voucher_number,
        description: e.description,
        source_type: e.source_type,
      }
    })
}

function makeClient() {
  const rpc = vi.fn().mockImplementation(async (fn: string) => {
    const queue = mockResults[`rpc:${fn}`]
    if (queue && queue.length > 0) return queue.shift()!
    if (fn === 'get_general_ledger_lines') return { data: ledgerLineRows(), error: null }
    return { data: [], error: null }
  })
  return {
    from: vi.fn().mockImplementation((table: string) => makeBuilder(table)),
    rpc,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

import {
  generateGeneralLedger,
  generateGeneralLedgerAccountPage,
  generateGeneralLedgerOverview,
  GENERAL_LEDGER_INLINE_LINES,
} from '../general-ledger'

let supabase: ReturnType<typeof makeClient>

beforeEach(() => {
  vi.clearAllMocks()
  mockResults = {}
  supabase = makeClient()
})

describe('generateGeneralLedger', () => {
  it('returns empty report when no fiscal period found', async () => {
    mockResults = {
      fiscal_periods: [{ data: null, error: null }],
    }

    const report = await generateGeneralLedger(supabase, 'company-1', 'period-1')
    expect(report.accounts).toEqual([])
    expect(report.period).toEqual({ start: '', end: '' })
  })

  it('returns empty report when no entries in period', async () => {
    mockResults = {
      fiscal_periods: [
        { data: { period_start: '2024-01-01', period_end: '2024-12-31', opening_balance_entry_id: null }, error: null },
      ],
      // No matching entries → the line query is skipped entirely.
      journal_entries: [{ data: [], error: null }],
    }

    const report = await generateGeneralLedger(supabase, 'company-1', 'period-1')
    expect(report.accounts).toEqual([])
    expect(report.period).toEqual({ start: '2024-01-01', end: '2024-12-31' })
  })

  it('groups lines by account with correct totals and running balance', async () => {
    mockResults = {
      fiscal_periods: [
        { data: { period_start: '2024-01-01', period_end: '2024-12-31', opening_balance_entry_id: null }, error: null },
      ],
      journal_entries: [
        {
          data: [
            { id: 'e1', entry_date: '2024-01-15', voucher_number: 1, voucher_series: 'A', description: 'Sale', source_type: 'invoice' },
            { id: 'e2', entry_date: '2024-02-10', voucher_number: 2, voucher_series: 'A', description: 'Payment', source_type: 'transaction' },
          ],
          error: null,
        },
      ],
      journal_entry_lines: [
        // period lines (parent entry reattached from the entries fetch)
        {
          data: [
            { account_number: '1510', debit_amount: 1250, credit_amount: 0, journal_entry_id: 'e1' },
            { account_number: '3001', debit_amount: 0, credit_amount: 1000, journal_entry_id: 'e1' },
            { account_number: '2611', debit_amount: 0, credit_amount: 250, journal_entry_id: 'e1' },
            { account_number: '1930', debit_amount: 1250, credit_amount: 0, journal_entry_id: 'e2' },
            { account_number: '1510', debit_amount: 0, credit_amount: 1250, journal_entry_id: 'e2' },
          ],
          error: null,
        },
      ],
      chart_of_accounts: [
        {
          data: [
            { account_number: '1510', account_name: 'Kundfordringar' },
            { account_number: '1930', account_name: 'Företagskonto' },
            { account_number: '2611', account_name: 'Utgående moms 25%' },
            { account_number: '3001', account_name: 'Försäljning 25%' },
          ],
          error: null,
        },
      ],
    }

    const report = await generateGeneralLedger(supabase, 'company-1', 'period-1')

    expect(report.accounts).toHaveLength(4)
    expect(report.accounts.map((a) => a.account_number)).toEqual(['1510', '1930', '2611', '3001'])

    // Account 1510: debit 1250, credit 1250 → closing 0
    const acc1510 = report.accounts.find((a) => a.account_number === '1510')!
    expect(acc1510.total_debit).toBe(1250)
    expect(acc1510.total_credit).toBe(1250)
    expect(acc1510.closing_balance).toBe(0)
    expect(acc1510.lines).toHaveLength(2)
    expect(acc1510.lines[0].balance).toBe(1250)
    expect(acc1510.lines[1].balance).toBe(0)

    // Account 1930: debit 1250, credit 0 → closing 1250
    const acc1930 = report.accounts.find((a) => a.account_number === '1930')!
    expect(acc1930.total_debit).toBe(1250)
    expect(acc1930.total_credit).toBe(0)
    expect(acc1930.closing_balance).toBe(1250)
  })

  it('computes opening balance from prior period entries', async () => {
    mockResults = {
      fiscal_periods: [
        { data: { period_start: '2025-01-01', period_end: '2025-12-31', opening_balance_entry_id: null }, error: null },
      ],
      'rpc:compute_prior_opening_balances': [
        {
          data: [{ account_number: '1930', debit: 10000, credit: 0 }],
          error: null,
        },
      ],
      journal_entries: [
        {
          data: [
            { id: 'e1', entry_date: '2025-03-01', voucher_number: 1, voucher_series: 'A', description: 'Purchase', source_type: 'manual' },
          ],
          error: null,
        },
      ],
      journal_entry_lines: [
        // period lines
        {
          data: [
            { account_number: '1930', debit_amount: 0, credit_amount: 500, journal_entry_id: 'e1' },
            { account_number: '5410', debit_amount: 500, credit_amount: 0, journal_entry_id: 'e1' },
          ],
          error: null,
        },
      ],
      chart_of_accounts: [
        {
          data: [
            { account_number: '1930', account_name: 'Företagskonto' },
            { account_number: '5410', account_name: 'Förbrukningsinventarier' },
          ],
          error: null,
        },
      ],
    }

    const report = await generateGeneralLedger(supabase, 'company-1', 'period-2')

    const acc1930 = report.accounts.find((a) => a.account_number === '1930')!
    expect(acc1930.opening_balance).toBe(10000)
    expect(acc1930.closing_balance).toBe(9500) // 10000 - 500
    expect(acc1930.lines[0].balance).toBe(9500)
  })

  it('opens a project-filtered ledger at the project\'s IB, derived with p_dimensions (#3313)', async () => {
    mockResults = {
      fiscal_periods: [
        { data: { period_start: '2026-01-01', period_end: '2026-12-31', opening_balance_entry_id: null }, error: null },
      ],
      // The registry: projekt accumulates across years.
      dimensions: [{ data: [{ sie_dim_no: 6 }], error: null }],
      // Continuation import: no IB entry, the derived IB is scoped to P1.
      'rpc:compute_prior_opening_balances': [
        { data: [{ account_number: '1470', debit: 1300, credit: 0 }], error: null },
      ],
      journal_entries: [
        {
          data: [
            { id: 'e1', entry_date: '2026-02-01', voucher_number: 1, voucher_series: 'A', description: 'Arbete', source_type: 'manual' },
          ],
          error: null,
        },
      ],
      journal_entry_lines: [
        {
          data: [
            { account_number: '1470', debit_amount: 200, credit_amount: 0, journal_entry_id: 'e1', dimensions: { '6': 'P1' } },
          ],
          error: null,
        },
      ],
      chart_of_accounts: [{ data: [{ account_number: '1470', account_name: 'Pågående arbeten' }], error: null }],
    }

    const report = await generateGeneralLedger(supabase, 'company-1', 'period-1', undefined, undefined, {
      dimensions: { '6': 'P1' },
    })

    expect(supabase.rpc).toHaveBeenCalledWith('compute_prior_opening_balances', {
      p_company_id: 'company-1',
      p_period_start: '2026-01-01',
      p_dimensions: { '6': 'P1' },
    })
    const wip = report.accounts.find((a) => a.account_number === '1470')!
    expect(wip.opening_balance).toBe(1300)
    expect(wip.closing_balance).toBe(1500)
    expect(wip.lines[0].balance).toBe(1500)
  })

  it('opens a kostnadsställe-filtered ledger at 0: dimension 1 resets annually (#3313)', async () => {
    mockResults = {
      fiscal_periods: [
        { data: { period_start: '2026-01-01', period_end: '2026-12-31', opening_balance_entry_id: null }, error: null },
      ],
      // Only projekt accumulates; the prior history's K1 tags never reach IB.
      dimensions: [{ data: [{ sie_dim_no: 6 }], error: null }],
      'rpc:compute_prior_opening_balances': [
        { data: [{ account_number: '1470', debit: 300, credit: 0 }], error: null },
      ],
      journal_entries: [
        {
          data: [
            { id: 'e1', entry_date: '2026-02-01', voucher_number: 1, voucher_series: 'A', description: 'Arbete', source_type: 'manual' },
          ],
          error: null,
        },
      ],
      journal_entry_lines: [
        {
          data: [
            { account_number: '1470', debit_amount: 200, credit_amount: 0, journal_entry_id: 'e1', dimensions: { '1': 'K1' } },
          ],
          error: null,
        },
      ],
      chart_of_accounts: [{ data: [{ account_number: '1470', account_name: 'Pågående arbeten' }], error: null }],
    }

    const report = await generateGeneralLedger(supabase, 'company-1', 'period-1', undefined, undefined, {
      dimensions: { '1': 'K1' },
    })

    expect(supabase.rpc).not.toHaveBeenCalledWith('compute_prior_opening_balances', expect.anything())
    const wip = report.accounts.find((a) => a.account_number === '1470')!
    expect(wip.opening_balance).toBe(0)
    expect(wip.closing_balance).toBe(200)
  })

  it('filters accounts by account_from and account_to', async () => {
    mockResults = {
      fiscal_periods: [
        { data: { period_start: '2024-01-01', period_end: '2024-12-31', opening_balance_entry_id: null }, error: null },
      ],
      journal_entries: [
        {
          data: [
            { id: 'e1', entry_date: '2024-01-15', voucher_number: 1, voucher_series: 'A', description: 'Test', source_type: 'manual' },
          ],
          error: null,
        },
      ],
      journal_entry_lines: [
        // period lines across multiple accounts
        {
          data: [
            { account_number: '1510', debit_amount: 1000, credit_amount: 0, journal_entry_id: 'e1' },
            { account_number: '1930', debit_amount: 0, credit_amount: 500, journal_entry_id: 'e1' },
            { account_number: '3001', debit_amount: 0, credit_amount: 500, journal_entry_id: 'e1' },
          ],
          error: null,
        },
      ],
      chart_of_accounts: [
        { data: [], error: null },
      ],
    }

    const report = await generateGeneralLedger(supabase, 'company-1', 'period-1', '1500', '1999')

    // Only accounts in 1500-1999 range
    expect(report.accounts.map((a) => a.account_number)).toEqual(['1510', '1930'])
  })

  it('sorts lines within account by date then voucher number', async () => {
    mockResults = {
      fiscal_periods: [
        { data: { period_start: '2024-01-01', period_end: '2024-12-31', opening_balance_entry_id: null }, error: null },
      ],
      journal_entries: [
        {
          data: [
            { id: 'e1', entry_date: '2024-01-10', voucher_number: 2, voucher_series: 'A', description: 'Second', source_type: 'manual' },
            { id: 'e2', entry_date: '2024-01-10', voucher_number: 1, voucher_series: 'A', description: 'First', source_type: 'manual' },
            { id: 'e3', entry_date: '2024-01-05', voucher_number: 3, voucher_series: 'A', description: 'Earlier date', source_type: 'manual' },
          ],
          error: null,
        },
      ],
      journal_entry_lines: [
        // period lines: out of order
        {
          data: [
            { account_number: '1930', debit_amount: 100, credit_amount: 0, journal_entry_id: 'e1' },
            { account_number: '1930', debit_amount: 200, credit_amount: 0, journal_entry_id: 'e2' },
            { account_number: '1930', debit_amount: 300, credit_amount: 0, journal_entry_id: 'e3' },
          ],
          error: null,
        },
      ],
      chart_of_accounts: [
        { data: [{ account_number: '1930', account_name: 'Företagskonto' }], error: null },
      ],
    }

    const report = await generateGeneralLedger(supabase, 'company-1', 'period-1')
    const acc = report.accounts[0]

    // e3 (Jan 5) first, then e2 (Jan 10, #1), then e1 (Jan 10, #2)
    expect(acc.lines[0].description).toBe('Earlier date')
    expect(acc.lines[1].description).toBe('First')
    expect(acc.lines[2].description).toBe('Second')
  })

  it('rolls lines before fromDate into the opening balance and drops lines after toDate', async () => {
    mockResults = {
      fiscal_periods: [
        { data: { period_start: '2026-01-01', period_end: '2026-12-31', opening_balance_entry_id: null }, error: null },
      ],
      'rpc:compute_prior_opening_balances': [
        {
          data: [{ account_number: '1930', debit: 10000, credit: 0 }],
          error: null,
        },
      ],
      journal_entries: [
        {
          data: [
            { id: 'e1', entry_date: '2026-03-15', voucher_number: 1, voucher_series: 'A', description: 'Pre-range', source_type: 'manual' },
            { id: 'e2', entry_date: '2026-06-10', voucher_number: 2, voucher_series: 'A', description: 'In range', source_type: 'manual' },
            { id: 'e3', entry_date: '2026-09-01', voucher_number: 3, voucher_series: 'A', description: 'Post-range', source_type: 'manual' },
          ],
          error: null,
        },
      ],
      journal_entry_lines: [
        {
          data: [
            // Before the range: rolls into opening
            { account_number: '1930', debit_amount: 0, credit_amount: 2000, journal_entry_id: 'e1' },
            // Inside the range: shown
            { account_number: '1930', debit_amount: 500, credit_amount: 0, journal_entry_id: 'e2' },
            // After the range: dropped entirely
            { account_number: '1930', debit_amount: 0, credit_amount: 300, journal_entry_id: 'e3' },
          ],
          error: null,
        },
      ],
      chart_of_accounts: [
        { data: [{ account_number: '1930', account_name: 'Företagskonto' }], error: null },
      ],
    }

    const report = await generateGeneralLedger(supabase, 'company-1', 'period-1', undefined, undefined, {
      fromDate: '2026-06-01',
      toDate: '2026-06-30',
    })

    const acc = report.accounts.find((a) => a.account_number === '1930')!
    // Opening at range start = period IB 10000 - pre-range 2000
    expect(acc.opening_balance).toBe(8000)
    expect(acc.lines).toHaveLength(1)
    expect(acc.lines[0].description).toBe('In range')
    expect(acc.lines[0].balance).toBe(8500)
    // Closing = opening + in-range movement only; post-range line excluded
    expect(acc.closing_balance).toBe(8500)
    expect(report.period).toEqual({ start: '2026-06-01', end: '2026-06-30' })
  })

  it('keeps an account visible when all its lines fall before the range', async () => {
    mockResults = {
      fiscal_periods: [
        { data: { period_start: '2026-01-01', period_end: '2026-12-31', opening_balance_entry_id: null }, error: null },
      ],
      journal_entries: [
        {
          data: [
            { id: 'e1', entry_date: '2026-02-01', voucher_number: 1, voucher_series: 'A', description: 'Hyra feb', source_type: 'manual' },
          ],
          error: null,
        },
      ],
      journal_entry_lines: [
        {
          data: [
            { account_number: '5010', debit_amount: 4000, credit_amount: 0, journal_entry_id: 'e1' },
          ],
          error: null,
        },
      ],
      chart_of_accounts: [
        { data: [{ account_number: '5010', account_name: 'Lokalhyra' }], error: null },
      ],
    }

    const report = await generateGeneralLedger(supabase, 'company-1', 'period-1', undefined, undefined, {
      fromDate: '2026-06-01',
      toDate: '2026-06-30',
    })

    const acc = report.accounts.find((a) => a.account_number === '5010')!
    expect(acc.opening_balance).toBe(4000)
    expect(acc.lines).toHaveLength(0)
    expect(acc.closing_balance).toBe(4000)
  })

  it('rounds amounts to öre', async () => {
    mockResults = {
      fiscal_periods: [
        { data: { period_start: '2024-01-01', period_end: '2024-12-31', opening_balance_entry_id: null }, error: null },
      ],
      journal_entries: [
        {
          data: [
            { id: 'e1', entry_date: '2024-01-15', voucher_number: 1, voucher_series: 'A', description: 'Precision', source_type: 'manual' },
          ],
          error: null,
        },
      ],
      journal_entry_lines: [
        {
          data: [
            { account_number: '1930', debit_amount: 33.33, credit_amount: 0, journal_entry_id: 'e1' },
          ],
          error: null,
        },
      ],
      chart_of_accounts: [
        { data: [{ account_number: '1930', account_name: 'Företagskonto' }], error: null },
      ],
    }

    const report = await generateGeneralLedger(supabase, 'company-1', 'period-1')
    const acc = report.accounts[0]
    expect(acc.total_debit).toBe(33.33)
    expect(acc.closing_balance).toBe(33.33)
  })
})

describe('generateGeneralLedgerOverview', () => {
  const PERIOD = { period_start: '2026-01-01', period_end: '2026-12-31', opening_balance_entry_id: null }

  function overviewMocks(counts: Array<{ account_number: string; line_count: number }>) {
    mockResults = {
      fiscal_periods: [{ data: PERIOD, error: null }],
      'rpc:compute_prior_opening_balances': [
        { data: [{ account_number: '1930', debit: 10000, credit: 0 }, { account_number: '2440', debit: 0, credit: 300 }], error: null },
      ],
      'rpc:get_trial_balance_aggregates': [
        {
          data: [
            { bucket: 'rollforward', account_number: '1930', debit: 0, credit: 2000 },
            { bucket: 'period', account_number: '1930', debit: 500, credit: 120.5 },
            { bucket: 'period', account_number: '5010', debit: 4000, credit: 0 },
          ],
          error: null,
        },
      ],
      'rpc:get_ledger_line_counts': [{ data: counts, error: null }],
      chart_of_accounts: [
        { data: [{ account_number: '1930', account_name: 'Företagskonto' }, { account_number: '5010', account_name: 'Lokalhyra' }], error: null },
      ],
      journal_entries: [
        {
          data: [
            { id: 'e1', entry_date: '2026-06-10', voucher_number: 4, voucher_series: 'A', description: 'Insättning', source_type: 'manual' },
            { id: 'e2', entry_date: '2026-06-12', voucher_number: 5, voucher_series: 'A', description: 'Hyra', source_type: 'manual' },
          ],
          error: null,
        },
      ],
      journal_entry_lines: [
        {
          data: [
            { account_number: '1930', debit_amount: 500, credit_amount: 0, journal_entry_id: 'e1' },
            { account_number: '1930', debit_amount: 0, credit_amount: 120.5, journal_entry_id: 'e2' },
            { account_number: '5010', debit_amount: 4000, credit_amount: 0, journal_entry_id: 'e2' },
          ],
          error: null,
        },
      ],
    }
  }

  it('opens each account at its IB plus the movement before the window, and closes it after the window', async () => {
    overviewMocks([{ account_number: '1930', line_count: 2 }, { account_number: '5010', line_count: 1 }])
    const overview = await generateGeneralLedgerOverview(supabase, 'company-1', 'period-1', undefined, undefined, {
      fromDate: '2026-06-01',
      toDate: '2026-06-30',
    })

    expect(supabase.rpc).toHaveBeenCalledWith('get_trial_balance_aggregates', expect.objectContaining({
      p_closing_mode: 'include', p_from_date: '2026-06-01', p_to_date: '2026-06-30', p_exclude_entry_id: null,
    }))
    expect(overview.period).toEqual({ start: '2026-06-01', end: '2026-06-30' })
    expect(overview.lines_included).toBe(true)
    expect(overview.accounts.map((a) => ({ ...a, lines: a.lines?.map((l) => [l.description, l.balance]) }))).toEqual([
      {
        account_number: '1930', account_name: 'Företagskonto', opening_balance: 8000, closing_balance: 8379.5,
        total_debit: 500, total_credit: 120.5, line_count: 2,
        lines: [['Insättning', 8500], ['Hyra', 8379.5]],
      },
      // An account that only carries a balance into the window is listed, with no lines.
      {
        account_number: '2440', account_name: 'Konto 2440', opening_balance: -300, closing_balance: -300,
        total_debit: 0, total_credit: 0, line_count: 0, lines: [],
      },
      {
        account_number: '5010', account_name: 'Lokalhyra', opening_balance: 0, closing_balance: 4000,
        total_debit: 4000, total_credit: 0, line_count: 1, lines: [['Hyra', 4000]],
      },
    ])
  })

  it('leaves the lines out when the accounts in range have more than the inline limit', async () => {
    overviewMocks([{ account_number: '1930', line_count: GENERAL_LEDGER_INLINE_LINES }, { account_number: '5010', line_count: 1 }])
    const overview = await generateGeneralLedgerOverview(supabase, 'company-1', 'period-1')

    expect(overview.lines_included).toBe(false)
    expect(overview.accounts.every((a) => a.lines === undefined)).toBe(true)
    expect(supabase.rpc).not.toHaveBeenCalledWith('get_general_ledger_lines', expect.anything())
  })

  it('counts only the accounts in range against the inline limit', async () => {
    overviewMocks([{ account_number: '1930', line_count: 2 }, { account_number: '5010', line_count: GENERAL_LEDGER_INLINE_LINES }])
    const overview = await generateGeneralLedgerOverview(supabase, 'company-1', 'period-1', '1000', '1999')

    expect(overview.accounts.map((a) => a.account_number)).toEqual(['1930'])
    expect(overview.lines_included).toBe(true)
    expect(supabase.rpc).toHaveBeenCalledWith('get_general_ledger_lines', expect.objectContaining({
      p_account_from: '1000', p_account_to: '1999',
    }))
  })

  it('returns an empty overview without a period', async () => {
    mockResults = { fiscal_periods: [{ data: null, error: null }] }
    const overview = await generateGeneralLedgerOverview(supabase, 'company-1', 'period-1')
    expect(overview).toEqual({ accounts: [], period: { start: '', end: '' }, lines_included: true })
  })

  it('throws when the movements cannot be read', async () => {
    overviewMocks([])
    mockResults['rpc:get_trial_balance_aggregates'] = [{ data: null, error: { code: '57014', message: 'timeout' } }]
    await expect(generateGeneralLedgerOverview(supabase, 'company-1', 'period-1')).rejects.toThrow(/get_trial_balance_aggregates/)
  })
})

describe('generateGeneralLedgerAccountPage', () => {
  const PERIOD = { period_start: '2026-01-01', period_end: '2026-12-31', opening_balance_entry_id: null }

  function pageRow(i: number, debit: number, credit: number) {
    return {
      line_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      account_number: '1930',
      debit_amount: debit,
      credit_amount: credit,
      dimensions: {},
      journal_entry_id: `e${i}`,
      entry_date: '2026-06-10',
      voucher_series: 'A',
      voucher_number: 10 + i,
      description: `Rad ${i}`,
      source_type: 'manual',
    }
  }

  it('continues the running balance from the IB and every line before the page', async () => {
    mockResults = {
      fiscal_periods: [{ data: PERIOD, error: null }],
      'rpc:compute_prior_opening_balances': [{ data: [{ account_number: '1930', debit: 10000, credit: 0 }], error: null }],
      'rpc:get_general_ledger_account_page': [
        { data: { before_debit: 700, before_credit: 2200.25, lines: [pageRow(1, 100, 0), pageRow(2, 0, 50.5)] }, error: null },
      ],
    }
    const page = await generateGeneralLedgerAccountPage(supabase, 'company-1', 'period-1', '1930', {
      after: { date: '2026-06-09', voucher_number: 9, line_id: '00000000-0000-4000-8000-000000000009' },
      limit: 2,
    })

    expect(supabase.rpc).toHaveBeenCalledWith('get_general_ledger_account_page', expect.objectContaining({
      p_account_number: '1930', p_exclude_entry_id: null,
      p_after_date: '2026-06-09', p_after_voucher: 9, p_after_line_id: '00000000-0000-4000-8000-000000000009', p_limit: 2,
    }))
    // 10000 + 700 - 2200.25 = 8499.75, then +100 and -50.5.
    expect(page.lines.map((l) => [l.voucher_number, l.debit, l.credit, l.balance])).toEqual([[11, 100, 0, 8599.75], [12, 0, 50.5, 8549.25]])
    // A full page: the next one starts after its last line.
    expect(page.next).toEqual({ date: '2026-06-10', voucher_number: 12, line_id: '00000000-0000-4000-8000-000000000002' })
  })

  it('ends the account on a short page', async () => {
    mockResults = {
      fiscal_periods: [{ data: PERIOD, error: null }],
      'rpc:get_general_ledger_account_page': [{ data: { before_debit: 0, before_credit: 0, lines: [pageRow(1, 100, 0)] }, error: null }],
    }
    const page = await generateGeneralLedgerAccountPage(supabase, 'company-1', 'period-1', '1930')
    expect(page.lines).toHaveLength(1)
    expect(page.lines[0].balance).toBe(100)
    expect(page.next).toBeNull()
  })

  it('throws when the page cannot be read', async () => {
    mockResults = {
      fiscal_periods: [{ data: PERIOD, error: null }],
      'rpc:get_general_ledger_account_page': [{ data: null, error: { code: '57014', message: 'timeout' } }],
    }
    await expect(generateGeneralLedgerAccountPage(supabase, 'company-1', 'period-1', '1930')).rejects.toThrow(/get_general_ledger_account_page/)
  })
})
