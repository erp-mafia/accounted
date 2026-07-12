import { describe, it, expect, vi, beforeEach } from 'vitest'

// ============================================================
// Mock: table-keyed result queues
//
// The report fetches lines via the two-step entry-lines helper
// (lib/bookkeeping/entry-lines.ts): journal_entries first, then
// journal_entry_lines by entry id, reattaching the parent entry on each line
// under `journal_entries`. Tests queue entry rows (with the entry fields the
// report reads) and line rows that reference them via journal_entry_id.
// ============================================================

type MockResult = { data?: unknown; error?: unknown }
let mockResults: Record<string, MockResult[]>

function makeBuilder(tableName: string) {
  const b: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in', 'lt', 'neq', 'order', 'range']) {
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

import { generateGeneralLedger } from '../general-ledger'

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

  it('does not double a balance when an unstable page boundary re-serves a line (#790/#791)', async () => {
    // Reproduces the doubling bug's mechanism: a paginated LINE query whose
    // order was not stable can return the same journal_entry_line on two
    // pages. Page 1 must be a FULL page (PAGE_SIZE rows) so fetchAllRows
    // fetches a second page; page 2 re-serves the 5010 line. dedupeBy(line id)
    // must collapse it so the single 4000 posting totals 4000, not 8000.
    const PAGE_SIZE = 1000
    const filler = Array.from({ length: PAGE_SIZE - 1 }, (_, i) => ({
      id: `f${i}`,
      account_number: '1930',
      debit_amount: 0,
      credit_amount: 0,
      journal_entry_id: 'e1',
    }))
    const rentLine = {
      id: 'rent-line-1',
      account_number: '5010',
      debit_amount: 4000,
      credit_amount: 0,
      journal_entry_id: 'e2',
    }

    mockResults = {
      fiscal_periods: [
        { data: { period_start: '2024-01-01', period_end: '2024-12-31', opening_balance_entry_id: null }, error: null },
      ],
      journal_entries: [
        {
          data: [
            { id: 'e1', entry_date: '2024-01-02', voucher_number: 1, voucher_series: 'A', description: 'filler', source_type: 'manual' },
            { id: 'e2', entry_date: '2024-01-15', voucher_number: 2, voucher_series: 'A', description: 'Lokalhyra', source_type: 'manual' },
          ],
          error: null,
        },
      ],
      journal_entry_lines: [
        { data: [...filler, rentLine], error: null }, // page 1: full → triggers page 2
        { data: [rentLine], error: null },            // page 2: duplicate of the 5010 line
      ],
      chart_of_accounts: [
        {
          data: [
            { account_number: '1930', account_name: 'Företagskonto' },
            { account_number: '5010', account_name: 'Lokalhyra' },
          ],
          error: null,
        },
      ],
    }

    const report = await generateGeneralLedger(supabase, 'company-1', 'period-1')

    const acc5010 = report.accounts.find((a) => a.account_number === '5010')!
    expect(acc5010.total_debit).toBe(4000) // not 8000
    expect(acc5010.lines).toHaveLength(1) // verifikat listed once, not twice
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

  it('uses Math.round for monetary precision', async () => {
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
