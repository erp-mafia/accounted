/**
 * What a budget file's rows become in one budget (accounted#134, part 2):
 * planBudgetImport maps accounts through the SIE account mapper, checks the
 * objects against the registry, keeps the budget year's months, settles the
 * sign, adds rows for one cell, and for replace clears what the file leaves
 * out. importBudgetFile then saves the plan in one call of the grid save.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { planBudgetImport, importBudgetFile } from '../import-budget'
import type { BudgetFileRead, BudgetFileRow } from '../read-file'
import { createTableMockSupabase } from '@/tests/helpers'
import type { SIEAccountMappingRecord } from '@/lib/import/types'

const YEAR = ['2027-01', '2027-02', '2027-03', '2027-04', '2027-05', '2027-06', '2027-07', '2027-08', '2027-09', '2027-10', '2027-11', '2027-12']
const CHART = [
  { account_number: '1930', account_name: 'Företagskonto' },
  { account_number: '3010', account_name: 'Försäljning' },
  { account_number: '3041', account_name: 'Försäljning tjänst' },
  { account_number: '5010', account_name: 'Lokalhyra' },
]

function row(over: Partial<BudgetFileRow>): BudgetFileRow {
  return { account: '3010', month: '2027-01', calendarMonth: '01', dimensions: {}, amount: -1000, line: 1, ...over }
}

function read(rows: BudgetFileRow[], format: BudgetFileRead['format'] = 'sie'): BudgetFileRead {
  return { format, rows, unreadable: [], accountNames: new Map(), years: [] }
}

describe('planBudgetImport', () => {
  it('keeps a SIE file\'s sign and the year\'s months, and counts the other years', () => {
    const plan = planBudgetImport({
      read: read([row({}), row({ account: '5010', month: '2027-02', amount: 400 }), row({ month: '2026-12', amount: -900 })]),
      yearMonths: YEAR,
      chart: CHART,
      objects: new Set(),
    })
    expect(plan.lines).toEqual([
      { account_number: '3010', month: '2027-01', dimensions: {}, amount: -1000 },
      { account_number: '5010', month: '2027-02', dimensions: {}, amount: 400 },
    ])
    expect(plan.summary).toMatchObject({
      format: 'sie',
      sign: 'debit_positive',
      detected_sign: null,
      cells: 2,
      accounts: 2,
      skipped: { months_outside_year: 1, rows: 0 },
      // Resultatrapport sign: revenue positive.
      class_totals: [
        { account_class: 3, amount: 1000 },
        { account_class: 5, amount: -400 },
      ],
      result: 600,
      sign_suspect: false,
    })
  })

  it('maps accounts through the stored SIE mappings and adds rows that land on one cell', () => {
    const stored = [
      { source_account: '3011', target_account: '3010', source_name: 'Fortnox 3011', confidence: 1, match_type: 'manual' },
    ] as unknown as SIEAccountMappingRecord[]
    const plan = planBudgetImport({
      read: read([row({ account: '3011', amount: -300 }), row({ amount: -700 })]),
      yearMonths: YEAR,
      chart: CHART,
      storedMappings: stored,
      objects: new Set(),
    })
    expect(plan.lines).toEqual([{ account_number: '3010', month: '2027-01', dimensions: {}, amount: -1000 }])
    expect(plan.summary.mapped_accounts).toEqual([{ source: '3011', target: '3010' }])
  })

  it('skips and names an account the kontoplan lacks, a balance account and an unknown object', () => {
    const plan = planBudgetImport({
      read: read([
        row({ account: '3999' }),
        row({ account: '1930', amount: 5 }),
        row({ dimensions: { '6': 'H9' } }),
        row({ dimensions: { '6': 'H1' }, amount: -50 }),
      ]),
      yearMonths: YEAR,
      chart: CHART,
      objects: new Set(['6|H1']),
    })
    expect(plan.lines).toEqual([{ account_number: '3010', month: '2027-01', dimensions: { '6': 'H1' }, amount: -50 }])
    expect(plan.summary.skipped).toMatchObject({
      accounts_not_in_chart: ['3999'],
      balance_accounts: ['1930'],
      unknown_objects: [{ dim_no: '6', code: 'H9' }],
      rows: 3,
    })
  })

  it('reads a sheet with revenue positive in the resultatrapport sign, and month names into the budget year', () => {
    const plan = planBudgetImport({
      read: read(
        [
          row({ month: null, calendarMonth: '03', amount: 1000 }),
          row({ account: '5010', month: null, calendarMonth: '03', amount: -400 }),
        ],
        'wide',
      ),
      yearMonths: YEAR,
      chart: CHART,
      objects: new Set(),
    })
    expect(plan.summary.detected_sign).toBe('revenue_positive')
    expect(plan.lines).toEqual([
      { account_number: '3010', month: '2027-03', dimensions: {}, amount: -1000 },
      { account_number: '5010', month: '2027-03', dimensions: {}, amount: 400 },
    ])
    expect(plan.summary.sign_suspect).toBe(false)
  })

  it('flags a sheet whose costs read as revenue (both positive)', () => {
    const plan = planBudgetImport({
      read: read([row({ amount: 1000 }), row({ account: '5010', amount: 400 })], 'long'),
      yearMonths: YEAR,
      chart: CHART,
      objects: new Set(),
    })
    expect(plan.summary.sign).toBe('revenue_positive')
    expect(plan.summary.sign_suspect).toBe(true)
    // The user's choice wins over the detection.
    const asSie = planBudgetImport({
      read: read([row({ amount: 1000 }), row({ account: '5010', amount: 400 })], 'long'),
      yearMonths: YEAR,
      chart: CHART,
      objects: new Set(),
      sign: 'debit_positive',
    })
    expect(asSie.lines.map((l) => l.amount)).toEqual([1000, 400])
  })

  it('replace clears the budget\'s cells the file leaves out', () => {
    const plan = planBudgetImport({
      read: read([row({})]),
      yearMonths: YEAR,
      chart: CHART,
      objects: new Set(),
      replace: true,
      existing: [
        { account_number: '3010', month: '2027-01', dimensions: {} },
        { account_number: '5010', month: '2027-04', dimensions: { '6': 'H1' } },
      ],
    })
    expect(plan.lines).toEqual([
      { account_number: '3010', month: '2027-01', dimensions: {}, amount: -1000 },
      { account_number: '5010', month: '2027-04', dimensions: { '6': 'H1' }, amount: 0 },
    ])
    expect(plan.summary.cells).toBe(1)
  })

  it('replace never wipes the budget when the file gives the year nothing', () => {
    const plan = planBudgetImport({
      read: read([row({ month: '2026-12' })]),
      yearMonths: YEAR,
      chart: CHART,
      objects: new Set(),
      replace: true,
      existing: [{ account_number: '3010', month: '2027-01', dimensions: {} }],
    })
    expect(plan.lines).toEqual([])
  })
})

describe('importBudgetFile', () => {
  const BUDGET = {
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    fiscal_period_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    name: 'Budget 2027',
    is_default: true,
    archived_at: null,
    created_at: '',
    updated_at: '',
  }
  const PERIOD = { id: BUDGET.fiscal_period_id, name: '2027', period_start: '2027-01-01', period_end: '2027-12-31', previous_period_id: null }
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() }
  const SIE = new TextEncoder().encode('#SIETYP 4\n#RAR 0 20270101 20271231\n#PBUDGET 0 202701 3010 {} -1000\n').buffer as ArrayBuffer

  function client(extra: Record<string, unknown> = {}) {
    return createTableMockSupabase({
      budgets: { data: BUDGET, error: null },
      fiscal_periods: { data: PERIOD, error: null },
      chart_of_accounts: { data: CHART, error: null },
      sie_account_mappings: { data: [], error: null },
      dimensions: { data: [], error: null },
      dimension_values: { data: [], error: null },
      ...extra,
    })
  }

  beforeEach(() => vi.clearAllMocks())

  it('previews through the save\'s own dry run and writes nothing', async () => {
    const mock = client({
      'rpc:upsert_budget_lines_preview': { data: { ok: true, inserted: 1, updated: 0, deleted: 0, unchanged: 0 }, error: null },
    })
    const ctx = { supabase: mock.supabase, companyId: 'c1', userId: 'u1', log } as never
    const outcome = await importBudgetFile(ctx, { budget_id: BUDGET.id, filename: 'fortnox.se', bytes: SIE }, { dryRun: true })
    expect(outcome).toMatchObject({ ok: true, dryRun: true, preview: { inserted: 1, format: 'sie', cells: 1 } })
    expect(mock.calls.some((c) => c.table === 'rpc:upsert_budget_lines')).toBe(false)
    expect(mock.findCall('rpc:upsert_budget_lines_preview', 'rpc')?.[0]).toEqual({
      p_budget_id: BUDGET.id,
      p_lines: [{ account_number: '3010', month: '2027-01-01', dimensions: {}, amount: -1000 }],
    })
  })

  it('refuses an archived budget, an unknown file type and a file with nothing for the year', async () => {
    const archived = client({ budgets: { data: { ...BUDGET, archived_at: '2027-02-01T00:00:00Z' }, error: null } })
    expect(
      await importBudgetFile({ supabase: archived.supabase, companyId: 'c1', userId: 'u1', log } as never, { budget_id: BUDGET.id, filename: 'b.se', bytes: SIE }),
    ).toMatchObject({ ok: false, code: 'BUDGET_ARCHIVED' })

    const ctx = { supabase: client().supabase, companyId: 'c1', userId: 'u1', log } as never
    expect(await importBudgetFile(ctx, { budget_id: BUDGET.id, filename: 'budget.pdf', bytes: SIE })).toMatchObject({
      ok: false,
      code: 'BUDGET_IMPORT_UNSUPPORTED_FILE',
    })
    const otherYear = new TextEncoder().encode('#SIETYP 4\n#PBUDGET 0 202601 3010 {} -1000\n').buffer as ArrayBuffer
    expect(await importBudgetFile(ctx, { budget_id: BUDGET.id, filename: 'b.se', bytes: otherYear })).toMatchObject({
      ok: false,
      code: 'BUDGET_IMPORT_NOTHING_TO_IMPORT',
      details: { skipped: { months_outside_year: 1 } },
    })
  })
})
