import { describe, it, expect, vi, beforeEach } from 'vitest'

// ============================================================
// Mock: table-keyed result queues
//
// The report fetches lines via the two-step entry-lines helper
// (lib/bookkeeping/entry-lines.ts): journal_entries first, then
// journal_entry_lines by entry id, reattaching the parent entry on each line
// under `journal_entries`. Tests queue entry rows and line rows that
// reference them via journal_entry_id.
// ============================================================

type MockResult = { data?: unknown; error?: unknown }
let mockResults: Record<string, MockResult[]>

function makeBuilder(tableName: string) {
  const b: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in', 'neq', 'order', 'range']) {
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
  return {
    from: vi.fn().mockImplementation((table: string) => makeBuilder(table)),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

import { generateJournalRegister, generateJournalRegisterPage } from '../journal-register'

let supabase: ReturnType<typeof makeClient>

beforeEach(() => {
  vi.clearAllMocks()
  mockResults = {}
  supabase = makeClient()
})

describe('generateJournalRegister', () => {
  it('returns empty report when no fiscal period found', async () => {
    mockResults = {
      fiscal_periods: [{ data: null, error: null }],
    }

    const report = await generateJournalRegister(supabase, 'company-1', 'period-1')
    expect(report.entries).toEqual([])
    expect(report.total_entries).toBe(0)
    expect(report.period).toEqual({ start: '', end: '' })
  })

  it('returns empty report when no entries in period', async () => {
    mockResults = {
      fiscal_periods: [
        { data: { period_start: '2024-01-01', period_end: '2024-12-31' }, error: null },
      ],
      // No matching entries → the line query is skipped entirely.
      journal_entries: [{ data: [], error: null }],
    }

    const report = await generateJournalRegister(supabase, 'company-1', 'period-1')
    expect(report.entries).toEqual([])
    expect(report.total_entries).toBe(0)
    expect(report.period).toEqual({ start: '2024-01-01', end: '2024-12-31' })
  })

  it('does not double an entry when an unstable page boundary re-serves a line (#790/#793)', async () => {
    // Page 1 is a FULL page so fetchAllRows fetches page 2, which re-serves
    // the 5010 line of voucher 2. dedupeBy(line id) must collapse it so the
    // grundbok lists the voucher once with a 4000 (not 8000) total.
    const PAGE_SIZE = 1000
    const filler = Array.from({ length: PAGE_SIZE - 1 }, (_, i) => ({
      id: `f${i}`,
      account_number: '1930',
      debit_amount: 0,
      credit_amount: 0,
      journal_entry_id: 'e0',
    }))
    const rentLine = {
      id: 'rent-line-1',
      account_number: '5010',
      debit_amount: 4000,
      credit_amount: 0,
      journal_entry_id: 'e1',
    }

    mockResults = {
      fiscal_periods: [
        { data: { period_start: '2024-01-01', period_end: '2024-12-31' }, error: null },
      ],
      journal_entries: [
        {
          data: [
            { id: 'e0', entry_date: '2024-01-02', voucher_number: 1, voucher_series: 'A', description: 'filler', source_type: 'manual', status: 'posted' },
            { id: 'e1', entry_date: '2024-01-15', voucher_number: 2, voucher_series: 'A', description: 'Lokalhyra', source_type: 'manual', status: 'posted' },
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

    const report = await generateJournalRegister(supabase, 'company-1', 'period-1')

    const voucher2 = report.entries.find((e) => e.voucher_number === 2)!
    expect(voucher2.total_debit).toBe(4000) // not 8000
    expect(voucher2.lines).toHaveLength(1) // listed once, not twice
  })

  it('produces entries in registration order with correct totals', async () => {
    mockResults = {
      fiscal_periods: [
        { data: { period_start: '2024-01-01', period_end: '2024-12-31' }, error: null },
      ],
      journal_entries: [
        {
          data: [
            { id: 'e1', entry_date: '2024-01-15', voucher_number: 1, voucher_series: 'A', description: 'Sale invoice', source_type: 'invoice', status: 'posted' },
            { id: 'e2', entry_date: '2024-02-01', voucher_number: 2, voucher_series: 'A', description: 'Payment', source_type: 'transaction', status: 'posted' },
          ],
          error: null,
        },
      ],
      journal_entry_lines: [
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

    const report = await generateJournalRegister(supabase, 'company-1', 'period-1')

    expect(report.total_entries).toBe(2)
    expect(report.entries[0].voucher_number).toBe(1)
    expect(report.entries[1].voucher_number).toBe(2)

    // Entry 1: sale invoice
    expect(report.entries[0].total_debit).toBe(1250)
    expect(report.entries[0].total_credit).toBe(1250)
    expect(report.entries[0].lines).toHaveLength(3)

    // Lines sorted by account number
    expect(report.entries[0].lines[0].account_number).toBe('1510')
    expect(report.entries[0].lines[1].account_number).toBe('2611')
    expect(report.entries[0].lines[2].account_number).toBe('3001')

    // Grand totals
    expect(report.total_debit).toBe(2500)
    expect(report.total_credit).toBe(2500)
  })

  it('includes reversed entries with correct status', async () => {
    mockResults = {
      fiscal_periods: [
        { data: { period_start: '2024-01-01', period_end: '2024-12-31' }, error: null },
      ],
      journal_entries: [
        {
          data: [
            { id: 'e1', entry_date: '2024-01-15', voucher_number: 1, voucher_series: 'A', description: 'Original', source_type: 'manual', status: 'reversed' },
            { id: 'e2', entry_date: '2024-01-16', voucher_number: 2, voucher_series: 'A', description: 'Reversal', source_type: 'manual', status: 'posted' },
          ],
          error: null,
        },
      ],
      journal_entry_lines: [
        {
          data: [
            { account_number: '1930', debit_amount: 500, credit_amount: 0, journal_entry_id: 'e1' },
            { account_number: '5410', debit_amount: 0, credit_amount: 500, journal_entry_id: 'e1' },
            { account_number: '5410', debit_amount: 500, credit_amount: 0, journal_entry_id: 'e2' },
            { account_number: '1930', debit_amount: 0, credit_amount: 500, journal_entry_id: 'e2' },
          ],
          error: null,
        },
      ],
      chart_of_accounts: [
        { data: [], error: null },
      ],
    }

    const report = await generateJournalRegister(supabase, 'company-1', 'period-1')

    expect(report.entries[0].status).toBe('reversed')
    expect(report.entries[1].status).toBe('posted')
    expect(report.total_entries).toBe(2)
  })

  it('resolves account names from chart_of_accounts', async () => {
    mockResults = {
      fiscal_periods: [
        { data: { period_start: '2024-01-01', period_end: '2024-12-31' }, error: null },
      ],
      journal_entries: [
        {
          data: [
            { id: 'e1', entry_date: '2024-01-15', voucher_number: 1, voucher_series: 'A', description: 'Test', source_type: 'manual', status: 'posted' },
          ],
          error: null,
        },
      ],
      journal_entry_lines: [
        {
          data: [
            { account_number: '1930', debit_amount: 100, credit_amount: 0, journal_entry_id: 'e1' },
            { account_number: '9999', debit_amount: 0, credit_amount: 100, journal_entry_id: 'e1' },
          ],
          error: null,
        },
      ],
      chart_of_accounts: [
        {
          data: [
            { account_number: '1930', account_name: 'Företagskonto' },
          ],
          error: null,
        },
      ],
    }

    const report = await generateJournalRegister(supabase, 'company-1', 'period-1')

    const line1930 = report.entries[0].lines.find((l) => l.account_number === '1930')!
    expect(line1930.account_name).toBe('Företagskonto')

    // Unknown account gets fallback name
    const line9999 = report.entries[0].lines.find((l) => l.account_number === '9999')!
    expect(line9999.account_name).toBe('Konto 9999')
  })

  it('defaults voucher_series to A when null', async () => {
    mockResults = {
      fiscal_periods: [
        { data: { period_start: '2024-01-01', period_end: '2024-12-31' }, error: null },
      ],
      journal_entries: [
        {
          data: [
            { id: 'e1', entry_date: '2024-01-15', voucher_number: 1, voucher_series: null, description: 'No series', source_type: 'manual', status: 'posted' },
          ],
          error: null,
        },
      ],
      journal_entry_lines: [
        {
          data: [
            { account_number: '1930', debit_amount: 100, credit_amount: 0, journal_entry_id: 'e1' },
            { account_number: '3001', debit_amount: 0, credit_amount: 100, journal_entry_id: 'e1' },
          ],
          error: null,
        },
      ],
      chart_of_accounts: [
        { data: [], error: null },
      ],
    }

    const report = await generateJournalRegister(supabase, 'company-1', 'period-1')
    expect(report.entries[0].voucher_series).toBe('A')
  })
})

describe('generateJournalRegisterPage', () => {
  const ENTRY = '00000000-0000-4000-8000-0000000000'

  function pageRow(n: number, lines: Array<[string, number, number]>) {
    return {
      id: `${ENTRY}${String(n).padStart(2, '0')}`,
      voucher_series: 'A',
      voucher_number: n,
      entry_date: '2026-03-01',
      description: `Ver ${n}`,
      source_type: 'manual',
      status: n === 2 ? 'reversed' : 'posted',
      lines: lines.map(([account_number, debit_amount, credit_amount]) => ({ account_number, debit_amount, credit_amount })),
    }
  }

  function client(results: Record<string, { data: unknown; error: unknown }>) {
    const table = (name: string) => {
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'order', 'range']) b[m] = vi.fn().mockReturnValue(b)
      const result = name === 'chart_of_accounts'
        ? { data: [{ account_number: '1930', account_name: 'Företagskonto' }], error: null }
        : { data: { period_start: '2026-01-01', period_end: '2026-12-31' }, error: null }
      b.single = vi.fn().mockResolvedValue(result)
      b.then = (resolve: (v: unknown) => void) => resolve(result)
      return b
    }
    return {
      from: vi.fn().mockImplementation(table),
      rpc: vi.fn().mockImplementation(async (fn: string) => results[fn] ?? { data: null, error: null }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
  }

  it('reads one page in registration order, with the totals on the first page and a cursor when more follow', async () => {
    const supabase = client({
      get_journal_register_page: {
        data: [pageRow(1, [['1930', 100, 0], ['3001', 0, 100]]), pageRow(2, [['1930', 0, 33.33], ['5010', 33.33, 0]]), pageRow(3, [])],
        error: null,
      },
      get_journal_register_totals: { data: { total_entries: 3, total_debit: 133.33, total_credit: 133.33 }, error: null },
    })
    const page = await generateJournalRegisterPage(supabase, 'company-1', 'period-1', { limit: 2 })

    expect(supabase.rpc).toHaveBeenCalledWith('get_journal_register_page', {
      p_company_id: 'company-1', p_fiscal_period_id: 'period-1',
      p_after_series: null, p_after_number: null, p_after_id: null, p_limit: 3,
    })
    expect(page.entries).toEqual([
      {
        voucher_series: 'A', voucher_number: 1, date: '2026-03-01', description: 'Ver 1', source_type: 'manual', status: 'posted',
        lines: [
          { account_number: '1930', account_name: 'Företagskonto', debit: 100, credit: 0 },
          { account_number: '3001', account_name: 'Konto 3001', debit: 0, credit: 100 },
        ],
        total_debit: 100, total_credit: 100,
      },
      {
        voucher_series: 'A', voucher_number: 2, date: '2026-03-01', description: 'Ver 2', source_type: 'manual', status: 'reversed',
        lines: [
          { account_number: '1930', account_name: 'Företagskonto', debit: 0, credit: 33.33 },
          { account_number: '5010', account_name: 'Konto 5010', debit: 33.33, credit: 0 },
        ],
        total_debit: 33.33, total_credit: 33.33,
      },
    ])
    expect(page.next).toEqual({ voucher_series: 'A', voucher_number: 2, id: `${ENTRY}02` })
    expect(page.totals).toEqual({
      total_entries: 3, total_debit: 133.33, total_credit: 133.33, period: { start: '2026-01-01', end: '2026-12-31' },
    })
  })

  it('continues after a cursor without totals, and ends on a short page', async () => {
    const supabase = client({ get_journal_register_page: { data: [pageRow(3, [['1930', 1, 0]])], error: null } })
    const page = await generateJournalRegisterPage(supabase, 'company-1', 'period-1', {
      after: { voucher_series: 'A', voucher_number: 2, id: `${ENTRY}02` },
      limit: 2,
    })
    expect(supabase.rpc).not.toHaveBeenCalledWith('get_journal_register_totals', expect.anything())
    expect(page.totals).toBeUndefined()
    expect(page.next).toBeNull()
    expect(page.entries.map((e) => e.voucher_number)).toEqual([3])
  })

  it('throws when the page cannot be read', async () => {
    const supabase = client({ get_journal_register_page: { data: null, error: { code: '57014', message: 'timeout' } } })
    await expect(generateJournalRegisterPage(supabase, 'company-1', 'period-1')).rejects.toThrow(/get_journal_register_page/)
  })
})
