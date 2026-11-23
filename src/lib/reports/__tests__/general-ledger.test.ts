import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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

type MockResult = { data?: unknown; error?: unknown; count?: number }
let mockResults: Record<string, MockResult[]>

function consume(key: string): MockResult {
  const queue = mockResults[key]
  if (!queue || queue.length === 0) return { data: null, error: null }
  return queue.shift()!
}

function makeBuilder(tableName: string) {
  const b: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in', 'lt', 'neq', 'order', 'range', 'contains', 'limit']) {
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
  generateGeneralLedgerArrangedPage,
  generateGeneralLedgerOverview,
  GENERAL_LEDGER_INLINE_LINES,
  LEDGER_READ_LIMITS,
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

describe('generateGeneralLedger over the single-read limit', () => {
  // The lines as the ledger RPCs return them. Same day and number in two
  // series on 1930 (rows 3 and 4), so line id decides their order.
  const lineId = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
  type Row = {
    line_id: string; account_number: string; debit_amount: number; credit_amount: number
    dimensions: Record<string, string>; journal_entry_id: string; entry_date: string
    voucher_series: string; voucher_number: number; description: string; source_type: string
  }
  const row = (i: number, account: string, date: string, series: string, voucher: number, debit: number, credit: number): Row => ({
    line_id: lineId(i), account_number: account, debit_amount: debit, credit_amount: credit,
    dimensions: i % 2 === 0 ? { '6': 'P1' } : {}, journal_entry_id: `e${voucher}${series}`, entry_date: date,
    voucher_series: series, voucher_number: voucher, description: `Ver ${series}${voucher}`, source_type: 'manual',
  })
  const BASE: Row[] = [
    row(1, '1510', '2026-01-10', 'A', 1, 1000, 0),
    row(2, '1930', '2026-01-10', 'A', 1, 0, 1000),
    row(3, '1930', '2026-02-01', 'A', 2, 250.5, 0),
    row(4, '1930', '2026-02-01', 'B', 2, 0, 99.99),
    row(5, '1930', '2026-03-05', 'A', 3, 10, 0),
    row(6, '3001', '2026-02-01', 'A', 2, 0, 250.5),
    row(7, '1930', '2026-04-01', 'A', 4, 0.01, 0),
    row(8, '2440', '2026-02-01', 'B', 2, 99.99, 0),
    row(9, '1930', '2026-05-01', 'A', 5, 0, 5),
  ]
  /** The ledger as the database holds it now; a test books into it to play a write during the read. */
  let ROWS: Row[] = []
  const compare = (a: Row, b: Row) =>
    a.account_number.localeCompare(b.account_number) || a.entry_date.localeCompare(b.entry_date) ||
    a.voucher_number - b.voucher_number || a.line_id.localeCompare(b.line_id)
  /** The rows in the call's window and under its filter (jsonb @>). */
  const scoped = (args: Record<string, unknown>) => ROWS.filter((r) =>
    !(args.p_from_date && r.entry_date < (args.p_from_date as string)) &&
    !(args.p_to_date && r.entry_date > (args.p_to_date as string)) &&
    Object.entries((args.p_dimensions ?? {}) as Record<string, string>).every(([k, v]) => r.dimensions[k] === v))
  const perAccount = (rows: Row[]) => {
    const byAccount = new Map<string, { n: number; debit: number; credit: number }>()
    for (const r of rows) {
      const a = byAccount.get(r.account_number) ?? { n: 0, debit: 0, credit: 0 }
      byAccount.set(r.account_number, { n: a.n + 1, debit: a.debit + r.debit_amount, credit: a.credit + r.credit_amount })
    }
    return [...byAccount].sort(([a], [b]) => a.localeCompare(b))
  }

  // Answers the ledger RPCs the way the SQL does (pinned by
  // tests/pg/ledger-account-days.pg.test.ts): the counts and the trial
  // balance per account, the single call every line in report order, a page
  // call one account's lines after the cursor.
  function ledgerRpc(fn: string, args: Record<string, unknown>) {
    if (fn === 'get_ledger_line_counts') {
      return { data: perAccount(scoped(args)).map(([account_number, a]) => ({ account_number, line_count: a.n })), error: null }
    }
    if (fn === 'get_trial_balance_aggregates') {
      return {
        data: perAccount(scoped(args)).map(([account_number, a]) => ({ bucket: 'period', account_number, debit: a.debit, credit: a.credit })),
        error: null,
      }
    }
    if (fn === 'get_general_ledger_lines') {
      const inRange = (r: Row) =>
        !(args.p_account_from && r.account_number < (args.p_account_from as string)) &&
        !(args.p_account_to && r.account_number > (args.p_account_to as string))
      return { data: scoped(args).filter(inRange).sort(compare), error: null }
    }
    if (fn === 'get_general_ledger_account_page') {
      const after = args.p_after_date
        ? [args.p_after_date as string, args.p_after_voucher as number, args.p_after_line_id as string] as const
        : null
      const lines = scoped(args)
        .filter((r) => r.account_number === args.p_account_number)
        .sort(compare)
        .filter((r) => !after || compare(r, { ...r, entry_date: after[0], voucher_number: after[1], line_id: after[2] }) > 0)
        .slice(0, args.p_limit as number)
      return { data: { before_debit: 0, before_credit: 0, lines }, error: null }
    }
    return { data: [], error: null }
  }

  function ledgerMocks() {
    ROWS = [...BASE]
    mockResults = {
      fiscal_periods: [
        { data: { period_start: '2026-01-01', period_end: '2026-12-31', opening_balance_entry_id: null }, error: null },
        { data: { period_start: '2026-01-01', period_end: '2026-12-31', opening_balance_entry_id: null }, error: null },
      ],
      chart_of_accounts: [
        { data: [{ account_number: '1930', account_name: 'Företagskonto' }], error: null },
        { data: [{ account_number: '1930', account_name: 'Företagskonto' }], error: null },
      ],
    }
    supabase.rpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => ledgerRpc(fn, args))
  }

  const pageCalls = () =>
    (supabase.rpc.mock.calls as Array<[string, Record<string, unknown>]>).filter(([fn]) => fn === 'get_general_ledger_account_page')

  it('reads a ledger over the limit account by account, a page at a time, into the report one call gives', async () => {
    ledgerMocks()
    const once = await generateGeneralLedger(supabase, 'company-1', 'period-1', undefined, undefined, {
      readLimits: { singleRead: ROWS.length, page: 2 },
    })
    expect(pageCalls()).toHaveLength(0)

    const paged = await generateGeneralLedger(supabase, 'company-1', 'period-1', undefined, undefined, {
      readLimits: { singleRead: ROWS.length - 1, page: 2 },
    })
    expect(JSON.stringify(paged)).toBe(JSON.stringify(once))
    expect(once.accounts.find((a) => a.account_number === '1930')!.lines.map((l) => l.voucher_series + l.voucher_number))
      .toEqual(['A1', 'A2', 'B2', 'A3', 'A4', 'A5'])

    // 1930's six lines in pages of two: the third page is full, so a fourth
    // (empty) one ends the account; each page starts after the last line.
    const on1930 = pageCalls().filter(([, a]) => a.p_account_number === '1930').map(([, a]) => [a.p_after_date, a.p_after_voucher, a.p_after_line_id, a.p_limit])
    expect(on1930).toEqual([
      [null, null, null, 2],
      ['2026-02-01', 2, lineId(3), 2],
      ['2026-03-05', 3, lineId(5), 2],
      ['2026-05-01', 5, lineId(9), 2],
    ])
    expect(new Set(pageCalls().map(([, a]) => a.p_account_number))).toEqual(new Set(['1510', '1930', '2440', '3001']))
  })

  it('reads and counts only the accounts in the range', async () => {
    ledgerMocks()
    // 1930 alone holds six lines: within a limit of six, one call for the range.
    await generateGeneralLedger(supabase, 'company-1', 'period-1', '1900', '1999', { readLimits: { singleRead: 6, page: 2 } })
    expect(pageCalls()).toHaveLength(0)
    expect(supabase.rpc).toHaveBeenCalledWith('get_general_ledger_lines', expect.objectContaining({ p_account_from: '1900', p_account_to: '1999' }))

    const paged = await generateGeneralLedger(supabase, 'company-1', 'period-1', '1900', '1999', { readLimits: { singleRead: 5, page: 2 } })
    expect(new Set(pageCalls().map(([, a]) => a.p_account_number))).toEqual(new Set(['1930']))
    expect(paged.accounts.map((a) => a.account_number)).toEqual(['1930'])
  })

  it('counts without the dimension filter and reads the pages under it, in the window', async () => {
    ledgerMocks()
    await generateGeneralLedger(supabase, 'company-1', 'period-1', undefined, undefined, {
      dimensions: { '6': 'P1' },
      fromDate: '2026-02-01',
      toDate: '2026-04-30',
      readLimits: { singleRead: 0, page: 2 },
    })
    expect(supabase.rpc).toHaveBeenCalledWith('get_ledger_line_counts', expect.objectContaining({
      p_from_date: null, p_to_date: '2026-04-30', p_dimensions: null,
    }))
    expect(pageCalls().length).toBeGreaterThan(0)
    for (const [, args] of pageCalls()) {
      // Lines before the window still roll into the opening balance: read from the period start.
      expect(args).toMatchObject({ p_from_date: null, p_to_date: '2026-04-30', p_dimensions: { '6': 'P1' } })
    }
  })

  it('never asks a page for more lines than the call returns', async () => {
    ledgerMocks()
    await generateGeneralLedger(supabase, 'company-1', 'period-1', undefined, undefined, {
      readLimits: { singleRead: 0, page: 100_000 },
    })
    expect(new Set(pageCalls().map(([, a]) => a.p_limit))).toEqual(new Set([5000]))
  })

  it('throws when a page cannot be read', async () => {
    ledgerMocks()
    supabase.rpc.mockImplementation(async (fn: string, args: Record<string, unknown>) =>
      fn === 'get_general_ledger_account_page' && args.p_account_number === '3001'
        ? { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }
        : ledgerRpc(fn, args))
    await expect(generateGeneralLedger(supabase, 'company-1', 'period-1', undefined, undefined, {
      readLimits: { singleRead: 0, page: 2 },
    })).rejects.toThrow(/get_general_ledger_account_page/)
  })

  it('throws when the lines cannot be counted', async () => {
    ledgerMocks()
    supabase.rpc.mockImplementation(async (fn: string, args: Record<string, unknown>) =>
      fn === 'get_ledger_line_counts'
        ? { data: null, error: { code: '57014', message: 'timeout' } }
        : ledgerRpc(fn, args))
    await expect(generateGeneralLedger(supabase, 'company-1', 'period-1')).rejects.toThrow(/get_ledger_line_counts/)
  })

  // Pages are separate statements: a verifikat booked between them can land
  // in some accounts' pages and not in others'. Played here by booking one
  // (1930 and 3001) once 1930 has been read and before 3001 is.
  function bookDuringTheRead(times: number) {
    let booked = 0
    supabase.rpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
      if (fn === 'get_general_ledger_account_page' && args.p_account_number === '3001' && !args.p_after_date && booked < times) {
        booked++
        const voucher = 10 + booked
        ROWS.push(row(100 + 2 * booked, '1930', '2026-06-01', 'A', voucher, 40, 0), row(101 + 2 * booked, '3001', '2026-06-01', 'A', voucher, 0, 40))
      }
      return ledgerRpc(fn, args)
    })
  }

  it('reads again when the ledger changes under the pages, and gives the ledger as it then stands', async () => {
    ledgerMocks()
    bookDuringTheRead(1)
    const paged = await generateGeneralLedger(supabase, 'company-1', 'period-1', undefined, undefined, {
      readLimits: { singleRead: 0, page: 2 },
    })
    // The first read had the new verifikat on 3001 but not on 1930; the
    // check saw it and the second read has it on both.
    const lines = (account: string) => paged.accounts.find((a) => a.account_number === account)!.lines.map((l) => l.voucher_number)
    expect(lines('1930')).toContain(11)
    expect(lines('3001')).toContain(11)
    expect((supabase.rpc.mock.calls as Array<[string]>).filter(([fn]) => fn === 'get_trial_balance_aggregates')).toHaveLength(2)
    // The report one call gives of the ledger as it now stands.
    const once = await generateGeneralLedger(supabase, 'company-1', 'period-1', undefined, undefined, {
      readLimits: { singleRead: 1000, page: 2 },
    })
    expect(JSON.stringify(paged)).toBe(JSON.stringify(once))
  })

  it('answers a retryable conflict when the ledger changes under both reads', async () => {
    ledgerMocks()
    bookDuringTheRead(2)
    const failure = await generateGeneralLedger(supabase, 'company-1', 'period-1', undefined, undefined, {
      readLimits: { singleRead: 0, page: 2 },
    }).catch((err: unknown) => err)
    expect(failure).toMatchObject({ code: '40001' })
  })

  /** The period's verifikat as the marks read them: how many, and the last write. One per read of the marks. */
  function entryMarks(...marks: Array<[number, string]>) {
    mockResults.journal_entries = marks.map(([count, at]) => ({ count, data: [{ updated_at: at }] }))
  }

  it('checks one dimension value against the summaries, and two by the marks alone', async () => {
    ledgerMocks()
    await generateGeneralLedger(supabase, 'company-1', 'period-1', undefined, undefined, {
      dimensions: { '6': 'P1' }, readLimits: { singleRead: 0, page: 2 },
    })
    expect(supabase.rpc).toHaveBeenCalledWith('get_trial_balance_aggregates', expect.objectContaining({
      p_closing_mode: 'include', p_from_date: null, p_to_date: null, p_dimensions: { '6': 'P1' },
    }))

    // Under two values the summaries cannot answer: a verifikat booked during
    // the first read shows in the marks, and the ledger is read again.
    ledgerMocks()
    supabase.rpc.mockClear()
    entryMarks([9, '2026-11-23T10:00:00Z'], [10, '2026-11-23T10:00:04Z'], [10, '2026-11-23T10:00:04Z'], [10, '2026-11-23T10:00:04Z'])
    await generateGeneralLedger(supabase, 'company-1', 'period-1', undefined, undefined, {
      dimensions: { '1': 'KS01', '6': 'P1' }, readLimits: { singleRead: 0, page: 2 },
    })
    const calls = supabase.rpc.mock.calls as Array<[string, Record<string, unknown>]>
    expect(calls.filter(([fn]) => fn === 'get_trial_balance_aggregates')).toHaveLength(0)
    const onePass = new Set(pageCalls().map(([, a]) => `${a.p_account_number} ${a.p_after_line_id}`)).size
    expect(pageCalls()).toHaveLength(2 * onePass)
  })

  it('reads the accounts as they stand once the marks are read, not as first counted', async () => {
    ledgerMocks()
    // A verifikat on a new account lands right after the first count; the
    // marks read after it already include it, so its account must be read too.
    let counts = 0
    supabase.rpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
      const answer = ledgerRpc(fn, args)
      if (fn === 'get_ledger_line_counts' && ++counts === 1) {
        const tags = { '1': 'KS01', '6': 'P1' }
        ROWS.push({ ...row(200, '2610', '2026-07-01', 'A', 20, 0, 25), dimensions: tags }, { ...row(201, '1510', '2026-07-01', 'A', 20, 25, 0), dimensions: tags })
      }
      return answer
    })
    const paged = await generateGeneralLedger(supabase, 'company-1', 'period-1', undefined, undefined, {
      dimensions: { '1': 'KS01', '6': 'P1' }, readLimits: { singleRead: 0, page: 2 },
    })
    expect(paged.accounts.map((a) => a.account_number)).toContain('2610')
  })

  it('marks the posted and reversed verifikat only: a draft is not the ledger', async () => {
    ledgerMocks()
    await generateGeneralLedger(supabase, 'company-1', 'period-1', undefined, undefined, { readLimits: { singleRead: 0, page: 2 } })
    const from = supabase.from.mock as { calls: Array<[string]>; results: Array<{ value: { in: { mock: { calls: unknown[][] } } } }> }
    const marked = from.calls.flatMap(([table], i) => (table === 'journal_entries' ? [from.results[i].value] : []))
    expect(marked.length).toBeGreaterThan(0)
    for (const builder of marked) expect(builder.in.mock.calls).toContainEqual(['status', ['posted', 'reversed']])
  })

  it('reads again when a verifikat is deleted and booked again the same during the read', async () => {
    ledgerMocks()
    // As many verifikat and the same totals after, but a later write.
    entryMarks([9, '2026-11-23T10:00:00Z'], [9, '2026-11-23T10:00:07Z'], [9, '2026-11-23T10:00:07Z'], [9, '2026-11-23T10:00:07Z'])
    await generateGeneralLedger(supabase, 'company-1', 'period-1', undefined, undefined, {
      readLimits: { singleRead: 0, page: 2 },
    })
    const onePass = new Set(pageCalls().map(([, a]) => `${a.p_account_number} ${a.p_after_line_id}`)).size
    expect(pageCalls()).toHaveLength(2 * onePass)
  })

  it('stops an account whose page does not move past the one before', async () => {
    ledgerMocks()
    supabase.rpc.mockImplementation(async (fn: string, args: Record<string, unknown>) =>
      // 1930 answers its first page again for every page after it.
      fn === 'get_general_ledger_account_page' && args.p_account_number === '1930'
        ? ledgerRpc(fn, { ...args, p_after_date: null, p_after_voucher: null, p_after_line_id: null })
        : ledgerRpc(fn, args))
    await expect(generateGeneralLedger(supabase, 'company-1', 'period-1', undefined, undefined, {
      readLimits: { singleRead: 0, page: 2 },
    })).rejects.toThrow(/did not move past/)
    // The second page is the first again: stopped there.
    expect(pageCalls().filter(([, a]) => a.p_account_number === '1930')).toHaveLength(2)
  })

  it('reads again when a line is retagged or corrected during the read', async () => {
    for (const log of ['dimension_retag_log', 'journal_entry_rattelse_log']) {
      ledgerMocks()
      supabase.rpc.mockClear()
      // Counted before and after each read: one retag or rättelse lands during the first.
      mockResults[log] = [{ count: 3 }, { count: 4 }, { count: 4 }, { count: 4 }]
      const paged = await generateGeneralLedger(supabase, 'company-1', 'period-1', undefined, undefined, {
        readLimits: { singleRead: 0, page: 2 },
      })
      const onePass = new Set(pageCalls().map(([, a]) => `${a.p_account_number} ${a.p_after_line_id}`)).size
      expect(pageCalls(), log).toHaveLength(2 * onePass)
      const once = await generateGeneralLedger(supabase, 'company-1', 'period-1', undefined, undefined, {
        readLimits: { singleRead: 1000, page: 2 },
      })
      expect(JSON.stringify(paged), log).toBe(JSON.stringify(once))
    }
  })

  it('stops the accounts beside a failed one at their next page', async () => {
    ledgerMocks()
    supabase.rpc.mockImplementation(async (fn: string, args: Record<string, unknown>) =>
      fn === 'get_general_ledger_account_page' && args.p_account_number === '2440'
        ? { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }
        : ledgerRpc(fn, args))
    await expect(generateGeneralLedger(supabase, 'company-1', 'period-1', undefined, undefined, {
      readLimits: { singleRead: 0, page: 1 },
    })).rejects.toThrow(/get_general_ledger_account_page/)
    // 1930 is read beside 2440 and has six lines: read to its end it takes seven calls.
    expect(pageCalls().filter(([, a]) => a.p_account_number === '1930').length).toBeLessThan(7)
    expect(pageCalls().filter(([, a]) => a.p_account_number === '3001')).toHaveLength(0)
  })

  it('pages no larger than the page call returns, as its newest definition caps it', () => {
    // A page shorter than asked for ends an account, so the cap must not fall below the page size.
    const dir = resolve(__dirname, '../../../../supabase/migrations')
    let cap: number | null = null
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      const sql = readFileSync(resolve(dir, file), 'utf8')
      const at = sql.search(/CREATE (?:OR REPLACE )?FUNCTION public\.get_general_ledger_account_page\(/)
      if (at < 0) continue
      const limit = /least\(greatest\(coalesce\(p_limit, \d+\), 1\), (\d+)\)/.exec(sql.slice(at))
      cap = limit ? Number(limit[1]) : null
    }
    expect(cap).not.toBeNull()
    expect(cap!).toBeGreaterThanOrEqual(LEDGER_READ_LIMITS.page)
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

describe('generateGeneralLedgerArrangedPage', () => {
  const PERIOD = { period_start: '2026-01-01', period_end: '2026-12-31', opening_balance_entry_id: null }
  const lineId = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`

  function ledgerRow(i: number, date: string, voucher: number, description: string, debit: number, credit: number) {
    return {
      line_id: lineId(i),
      account_number: '1930',
      debit_amount: debit,
      credit_amount: credit,
      dimensions: {},
      journal_entry_id: `e${i}`,
      entry_date: date,
      voucher_series: 'A',
      voucher_number: voucher,
      description,
      source_type: 'manual',
    }
  }

  // The account in ledger order. IB 10 000.
  const ROWS = [
    ledgerRow(1, '2026-01-05', 3, 'Kundbetalning', 12500, 0),
    ledgerRow(2, '2026-01-20', 4, 'Hyra januari', 0, 8000),
    ledgerRow(3, '2026-02-01', 7, 'Bankavgift', 0, 45.5),
    ledgerRow(4, '2026-03-15', 9, 'Hyra mars', 0, 8000),
  ]
  const BALANCES = [22500, 14500, 14454.5, 6454.5]

  /** Every read of the account answers `pages` in turn (one RPC page each). */
  function accountMocks(pages: Array<{ before_debit?: number; before_credit?: number; lines: unknown[] }>) {
    mockResults = {
      fiscal_periods: pages.map(() => ({ data: PERIOD, error: null })),
      'rpc:compute_prior_opening_balances': pages.map(() => ({
        data: [{ account_number: '1930', debit: 10000, credit: 0 }],
        error: null,
      })),
      'rpc:get_general_ledger_account_page': pages.map((page) => ({
        data: { before_debit: 0, before_credit: 0, ...page },
        error: null,
      })),
    }
  }

  it('in ledger order without a search it is the account page: the same lines and balances', async () => {
    accountMocks([{ lines: ROWS }])
    const paged = await generateGeneralLedgerAccountPage(supabase, 'company-1', 'period-1', '1930')
    accountMocks([{ lines: ROWS }])
    const arranged = await generateGeneralLedgerArrangedPage(supabase, 'company-1', 'period-1', '1930', {})

    expect(arranged.lines).toEqual(paged.lines)
    expect(arranged.lines.map((l) => l.balance)).toEqual(BALANCES)
    expect(arranged).toMatchObject({ line_count: 4, next_offset: null, matched: null })
  })

  it('reads the account in the window, under the filter, from its first line', async () => {
    accountMocks([{ lines: ROWS }])
    await generateGeneralLedgerArrangedPage(supabase, 'company-1', 'period-1', '1930', {
      dimensions: { '1': 'KS01' },
      fromDate: '2026-01-01',
      toDate: '2026-06-30',
      sort: { column: 'debit', ascending: false },
    })

    expect(supabase.rpc).toHaveBeenCalledWith('get_general_ledger_account_page', {
      p_company_id: 'company-1',
      p_fiscal_period_id: 'period-1',
      p_account_number: '1930',
      p_from_date: '2026-01-01',
      p_to_date: '2026-06-30',
      p_exclude_entry_id: null,
      p_dimensions: { '1': 'KS01' },
      p_after_date: null,
      p_after_voucher: null,
      p_after_line_id: null,
      p_limit: 5000,
    })
  })

  it('sorts newest first with each line still carrying the balance after it', async () => {
    accountMocks([{ lines: ROWS }])
    const page = await generateGeneralLedgerArrangedPage(supabase, 'company-1', 'period-1', '1930', {
      sort: { column: 'date', ascending: false },
    })

    expect(page.lines.map((l) => [l.voucher_number, l.balance])).toEqual([
      [9, 6454.5], [7, 14454.5], [4, 14500], [3, 22500],
    ])
    expect(page.matched).toBeNull()
  })

  it('narrows by a search and sums everything it found, keeping the ledger balances', async () => {
    accountMocks([{ lines: ROWS }])
    const page = await generateGeneralLedgerArrangedPage(supabase, 'company-1', 'period-1', '1930', {
      search: '8 000 kr',
    })

    expect(page.lines.map((l) => [l.voucher_number, l.credit, l.balance])).toEqual([[4, 8000, 14500], [9, 8000, 6454.5]])
    expect(page.line_count).toBe(2)
    expect(page.matched).toEqual({ debit: 0, credit: 16000 })
    expect(page.next_offset).toBeNull()
  })

  it('pages the arrangement by offset, with the count and the sums of all of it', async () => {
    accountMocks([{ lines: ROWS }])
    const first = await generateGeneralLedgerArrangedPage(supabase, 'company-1', 'period-1', '1930', {
      search: 'a', sort: { column: 'credit', ascending: false }, limit: 3,
    })
    expect(first.lines.map((l) => l.voucher_number)).toEqual([4, 9, 7])
    expect(first).toMatchObject({ line_count: 4, next_offset: 3, matched: { debit: 12500, credit: 16045.5 } })

    accountMocks([{ lines: ROWS }])
    const second = await generateGeneralLedgerArrangedPage(supabase, 'company-1', 'period-1', '1930', {
      search: 'a', sort: { column: 'credit', ascending: false }, limit: 3, offset: 3,
    })
    expect(second.lines.map((l) => l.voucher_number)).toEqual([3])
    expect(second).toMatchObject({ line_count: 4, next_offset: null, matched: { debit: 12500, credit: 16045.5 } })
  })

  it('reads a long account to its end, continuing the balance over the reads', async () => {
    // A full read of 5 000 lines says another follows; the short one ends it.
    const many = Array.from({ length: 5000 }, (_, i) => ledgerRow(i + 1, '2026-01-10', i + 1, `Rad ${i + 1}`, 1, 0))
    const tail = [ledgerRow(5001, '2026-02-01', 5001, 'Sista raden', 0, 250)]
    accountMocks([{ lines: many }, { before_debit: 5000, lines: tail }])
    const page = await generateGeneralLedgerArrangedPage(supabase, 'company-1', 'period-1', '1930', {
      sort: { column: 'date', ascending: false }, limit: 2,
    })

    expect(supabase.rpc).toHaveBeenCalledWith('get_general_ledger_account_page', expect.objectContaining({
      p_after_date: '2026-01-10', p_after_voucher: 5000, p_after_line_id: lineId(5000), p_limit: 5000,
    }))
    expect(page.line_count).toBe(5001)
    // 10 000 + 5 000 - 250, then the line before it.
    expect(page.lines.map((l) => [l.voucher_number, l.balance])).toEqual([[5001, 14750], [5000, 15000]])
    expect(page.next_offset).toBe(2)
  })

  it('throws when the account cannot be read', async () => {
    mockResults = {
      fiscal_periods: [{ data: PERIOD, error: null }],
      'rpc:get_general_ledger_account_page': [{ data: null, error: { code: '57014', message: 'timeout' } }],
    }
    await expect(
      generateGeneralLedgerArrangedPage(supabase, 'company-1', 'period-1', '1930', { search: 'hyra' }),
    ).rejects.toThrow(/get_general_ledger_account_page/)
  })
})
