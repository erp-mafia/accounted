import { describe, it, expect, vi, beforeEach } from 'vitest'

// ============================================================
// Mock: sequential result queue
// ============================================================

let resultIdx: number
let results: Array<{ data?: unknown; error?: unknown }>
// `.eq()` args recorded per table so tests can assert on query shape (e.g.
// that the dimension registry fetch does NOT filter is_active: the latent
// undeclared-#OBJEKT bug was exactly such a filter).
let eqCallsByTable: Record<string, Array<[string, unknown]>>

function makeBuilder(table: string) {
  const b: Record<string, unknown> = {}
  for (const m of ['select', 'in', 'order', 'range', 'lt', 'lte', 'gte', 'gt', 'limit', 'neq']) {
    b[m] = vi.fn().mockReturnValue(b)
  }
  b.eq = vi.fn().mockImplementation((column: string, value: unknown) => {
    ;(eqCallsByTable[table] ??= []).push([column, value])
    return b
  })
  b.single = vi.fn().mockImplementation(async () => results[resultIdx++] ?? { data: null, error: null })
  b.then = (resolve: (v: unknown) => void) => resolve(results[resultIdx++] ?? { data: null, error: null })
  return b
}

function makeClient() {
  return {
    from: vi.fn().mockImplementation((table: string) => makeBuilder(table)),
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
  eqCallsByTable = {}
  supabase = makeClient()
})

const baseOptions = {
  fiscal_period_id: 'period-1',
  company_name: 'Test AB',
  org_number: '556677-8899',
  program_name: 'ERPBase',
}

// Queue consumption order (dimensions registry replaced cost_centers/projects):
//   0: fiscal_periods.single()
//   1: previous fiscal period .single() (#RAR -1)
//   2: chart_of_accounts        (fetchAllRows)
//   3: journal_entries          (fetchAllRows)
//   4: journal_entry_lines      (fetchAllRows)   ← split out from the entries query
//   5: dimensions               (registry #DIM/#UNDERDIM rows)
//   6: dimension_values         (registry #OBJEKT rows)
//   7: opening balances (RPC fallback or journal_entry_lines page)

