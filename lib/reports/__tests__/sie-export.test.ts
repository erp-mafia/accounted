import { describe, it, expect, vi, beforeEach } from 'vitest'

// ============================================================
// Mock — sequential result queue
// ============================================================

let resultIdx: number
let results: Array<{ data?: unknown; error?: unknown }>

function makeBuilder() {
  const b: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in', 'order', 'range', 'lt', 'lte', 'gte', 'gt', 'limit', 'neq']) {
    b[m] = vi.fn().mockReturnValue(b)
  }
  b.single = vi.fn().mockImplementation(async () => results[resultIdx++] ?? { data: null, error: null })
  b.then = (resolve: (v: unknown) => void) => resolve(results[resultIdx++] ?? { data: null, error: null })
  return b
}

function makeClient() {
  return {
    from: vi.fn().mockImplementation(() => makeBuilder()),
    // `rpc` drains the same queue so tests can intersperse RPC + table fetches.
    // SIE export calls `compute_prior_opening_balances` via getOpeningBalances
    // whenever `opening_balance_entry_id` is null (the multi-year-import path).
    rpc: vi.fn().mockImplementation(async () => results[resultIdx++] ?? { data: null, error: null }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

import { generateSIEExport } from '../sie-export'

let supabase: ReturnType<typeof makeClient>

beforeEach(() => {
  vi.clearAllMocks()
  resultIdx = 0
  results = []
  supabase = makeClient()
})

const baseOptions = {
  fiscal_period_id: 'period-1',
  company_name: 'Test AB',
  org_number: '556677-8899',
  program_name: 'ERPBase',
}

// Queue consumption order after the pagination fix:
//   0: fiscal_periods.single()
//   1: previous fiscal period .single() (#RAR -1)
//   2: chart_of_accounts        (fetchAllRows)
//   3: journal_entries          (fetchAllRows)
//   4: journal_entry_lines      (fetchAllRows)   ← split out from the entries query
//   5: cost_centers
//   6: projects
//   7: opening balances (RPC fallback or journal_entry_lines page)

describe('generateSIEExport', () => {
  it('throws when fiscal period not found', async () => {
    results = [
      // 0: fiscal_periods.single() → null
      { data: null, error: null },
    ]

    await expect(generateSIEExport(supabase, 'company-1', baseOptions))
      .rejects.toThrow('Fiscal period not found')
  })

  it('generates correct header format', async () => {
    results = [
      { data: { id: 'period-1', period_start: '2024-01-01', period_end: '2024-12-31' }, error: null },
      { data: null, error: null }, // prevPeriod
      { data: [], error: null }, // accounts
      { data: [], error: null }, // journal_entries
      { data: [], error: null }, // journal_entry_lines
      { data: [], error: null }, // cost_centers
      { data: [], error: null }, // projects
      { data: [], error: null }, // opening balances RPC
    ]

    const output = await generateSIEExport(supabase, 'company-1', baseOptions)
    const lines = output.split('\r\n')

    expect(lines[0]).toBe('#FLAGGA 0')
    expect(lines[1]).toBe('#FORMAT PC8')
    expect(lines[2]).toBe('#SIETYP 4')
    expect(lines[3]).toMatch(/^#PROGRAM "ERPBase" "1\.0"$/)
    expect(lines[4]).toMatch(/^#GEN \d{8}$/)
    expect(lines[5]).toBe('#ORGNR 556677-8899')
    expect(lines[6]).toBe('#FNAMN "Test AB"')
    expect(lines[7]).toBe('#RAR 0 20240101 20241231')
  })

  it('omits #ORGNR when org_number is null', async () => {
    results = [
      { data: { id: 'period-1', period_start: '2024-01-01', period_end: '2024-12-31' }, error: null },
      { data: null, error: null }, // prevPeriod
      { data: [], error: null }, // accounts
      { data: [], error: null }, // journal_entries
      { data: [], error: null }, // journal_entry_lines
      { data: [], error: null }, // cost_centers
      { data: [], error: null }, // projects
      { data: [], error: null }, // RPC fallback
    ]

    const output = await generateSIEExport(supabase, 'company-1', {
      ...baseOptions,
      org_number: null,
    })

    expect(output).not.toContain('#ORGNR')
  })

  it('generates #KONTO and #SRU for accounts', async () => {
    results = [
      { data: { id: 'period-1', period_start: '2024-01-01', period_end: '2024-12-31' }, error: null },
      { data: null, error: null }, // prevPeriod
      {
        data: [
          { account_number: '1930', account_name: 'Företagskonto', sru_code: '7301', is_active: true },
          { account_number: '3001', account_name: 'Försäljning', sru_code: null, is_active: true },
        ],
        error: null,
      },
      { data: [], error: null }, // journal_entries
      { data: [], error: null }, // journal_entry_lines
      { data: [], error: null }, // cost_centers
      { data: [], error: null }, // projects
      { data: [], error: null }, // RPC fallback
    ]

    const output = await generateSIEExport(supabase, 'company-1', baseOptions)

    expect(output).toContain('#KONTO 1930 "Företagskonto"')
    expect(output).toContain('#SRU 1930 7301')
    expect(output).toContain('#KONTO 3001 "Försäljning"')
    // No SRU for 3001 since sru_code is null
    expect(output).not.toContain('#SRU 3001')
  })

  it('generates #VER and #TRANS for journal entries', async () => {
    results = [
      { data: { id: 'period-1', period_start: '2024-01-01', period_end: '2024-12-31' }, error: null },
      { data: null, error: null }, // prevPeriod
      { data: [], error: null }, // accounts
      {
        // journal_entries (no embedded lines — those come from the next slot)
        data: [
          { id: 'e1', entry_date: '2024-03-15', voucher_number: 1, voucher_series: 'A', description: 'Sale invoice', status: 'posted' },
        ],
        error: null,
      },
      {
        // journal_entry_lines — each carries journal_entry_id for grouping
        data: [
          { journal_entry_id: 'e1', account_number: '1510', debit_amount: 1250, credit_amount: 0, line_description: null, cost_center: null, project: null },
          { journal_entry_id: 'e1', account_number: '3001', debit_amount: 0, credit_amount: 1000, line_description: 'Revenue', cost_center: null, project: null },
          { journal_entry_id: 'e1', account_number: '2611', debit_amount: 0, credit_amount: 250, line_description: null, cost_center: null, project: null },
        ],
        error: null,
      },
      { data: [], error: null }, // cost_centers
      { data: [], error: null }, // projects
      { data: [], error: null }, // RPC fallback
    ]

    const output = await generateSIEExport(supabase, 'company-1', baseOptions)

    expect(output).toContain('#VER "A" 1 20240315 "Sale invoice"')
    expect(output).toContain('{')
    expect(output).toContain('\t#TRANS 1510 {} 1250.00 20240315')
    expect(output).toContain('\t#TRANS 3001 {} -1000.00 20240315 "Revenue"')
    expect(output).toContain('\t#TRANS 2611 {} -250.00 20240315')
    expect(output).toContain('}')
  })

  it('generates #DIM and #OBJEKT for dimensions', async () => {
    results = [
      { data: { id: 'period-1', period_start: '2024-01-01', period_end: '2024-12-31' }, error: null },
      { data: null, error: null }, // prevPeriod
      { data: [], error: null }, // accounts
      { data: [], error: null }, // journal_entries
      { data: [], error: null }, // journal_entry_lines
      {
        data: [
          { code: 'CC1', name: 'Avdelning 1', is_active: true },
        ],
        error: null,
      },
      {
        data: [
          { code: 'P001', name: 'Projekt Alpha', is_active: true },
        ],
        error: null,
      },
      { data: [], error: null }, // RPC fallback
    ]

    const output = await generateSIEExport(supabase, 'company-1', baseOptions)

    expect(output).toContain('#DIM 1 "Kostnadsställe"')
    expect(output).toContain('#DIM 6 "Projekt"')
    expect(output).toContain('#OBJEKT 1 "CC1" "Avdelning 1"')
    expect(output).toContain('#OBJEKT 6 "P001" "Projekt Alpha"')
  })

  it('includes dimension objects in #TRANS lines', async () => {
    results = [
      { data: { id: 'period-1', period_start: '2024-01-01', period_end: '2024-12-31' }, error: null },
      { data: null, error: null }, // prevPeriod
      { data: [], error: null }, // accounts
      {
        data: [
          { id: 'e1', entry_date: '2024-03-15', voucher_number: 1, voucher_series: 'A', description: 'With dimensions', status: 'posted' },
        ],
        error: null,
      },
      {
        data: [
          { journal_entry_id: 'e1', account_number: '5010', debit_amount: 8000, credit_amount: 0, line_description: null, cost_center: 'CC1', project: 'P001' },
          { journal_entry_id: 'e1', account_number: '1930', debit_amount: 0, credit_amount: 8000, line_description: null, cost_center: null, project: null },
        ],
        error: null,
      },
      { data: [{ code: 'CC1', name: 'Avdelning 1', is_active: true }], error: null },
      { data: [{ code: 'P001', name: 'Projekt Alpha', is_active: true }], error: null },
      { data: [], error: null }, // RPC fallback
    ]

    const output = await generateSIEExport(supabase, 'company-1', baseOptions)

    expect(output).toContain('\t#TRANS 5010 {1 "CC1" 6 "P001"} 8000.00 20240315')
    expect(output).toContain('\t#TRANS 1930 {} -8000.00 20240315')
  })

  it('generates #UB for class 1-2 and #RES for class 3-8', async () => {
    results = [
      { data: { id: 'period-1', period_start: '2024-01-01', period_end: '2024-12-31' }, error: null },
      { data: null, error: null }, // prevPeriod
      { data: [], error: null }, // accounts
      {
        data: [
          { id: 'e1', entry_date: '2024-01-15', voucher_number: 1, voucher_series: 'A', description: 'Sale', status: 'posted' },
        ],
        error: null,
      },
      {
        data: [
          { journal_entry_id: 'e1', account_number: '1510', debit_amount: 1250, credit_amount: 0, line_description: null, cost_center: null, project: null },
          { journal_entry_id: 'e1', account_number: '3001', debit_amount: 0, credit_amount: 1000, line_description: null, cost_center: null, project: null },
          { journal_entry_id: 'e1', account_number: '2611', debit_amount: 0, credit_amount: 250, line_description: null, cost_center: null, project: null },
        ],
        error: null,
      },
      { data: [], error: null }, // cost_centers
      { data: [], error: null }, // projects
      { data: [], error: null }, // RPC fallback
    ]

    const output = await generateSIEExport(supabase, 'company-1', baseOptions)

    // Account 1510 (class 1) → #UB, balance = 1250 - 0 = 1250
    expect(output).toContain('#UB 0 1510 1250.00')
    // Account 2611 (class 2) → #UB, balance = 0 - 250 = -250
    expect(output).toContain('#UB 0 2611 -250.00')
    // Account 3001 (class 3) → #RES, balance = 0 - 1000 = -1000
    expect(output).toContain('#RES 0 3001 -1000.00')
  })

  it('escapes quotes in descriptions', async () => {
    results = [
      { data: { id: 'period-1', period_start: '2024-01-01', period_end: '2024-12-31' }, error: null },
      { data: null, error: null }, // prevPeriod
      { data: [], error: null }, // accounts
      {
        data: [
          { id: 'e1', entry_date: '2024-01-15', voucher_number: 1, voucher_series: 'A', description: 'Invoice for "consulting"', status: 'posted' },
        ],
        error: null,
      },
      {
        data: [
          { journal_entry_id: 'e1', account_number: '1930', debit_amount: 100, credit_amount: 0, line_description: null, cost_center: null, project: null },
          { journal_entry_id: 'e1', account_number: '3001', debit_amount: 0, credit_amount: 100, line_description: null, cost_center: null, project: null },
        ],
        error: null,
      },
      { data: [], error: null }, // cost_centers
      { data: [], error: null }, // projects
      { data: [], error: null }, // RPC fallback
    ]

    const output = await generateSIEExport(supabase, 'company-1', baseOptions)

    expect(output).toContain('#VER "A" 1 20240115 "Invoice for \\"consulting\\""')
  })

  it('uses \\r\\n line endings', async () => {
    results = [
      { data: { id: 'period-1', period_start: '2024-01-01', period_end: '2024-12-31' }, error: null },
      { data: null, error: null }, // prevPeriod
      { data: [], error: null }, // accounts
      { data: [], error: null }, // journal_entries
      { data: [], error: null }, // journal_entry_lines
      { data: [], error: null }, // cost_centers
      { data: [], error: null }, // projects
      { data: [], error: null }, // RPC fallback
    ]

    const output = await generateSIEExport(supabase, 'company-1', baseOptions)

    // Every line should end with \r\n
    expect(output).toContain('\r\n')
    // Should not have bare \n (that isn't preceded by \r)
    const lines = output.split('\r\n')
    for (const line of lines.slice(0, -1)) {
      expect(line).not.toContain('\n')
    }
    // File should end with \r\n
    expect(output.endsWith('\r\n')).toBe(true)
  })

  it('produces no #VER lines when no entries exist', async () => {
    results = [
      { data: { id: 'period-1', period_start: '2024-01-01', period_end: '2024-12-31' }, error: null },
      { data: null, error: null }, // prevPeriod
      { data: [], error: null }, // accounts
      { data: [], error: null }, // journal_entries
      { data: [], error: null }, // journal_entry_lines
      { data: [], error: null }, // cost_centers
      { data: [], error: null }, // projects
      { data: [], error: null }, // RPC fallback
    ]

    const output = await generateSIEExport(supabase, 'company-1', baseOptions)

    expect(output).not.toContain('#VER')
    expect(output).not.toContain('#TRANS')
  })

  it('produces no #DIM lines when no dimensions exist', async () => {
    results = [
      { data: { id: 'period-1', period_start: '2024-01-01', period_end: '2024-12-31' }, error: null },
      { data: null, error: null }, // prevPeriod
      { data: [], error: null }, // accounts
      { data: [], error: null }, // journal_entries
      { data: [], error: null }, // journal_entry_lines
      { data: [], error: null }, // cost_centers
      { data: [], error: null }, // projects
      { data: [], error: null }, // RPC fallback
    ]

    const output = await generateSIEExport(supabase, 'company-1', baseOptions)

    expect(output).not.toContain('#DIM')
    expect(output).not.toContain('#OBJEKT')
  })

  it('does not truncate large periods — every voucher and its lines are exported', async () => {
    // Regression test for the user-reported bug: the previous nested
    // `select('*, lines:journal_entry_lines(*)')` query hit PostgREST's
    // embedded-resource row ceiling and silently truncated to ~30 vouchers.
    // The pagination fix fetches entries and lines as separate paginated
    // queries, so a period far larger than any single page round-trips fully.
    const ENTRY_COUNT = 2500 // well past the 1000-row PostgREST page size

    const entries = Array.from({ length: ENTRY_COUNT }, (_, i) => ({
      id: `e${i + 1}`,
      entry_date: '2024-06-01',
      voucher_number: i + 1,
      voucher_series: 'A',
      description: `Voucher ${i + 1}`,
      status: 'posted',
    }))

    const lines = entries.flatMap((e, i) => [
      { id: `l${i * 2 + 1}`, journal_entry_id: e.id, account_number: '1510', debit_amount: 100, credit_amount: 0, line_description: null, cost_center: null, project: null },
      { id: `l${i * 2 + 2}`, journal_entry_id: e.id, account_number: '3001', debit_amount: 0, credit_amount: 100, line_description: null, cost_center: null, project: null },
    ])

    // fetchAllRows paginates at PAGE_SIZE = 1000; chunk the mock data so the
    // queue mimics real multi-page round-trips and the loop stops on a short page.
    function paginate<T>(rows: T[]): Array<{ data: T[]; error: null }> {
      const PAGE = 1000
      const pages: Array<{ data: T[]; error: null }> = []
      for (let i = 0; i < rows.length; i += PAGE) {
        pages.push({ data: rows.slice(i, i + PAGE), error: null })
      }
      // Ensure a final short page so fetchAllRows terminates when the data is
      // an exact multiple of PAGE_SIZE.
      if (rows.length % PAGE === 0) pages.push({ data: [], error: null })
      return pages
    }

    results = [
      { data: { id: 'period-1', period_start: '2024-01-01', period_end: '2024-12-31' }, error: null },
      { data: null, error: null }, // prevPeriod
      { data: [], error: null }, // accounts
      ...paginate(entries), // journal_entries — 3 pages (1000 + 1000 + 500)
      ...paginate(lines), // journal_entry_lines — 5000 rows → 5 pages
      { data: [], error: null }, // cost_centers
      { data: [], error: null }, // projects
      { data: [], error: null }, // RPC fallback
    ]

    const output = await generateSIEExport(supabase, 'company-1', baseOptions)

    // Every voucher present — including the first, last, and a middle one
    // that the old ~30-row cap would have dropped.
    const verCount = (output.match(/#VER /g) || []).length
    expect(verCount).toBe(ENTRY_COUNT)
    expect(output).toContain('#VER "A" 1 20240601 "Voucher 1"')
    expect(output).toContain(`#VER "A" 1500 20240601 "Voucher 1500"`)
    expect(output).toContain(`#VER "A" ${ENTRY_COUNT} 20240601 "Voucher ${ENTRY_COUNT}"`)

    // Lines were stitched onto their entries (two #TRANS per voucher)
    const transCount = (output.match(/#TRANS /g) || []).length
    expect(transCount).toBe(ENTRY_COUNT * 2)
  })

  it('emits #IB from compute_prior_opening_balances RPC fallback when opening_balance_entry_id is null', async () => {
    // Reproduces the user-reported bug: after a multi-year SIE import the
    // continuation-import guard intentionally leaves opening_balance_entry_id
    // NULL, and previously the SIE export silently produced zero #IB records,
    // collapsing #UB to current-period movements only. The fix wires SIE
    // export to getOpeningBalances() so the RPC backs up the missing link.
    results = [
      // period — note: no opening_balance_entry_id, so getOpeningBalances
      // falls through to the RPC path
      { data: { id: 'period-1', period_start: '2024-01-01', period_end: '2024-12-31', opening_balance_entry_id: null }, error: null },
      { data: null, error: null }, // prevPeriod
      { data: [], error: null }, // accounts
      { data: [], error: null }, // journal_entries (no movements this period)
      { data: [], error: null }, // journal_entry_lines
      { data: [], error: null }, // cost_centers
      { data: [], error: null }, // projects
      // RPC fallback returns prior IBs derived from historical journal lines
      {
        data: [
          { account_number: '1930', debit: 50000, credit: 0 },
          { account_number: '2440', debit: 0, credit: 50000 },
        ],
        error: null,
      },
    ]

    const output = await generateSIEExport(supabase, 'company-1', baseOptions)

    expect(output).toContain('#IB 0 1930 50000.00')
    expect(output).toContain('#IB 0 2440 -50000.00')
    // UB = IB + period movements (zero this period), so #UB mirrors #IB
    expect(output).toContain('#UB 0 1930 50000.00')
    expect(output).toContain('#UB 0 2440 -50000.00')
  })

  it('reads #IB from explicit opening_balance_entry_id when set', async () => {
    // When opening_balance_entry_id is set, getOpeningBalances uses the
    // journal_entry_lines path (fetchAllRows) instead of the RPC, so the
    // queue here serves the line rows rather than RPC rows.
    results = [
      { data: { id: 'period-1', period_start: '2024-01-01', period_end: '2024-12-31', opening_balance_entry_id: 'ob-entry-1' }, error: null },
      { data: null, error: null }, // prevPeriod
      { data: [], error: null }, // accounts
      { data: [], error: null }, // journal_entries
      { data: [], error: null }, // journal_entry_lines
      { data: [], error: null }, // cost_centers
      { data: [], error: null }, // projects
      // fetchAllRows page 1 — explicit OB entry lines
      {
        data: [
          { account_number: '1930', debit_amount: 12000, credit_amount: 0 },
          { account_number: '2440', debit_amount: 0, credit_amount: 12000 },
        ],
        error: null,
      },
    ]

    const output = await generateSIEExport(supabase, 'company-1', baseOptions)

    expect(output).toContain('#IB 0 1930 12000.00')
    expect(output).toContain('#IB 0 2440 -12000.00')
    expect(output).toContain('#UB 0 1930 12000.00')
    expect(output).toContain('#UB 0 2440 -12000.00')
  })
})