// Registry fixtures for the system dims (seeded by ensure_company_dimensions).
const dimKostnadsstalle = { id: 'dim-1', sie_dim_no: 1, parent_sie_dim_no: null, name: 'Kostnadsställe' }
const dimProjekt = { id: 'dim-6', sie_dim_no: 6, parent_sie_dim_no: null, name: 'Projekt' }

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
      { data: [], error: null }, // dimensions
      { data: [], error: null }, // dimension_values
      { data: [], error: null }, // opening balances RPC
    ]

    const output = await generateSIEExport(supabase, 'company-1', baseOptions)
    const lines = output.split('\r\n')

    expect(lines[0]).toBe('#FLAGGA 0')
    expect(lines[1]).toBe('#SIETYP 4')
    expect(lines[2]).toMatch(/^#PROGRAM "ERPBase" "1\.0"$/)
    expect(lines[3]).toMatch(/^#GEN \d{8}$/)
    expect(lines[4]).toBe('#ORGNR 556677-8899')
    expect(lines[5]).toBe('#FNAMN "Test AB"')
    expect(lines[6]).toBe('#RAR 0 20240101 20241231')
    expect(output).not.toContain('#FORMAT PC8')
  })

  it('omits #ORGNR when org_number is null', async () => {
    results = [
      { data: { id: 'period-1', period_start: '2024-01-01', period_end: '2024-12-31' }, error: null },
      { data: null, error: null }, // prevPeriod
      { data: [], error: null }, // accounts
      { data: [], error: null }, // journal_entries
      { data: [], error: null }, // journal_entry_lines
      { data: [], error: null }, // dimensions
      { data: [], error: null }, // dimension_values
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
      { data: [], error: null }, // dimensions
      { data: [], error: null }, // dimension_values
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
        // journal_entries (no embedded lines: those come from the next slot)
        data: [
          { id: 'e1', entry_date: '2024-03-15', voucher_number: 1, voucher_series: 'A', description: 'Sale invoice', status: 'posted' },
        ],
        error: null,
      },
      {
        // journal_entry_lines: each carries journal_entry_id for grouping
        data: [
          { journal_entry_id: 'e1', account_number: '1510', debit_amount: 1250, credit_amount: 0, line_description: null, dimensions: {} },
          { journal_entry_id: 'e1', account_number: '3001', debit_amount: 0, credit_amount: 1000, line_description: 'Revenue', dimensions: {} },
          { journal_entry_id: 'e1', account_number: '2611', debit_amount: 0, credit_amount: 250, line_description: null, dimensions: {} },
        ],
        error: null,
      },
      { data: [], error: null }, // dimensions
      { data: [], error: null }, // dimension_values
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

  it('generates #DIM and #OBJEKT for registry dimensions', async () => {
    results = [
      { data: { id: 'period-1', period_start: '2024-01-01', period_end: '2024-12-31' }, error: null },
      { data: null, error: null }, // prevPeriod
      { data: [], error: null }, // accounts
      { data: [], error: null }, // journal_entries
      { data: [], error: null }, // journal_entry_lines
      { data: [dimKostnadsstalle, dimProjekt], error: null }, // dimensions
      {
        data: [
          { dimension_id: 'dim-1', code: 'CC1', name: 'Avdelning 1' },
          { dimension_id: 'dim-6', code: 'P001', name: 'Projekt Alpha' },
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

  it('includes dimension objects in #TRANS lines from the jsonb map', async () => {
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
          { journal_entry_id: 'e1', account_number: '5010', debit_amount: 8000, credit_amount: 0, line_description: null, dimensions: { '1': 'CC1', '6': 'P001' } },
          { journal_entry_id: 'e1', account_number: '1930', debit_amount: 0, credit_amount: 8000, line_description: null, dimensions: {} },
        ],
        error: null,
      },
      { data: [dimKostnadsstalle, dimProjekt], error: null }, // dimensions
      {
        data: [
          { dimension_id: 'dim-1', code: 'CC1', name: 'Avdelning 1' },
          { dimension_id: 'dim-6', code: 'P001', name: 'Projekt Alpha' },
        ],
        error: null,
      },
      { data: [], error: null }, // RPC fallback
    ]

    const output = await generateSIEExport(supabase, 'company-1', baseOptions)

    expect(output).toContain('\t#TRANS 5010 {1 "CC1" 6 "P001"} 8000.00 20240315')
    expect(output).toContain('\t#TRANS 1930 {} -8000.00 20240315')
  })

  it('declares INACTIVE registry values as #OBJEKT (undeclared-object regression)', async () => {
    // Latent bug in the legacy read path: the registry fetch filtered
    // is_active=true, so a line referencing an archived code serialized into
    // #TRANS while its #OBJEKT declaration was missing: Visma rejects such
    // files. The registry fetch must NOT filter on is_active.
    results = [
      { data: { id: 'period-1', period_start: '2024-01-01', period_end: '2024-12-31' }, error: null },
      { data: null, error: null }, // prevPeriod
      { data: [], error: null }, // accounts
      {
        data: [
          { id: 'e1', entry_date: '2024-05-02', voucher_number: 1, voucher_series: 'A', description: 'Archived code', status: 'posted' },
        ],
        error: null,
      },
      {
        data: [
          { journal_entry_id: 'e1', account_number: '5010', debit_amount: 500, credit_amount: 0, line_description: null, dimensions: { '1': 'CC9' } },
          { journal_entry_id: 'e1', account_number: '1930', debit_amount: 0, credit_amount: 500, line_description: null, dimensions: {} },
        ],
        error: null,
      },
      { data: [dimKostnadsstalle], error: null }, // dimensions
      // The archived (is_active=false) value row IS returned by the query
      // because the export must not filter it out.
      { data: [{ dimension_id: 'dim-1', code: 'CC9', name: 'Nedlagd avdelning', is_active: false }], error: null },
      { data: [], error: null }, // RPC fallback
    ]

    const output = await generateSIEExport(supabase, 'company-1', baseOptions)

    // Declared with its registry name (not synthesized code-as-name)
    expect(output).toContain('#DIM 1 "Kostnadsställe"')
    expect(output).toContain('#OBJEKT 1 "CC9" "Nedlagd avdelning"')
    expect(output).toContain('\t#TRANS 5010 {1 "CC9"} 500.00 20240502')
    // Query-shape guard: neither registry fetch may filter on is_active:
    // that is the exact filter that caused the undeclared-#OBJEKT bug.
    expect(eqCallsByTable['dimensions'] ?? []).not.toContainEqual(['is_active', true])
    expect(eqCallsByTable['dimension_values'] ?? []).not.toContainEqual(['is_active', true])
  })

  it('synthesizes #DIM and #OBJEKT for orphan line codes with no registry rows', async () => {
    // Free-text writers can still mint dimension numbers/codes until the
    // write-path PR: every referenced (dimNo, code) pair must be declared,
    // never silently dropped. Dim 6 resolves from the SIE reserved-number
    // seed; dim 13 falls back to "Dimension n"; both codes get name = code.
    results = [
      { data: { id: 'period-1', period_start: '2024-01-01', period_end: '2024-12-31' }, error: null },
      { data: null, error: null }, // prevPeriod
      { data: [], error: null }, // accounts
      {
        data: [
          { id: 'e1', entry_date: '2024-02-01', voucher_number: 1, voucher_series: 'A', description: 'Orphans', status: 'posted' },
        ],
        error: null,
      },
      {
        data: [
          { journal_entry_id: 'e1', account_number: '4010', debit_amount: 900, credit_amount: 0, line_description: null, dimensions: { '6': 'GHOST', '13': 'X1' } },
          { journal_entry_id: 'e1', account_number: '1930', debit_amount: 0, credit_amount: 900, line_description: null, dimensions: {} },
        ],
        error: null,
      },
      { data: [], error: null }, // dimensions: registry is empty
      { data: [], error: null }, // dimension_values
      { data: [], error: null }, // RPC fallback
    ]

    const output = await generateSIEExport(supabase, 'company-1', baseOptions)

    expect(output).toContain('#DIM 6 "Projekt"')
    expect(output).toContain('#DIM 13 "Dimension 13"')
    expect(output).toContain('#OBJEKT 6 "GHOST" "GHOST"')
    expect(output).toContain('#OBJEKT 13 "X1" "X1"')
    expect(output).toContain('\t#TRANS 4010 {6 "GHOST" 13 "X1"} 900.00 20240201')
  })

  it('serializes multi-dimension lines sorted by numeric dimension number', async () => {
    results = [
      { data: { id: 'period-1', period_start: '2024-01-01', period_end: '2024-12-31' }, error: null },
      { data: null, error: null }, // prevPeriod
      { data: [], error: null }, // accounts
      {
        data: [
          { id: 'e1', entry_date: '2024-04-10', voucher_number: 1, voucher_series: 'A', description: 'Multi-dim', status: 'posted' },
        ],
        error: null,
      },
      {
        // Keys deliberately out of order: output must sort 1 < 6 < 7
        data: [
          { journal_entry_id: 'e1', account_number: '7010', debit_amount: 30000, credit_amount: 0, line_description: null, dimensions: { '7': 'EMP1', '1': 'KS01', '6': 'P001' } },
          { journal_entry_id: 'e1', account_number: '1930', debit_amount: 0, credit_amount: 30000, line_description: null, dimensions: {} },
        ],
        error: null,
      },
      { data: [dimKostnadsstalle, dimProjekt], error: null }, // dimensions
      {
        data: [
          { dimension_id: 'dim-1', code: 'KS01', name: 'Kontoret' },
          { dimension_id: 'dim-6', code: 'P001', name: 'Projekt Alpha' },
        ],
        error: null,
      },
      { data: [], error: null }, // RPC fallback
    ]

    const output = await generateSIEExport(supabase, 'company-1', baseOptions)

    expect(output).toContain('\t#TRANS 7010 {1 "KS01" 6 "P001" 7 "EMP1"} 30000.00 20240410')
    // Dim 7 has no registry row → synthesized from the SIE reserved seed,
    // with the orphan employee code declared.
    expect(output).toContain('#DIM 7 "Anställd"')
    expect(output).toContain('#OBJEKT 7 "EMP1" "EMP1"')
  })

  it('emits #UNDERDIM for child dimensions and declares the parent', async () => {
    results = [
      { data: { id: 'period-1', period_start: '2024-01-01', period_end: '2024-12-31' }, error: null },
      { data: null, error: null }, // prevPeriod
      { data: [], error: null }, // accounts
      { data: [], error: null }, // journal_entries
      { data: [], error: null }, // journal_entry_lines
      {
        // Kostnadsbärare (2) is a sub-dimension of Kostnadsställe (1); the
        // parent has NO values of its own: it must still be declared because
        // an #UNDERDIM referencing an undeclared parent is invalid.
        data: [
          dimKostnadsstalle,
          { id: 'dim-2', sie_dim_no: 2, parent_sie_dim_no: 1, name: 'Kostnadsbärare' },
        ],
        error: null,
      },
      { data: [{ dimension_id: 'dim-2', code: 'KB1', name: 'Bärare 1' }], error: null },
      { data: [], error: null }, // RPC fallback
    ]

    const output = await generateSIEExport(supabase, 'company-1', baseOptions)

    expect(output).toContain('#DIM 1 "Kostnadsställe"')
    expect(output).toContain('#UNDERDIM 2 "Kostnadsbärare" 1')
    expect(output).toContain('#OBJEKT 2 "KB1" "Bärare 1"')
    // The parent was pulled in as a declaration only, no #UNDERDIM for it
    expect(output).not.toContain('#UNDERDIM 1')
  })

  it('declares a parent #DIM before an #UNDERDIM child with a LOWER number', async () => {
    // SIE4 requires the parent to be declared before any #UNDERDIM that
    // references it. A registry can hold a child whose sie_dim_no is LOWER
    // than its parent's (dim 3 under dim 7 here), so a single numeric sort
    // would emit the #UNDERDIM first: the two-pass emit (#DIM roots first,
    // then #UNDERDIM) must keep the parent ahead.
    results = [
      { data: { id: 'period-1', period_start: '2024-01-01', period_end: '2024-12-31' }, error: null },
      { data: null, error: null }, // prevPeriod
      { data: [], error: null }, // accounts
      {
        data: [
          { id: 'e1', entry_date: '2024-03-01', voucher_number: 1, voucher_series: 'A', description: 'Child below parent', status: 'posted' },
        ],
        error: null,
      },
      {
        data: [
          { journal_entry_id: 'e1', account_number: '5010', debit_amount: 700, credit_amount: 0, line_description: null, dimensions: { '3': 'UND1', '7': 'EMP1' } },
          { journal_entry_id: 'e1', account_number: '1930', debit_amount: 0, credit_amount: 700, line_description: null, dimensions: {} },
        ],
        error: null,
      },
      {
        // dim 3 is a child of dim 7, numerically BEFORE its parent.
        data: [
          { id: 'dim-3', sie_dim_no: 3, parent_sie_dim_no: 7, name: 'Underavdelning' },
          { id: 'dim-7', sie_dim_no: 7, parent_sie_dim_no: null, name: 'Anställd' },
        ],
        error: null,
      },
      {
        data: [
          { dimension_id: 'dim-3', code: 'UND1', name: 'Under 1' },
          { dimension_id: 'dim-7', code: 'EMP1', name: 'Anna' },
        ],
        error: null,
      },
      { data: [], error: null }, // RPC fallback
    ]

    const output = await generateSIEExport(supabase, 'company-1', baseOptions)

    expect(output).toContain('#DIM 7 "Anställd"')
    expect(output).toContain('#UNDERDIM 3 "Underavdelning" 7')
    // The parent #DIM must precede the child #UNDERDIM in the file.
    expect(output.indexOf('#DIM 7 "Anställd"')).toBeLessThan(
      output.indexOf('#UNDERDIM 3 "Underavdelning" 7'),
    )
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
          { journal_entry_id: 'e1', account_number: '1510', debit_amount: 1250, credit_amount: 0, line_description: null, dimensions: {} },
          { journal_entry_id: 'e1', account_number: '3001', debit_amount: 0, credit_amount: 1000, line_description: null, dimensions: {} },
          { journal_entry_id: 'e1', account_number: '2611', debit_amount: 0, credit_amount: 250, line_description: null, dimensions: {} },
        ],
        error: null,
      },
      { data: [], error: null }, // dimensions
      { data: [], error: null }, // dimension_values
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
          { journal_entry_id: 'e1', account_number: '1930', debit_amount: 100, credit_amount: 0, line_description: null, dimensions: {} },
          { journal_entry_id: 'e1', account_number: '3001', debit_amount: 0, credit_amount: 100, line_description: null, dimensions: {} },
        ],
        error: null,
      },
      { data: [], error: null }, // dimensions
      { data: [], error: null }, // dimension_values
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
      { data: [], error: null }, // dimensions
      { data: [], error: null }, // dimension_values
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
      { data: [], error: null }, // dimensions
      { data: [], error: null }, // dimension_values
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
      { data: [], error: null }, // dimensions
      { data: [], error: null }, // dimension_values
      { data: [], error: null }, // RPC fallback
    ]

    const output = await generateSIEExport(supabase, 'company-1', baseOptions)

    expect(output).not.toContain('#DIM')
    expect(output).not.toContain('#OBJEKT')
  })

  it('keeps seeded-but-unused system dimensions silent (no #DIM without values or tagged lines)', async () => {
    // ensure_company_dimensions lazily seeds dims 1/6 for any company that
    // touches the dimensions UI: a company that merely visited the register
    // page must still get a dimension-free file.
    results = [
      { data: { id: 'period-1', period_start: '2024-01-01', period_end: '2024-12-31' }, error: null },
      { data: null, error: null }, // prevPeriod
      { data: [], error: null }, // accounts
      { data: [], error: null }, // journal_entries
      { data: [], error: null }, // journal_entry_lines
      { data: [dimKostnadsstalle, dimProjekt], error: null }, // dimensions: seeded, valueless
      { data: [], error: null }, // dimension_values
      { data: [], error: null }, // RPC fallback
    ]

    const output = await generateSIEExport(supabase, 'company-1', baseOptions)

    expect(output).not.toContain('#DIM')
    expect(output).not.toContain('#OBJEKT')
  })

  it('does not truncate large periods: every voucher and its lines are exported', async () => {
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
      { id: `l${i * 2 + 1}`, journal_entry_id: e.id, account_number: '1510', debit_amount: 100, credit_amount: 0, line_description: null, dimensions: {} },
      { id: `l${i * 2 + 2}`, journal_entry_id: e.id, account_number: '3001', debit_amount: 0, credit_amount: 100, line_description: null, dimensions: {} },
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
      ...paginate(entries), // journal_entries: 3 pages (1000 + 1000 + 500)
      ...paginate(lines), // journal_entry_lines: 5000 rows → 5 pages
      { data: [], error: null }, // dimensions
      { data: [], error: null }, // dimension_values
      { data: [], error: null }, // RPC fallback
    ]

    const output = await generateSIEExport(supabase, 'company-1', baseOptions)

    // Every voucher present: including the first, last, and a middle one
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
      // period: note: no opening_balance_entry_id, so getOpeningBalances
      // falls through to the RPC path
      { data: { id: 'period-1', period_start: '2024-01-01', period_end: '2024-12-31', opening_balance_entry_id: null }, error: null },
      { data: null, error: null }, // prevPeriod
      { data: [], error: null }, // accounts
      { data: [], error: null }, // journal_entries (no movements this period)
      { data: [], error: null }, // journal_entry_lines
      { data: [], error: null }, // dimensions
      { data: [], error: null }, // dimension_values
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
      { data: [], error: null }, // dimensions
      { data: [], error: null }, // dimension_values
      // fetchAllRows page 1: explicit OB entry lines
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

  it('excludes the OB entry from #VER output and #UB movement so a zeroed-out account gets #UB 0', async () => {
    // Regression: the OB entry was included in both getOpeningBalances (#IB)
    // and calculateBalances (movement), so its debit cancelled the real net
    // movement and left #UB = #IB for any account zeroed out during the year.
    //
    // Setup: 1933 opens at 96 466,59 (IB), is swept to 0 via a transfer to
    // 1930 during the year. The OB entry (id: 'ob-entry-1') is returned by
    // the journal_entries query because it lives in the same fiscal period.
    results = [
      { data: { id: 'period-1', period_start: '2024-01-01', period_end: '2024-12-31', opening_balance_entry_id: 'ob-entry-1' }, error: null },
      { data: null, error: null }, // prevPeriod
      { data: [], error: null },   // accounts
      {
        // journal_entries (fetchAllRows): no embedded lines; stitched below
        data: [
          // The OB entry itself: must be excluded from movement/VER output
          {
            id: 'ob-entry-1',
            entry_date: '2024-01-01',
            voucher_number: 1,
            voucher_series: 'A',
            description: 'IB 2024',
            status: 'posted',
          },
          // A real transaction: account 1933 swept to 1930
          {
            id: 'e2',
            entry_date: '2024-08-07',
            voucher_number: 2,
            voucher_series: 'A',
            description: 'Stängning Bokio',
            status: 'posted',
          },
        ],
        error: null,
      },
      // journal_entry_lines (allLines): #824 moved per-entry lines into a single
      // paged join query; lines map back to entries by journal_entry_id (the inline
      // entry.lines above are overwritten). The OB entry's lines (excluded from
      // movement via obEntryId) and the real transfer's lines both flow through here.
      {
        data: [
          { id: 'l1', journal_entry_id: 'ob-entry-1', account_number: '1933', debit_amount: 96466.59, credit_amount: 0, line_description: 'IB 1933', dimensions: {} },
          { id: 'l2', journal_entry_id: 'ob-entry-1', account_number: '2019', debit_amount: 0, credit_amount: 96466.59, line_description: null, dimensions: {} },
          { id: 'l3', journal_entry_id: 'e2', account_number: '1930', debit_amount: 96466.59, credit_amount: 0, line_description: null, dimensions: {} },
          { id: 'l4', journal_entry_id: 'e2', account_number: '1933', debit_amount: 0, credit_amount: 96466.59, line_description: null, dimensions: {} },
        ],
        error: null,
      },
      { data: [], error: null }, // dimensions
      { data: [], error: null }, // dimension_values
      // fetchAllRows for OB entry lines (opening_balance_entry_id is set)
      {
        data: [
          { account_number: '1933', debit_amount: 96466.59, credit_amount: 0 },
          { account_number: '2019', debit_amount: 0, credit_amount: 96466.59 },
        ],
        error: null,
      },
    ]

    const output = await generateSIEExport(supabase, 'company-1', baseOptions)

    // IB recorded correctly
    expect(output).toContain('#IB 0 1933 96466.59')
    // 1933 was zeroed out: UB must be 0, not a repeat of IB
    expect(output).toContain('#UB 0 1933 0.00')
    // 1930 received the sweep: UB = 0 + 96466.59
    expect(output).toContain('#UB 0 1930 96466.59')
    // OB entry must NOT appear as a #VER block
    expect(output).not.toContain('"IB 2024"')
    // The real transfer entry must appear
    expect(output).toContain('"Stängning Bokio"')
  })
})
