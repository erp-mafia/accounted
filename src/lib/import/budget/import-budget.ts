/**
 * Importing a budget file into one budget (accounted#134, part 2): a SIE
 * file's #PBUDGET rows (the Fortnox migration's /sie/4 carries them) or an
 * Excel or CSV sheet, long or wide (read-file.ts reads them).
 *
 * Separate from the ledger import on purpose: a budget is planning data, not
 * räkenskapsinformation, so it needs none of the import job's machinery
 * (period holds, voucher numbering, undo). The whole file is one call of the
 * atomic grid save (upsert_budget_lines), so it lands completely or not at
 * all, and the dry run is the same call's preview: the preview the user
 * confirms is the save's own answer.
 *
 * What the file's rows become (planBudgetImport, pure):
 *   - accounts go through the SIE account mapper (account-mapper.ts) against
 *     the company's kontoplan, with the company's stored SIE mappings as
 *     overrides, so a Fortnox number the ledger import moved moves here too;
 *     an account the kontoplan does not have, or a balance account, is
 *     skipped and named;
 *   - a dimension object must exist in the registry, or the row is skipped
 *     and the object named (a budget line keeps the journal lines' tag
 *     contract, and an unknown code would be a tag no report can pick);
 *   - months outside the budget's year are skipped and counted (a SIE file
 *     carries every year's budget; #RAR names them);
 *   - the sign: SIE is debit positive; a sheet is read in the sign the user
 *     confirms, by default the one its class 3 rows suggest;
 *   - rows for the same cell (two source accounts mapped onto one) are added.
 */
import { roundOre } from '@/lib/money'
import { suggestMappings, type MappableAccount } from '@/lib/import/account-mapper'
import type { SIEAccountMappingRecord } from '@/lib/import/types'
import { detectEncoding, decodeBuffer } from '@/lib/import/sie-parser'
import { hasSIEFileExtension } from '@/lib/import/sie-file-extensions'
import { readBestSheetValues } from '@/lib/import/shared/workbook-reader'
import { loadMappings } from '@/lib/import/sie-import'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { isResultatkonto, isRevenueAccount, RESULTATKONTO_FIRST, RESULTATKONTO_LAST } from '@/lib/bookkeeping/bas-data/result-accounts'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import { BudgetFileError, readSieBudget, readSpreadsheetBudget, type BudgetFileFormat, type BudgetFileIssue, type BudgetFileRead } from './read-file'
import { fiscalYearMonths, monthOf } from '@/lib/budgets/months'
import { loadBudget, loadPeriod, saveLines, type BudgetSaveCounts } from '@/lib/budgets/service'
import type { BudgetImportSign, BudgetLineInput, ImportBudgetOptions } from '@/lib/budgets/schemas'

/** A budget file is small; 10 MB is a sheet of some 200 000 cells. */
export const BUDGET_IMPORT_MAX_BYTES = 10 * 1024 * 1024
const SPREADSHEET_EXTENSIONS = ['xlsx', 'xls', 'csv', 'ods']
/** Lists in the preview are capped: the counts carry the rest. */
const LIST_CAP = 50

export interface BudgetImportSummary {
  format: BudgetFileFormat
  /** The sign the amounts were read in. */
  sign: BudgetImportSign
  /** What the file's class 3 rows suggest (null for SIE, or without class 3 rows). */
  detected_sign: BudgetImportSign | null
  replace: boolean
  rows_read: number
  /** Non-zero cells the file gives the budget. */
  cells: number
  accounts: number
  /** Source accounts the mapper moved to another number. */
  mapped_accounts: { source: string; target: string }[]
  skipped: {
    /** Source accounts the kontoplan has no target for. */
    accounts_not_in_chart: string[]
    /** Balance accounts (1xxx-2xxx): a budget covers resultatkonton only. */
    balance_accounts: string[]
    /** Objects the dimension registry does not have. */
    unknown_objects: { dim_no: string; code: string }[]
    /** Rows of the skipped kinds above, together. */
    rows: number
    /** Rows for months outside the budget's year. */
    months_outside_year: number
    /** Rows the file has but that could not be read. */
    unreadable: BudgetFileIssue[]
    unreadable_count: number
  }
  /** SIE: the file's years (#RAR), so the preview can say which year it read. */
  file_years: { year_index: number; start: string; end: string }[]
  /** The budget per class and the result, in the resultatrapport's sign (revenue positive). */
  class_totals: { account_class: number; amount: number }[]
  result: number
  /**
   * The amounts read in this sign look turned around: revenue (class 3)
   * below zero, or costs (classes 4-7) above zero, in the resultatrapport's
   * sign. A sheet with revenue and costs both positive reads that way: the
   * preview says so before anything is saved.
   */
  sign_suspect: boolean
}

export interface BudgetImportPlan {
  /** SIE sign; for replace, the budget's other cells as 0. */
  lines: BudgetLineInput[]
  summary: BudgetImportSummary
}

const tagKey = (dims: Record<string, string>) =>
  JSON.stringify(Object.keys(dims).sort().map((k) => [k, dims[k]]))
const cellKey = (account: string, month: string, dims: Record<string, string>) => `${account}|${month}|${tagKey(dims)}`

/** Sign the class 3 rows suggest: revenue positive when they add up above zero. */
function detectSign(rows: { account: string; amount: number }[]): BudgetImportSign | null {
  const revenue = rows.filter((r) => isRevenueAccount(r.account))
  if (revenue.length === 0) return null
  const sum = revenue.reduce((s, r) => s + r.amount, 0)
  if (sum === 0) return null
  return sum > 0 ? 'revenue_positive' : 'debit_positive'
}

export function planBudgetImport(input: {
  read: BudgetFileRead
  /** The budget year's months, 'YYYY-MM'. */
  yearMonths: readonly string[]
  /** The company's kontoplan (every class: a balance account is recognised as one). */
  chart: readonly MappableAccount[]
  storedMappings?: SIEAccountMappingRecord[]
  /** Registry objects, 'dimNo|code'. */
  objects: ReadonlySet<string>
  sign?: BudgetImportSign
  replace?: boolean
  /** replace: the budget's current cells. */
  existing?: readonly { account_number: string; month: string; dimensions: Record<string, string> }[]
}): BudgetImportPlan {
  const { read } = input
  const detected = read.format === 'sie' ? null : detectSign(read.rows)
  const sign: BudgetImportSign = read.format === 'sie' ? 'debit_positive' : (input.sign ?? detected ?? 'debit_positive')
  const factor = sign === 'revenue_positive' ? -1 : 1

  // Accounts: the file's own numbers through the SIE mapper, against this
  // company's kontoplan (not the BAS reference: a budget line needs the
  // account to exist here).
  const sourceAccounts = [...new Set(read.rows.map((r) => r.account))].sort()
  const mappings = suggestMappings(
    sourceAccounts.map((number) => ({ number, name: read.accountNames.get(number) ?? '' })),
    [...input.chart],
    input.storedMappings,
  )
  const inChart = new Set(input.chart.map((a) => a.account_number))
  const target = new Map<string, string>()
  const notInChart: string[] = []
  const balance: string[] = []
  for (const m of mappings) {
    if (!m.targetAccount || !inChart.has(m.targetAccount)) notInChart.push(m.sourceAccount)
    else if (!isResultatkonto(m.targetAccount)) balance.push(m.sourceAccount)
    else target.set(m.sourceAccount, m.targetAccount)
  }

  const byCalendarMonth = new Map(input.yearMonths.map((m) => [m.slice(5, 7), m]))
  const inYear = new Set(input.yearMonths)
  const unknownObjects = new Map<string, { dim_no: string; code: string }>()
  const cells = new Map<string, BudgetLineInput>()
  let skippedRows = 0
  let outside = 0

  for (const row of read.rows) {
    const account = target.get(row.account)
    if (!account) {
      skippedRows++
      continue
    }
    const missing = Object.entries(row.dimensions).filter(([dimNo, code]) => !input.objects.has(`${dimNo}|${code}`))
    if (missing.length > 0) {
      for (const [dimNo, code] of missing) unknownObjects.set(`${dimNo}|${code}`, { dim_no: dimNo, code })
      skippedRows++
      continue
    }
    const month = row.month ?? byCalendarMonth.get(row.calendarMonth) ?? null
    if (!month || !inYear.has(month)) {
      outside++
      continue
    }
    const key = cellKey(account, month, row.dimensions)
    const amount = roundOre(row.amount * factor)
    const cell = cells.get(key)
    if (cell) cell.amount = roundOre(cell.amount + amount)
    else cells.set(key, { account_number: account, month, dimensions: row.dimensions, amount })
  }

  const written = [...cells.values()].filter((c) => c.amount !== 0)
  const lines: BudgetLineInput[] = [...written]
  // Replace clears what the file leaves out, but only when the file gives the
  // year something: a file whose rows were all skipped (another year, unknown
  // accounts) must refuse as empty, never wipe the budget.
  if (input.replace && written.length > 0) {
    const kept = new Set(written.map((c) => cellKey(c.account_number, c.month, c.dimensions ?? {})))
    for (const e of input.existing ?? []) {
      if (!kept.has(cellKey(e.account_number, e.month, e.dimensions))) {
        lines.push({ account_number: e.account_number, month: e.month, dimensions: e.dimensions, amount: 0 })
      }
    }
  }

  // The preview's figures, in the resultatrapport's sign.
  const byClass = new Map<number, number>()
  for (const c of written) {
    const k = Number(c.account_number[0])
    byClass.set(k, roundOre((byClass.get(k) ?? 0) - c.amount))
  }
  const classTotals = [...byClass.entries()]
    .sort(([a], [b]) => a - b)
    .map(([account_class, amount]) => ({ account_class, amount: amount === 0 ? 0 : amount }))

  return {
    lines,
    summary: {
      format: read.format,
      sign,
      detected_sign: detected,
      replace: input.replace === true,
      rows_read: read.rows.length,
      cells: written.length,
      accounts: new Set(written.map((c) => c.account_number)).size,
      mapped_accounts: [...target.entries()]
        .filter(([source, t]) => source !== t)
        .map(([source, t]) => ({ source, target: t }))
        .slice(0, LIST_CAP),
      skipped: {
        accounts_not_in_chart: notInChart.slice(0, LIST_CAP),
        balance_accounts: balance.slice(0, LIST_CAP),
        unknown_objects: [...unknownObjects.values()].slice(0, LIST_CAP),
        rows: skippedRows,
        months_outside_year: outside,
        unreadable: read.unreadable.slice(0, LIST_CAP),
        unreadable_count: read.unreadable.length,
      },
      file_years: read.years.map((y) => ({ year_index: y.yearIndex, start: y.start, end: y.end })),
      class_totals: classTotals,
      result: roundOre(classTotals.reduce((s, c) => s + c.amount, 0)),
      sign_suspect: (byClass.get(3) ?? 0) < 0 || [4, 5, 6, 7].reduce((s, k) => s + (byClass.get(k) ?? 0), 0) > 0,
    },
  }
}

/** The file's rows: a SIE file by its extension, a sheet otherwise. */
async function readBudgetFile(filename: string, bytes: ArrayBuffer): Promise<BudgetFileRead | Failure> {
  const ext = filename.toLowerCase().split('.').pop() ?? ''
  try {
    if (hasSIEFileExtension(filename)) {
      return readSieBudget(decodeBuffer(bytes, detectEncoding(bytes)))
    }
    if (SPREADSHEET_EXTENSIONS.includes(ext)) {
      const { rows } = await readBestSheetValues(bytes, filename)
      return readSpreadsheetBudget(rows)
    }
  } catch (error) {
    if (error instanceof BudgetFileError) return { ok: false, code: error.code, details: { filename } }
    return { ok: false, code: 'BUDGET_IMPORT_UNREADABLE', details: { filename } }
  }
  return { ok: false, code: 'BUDGET_IMPORT_UNSUPPORTED_FILE', details: { filename } }
}

type Failure = Extract<OperationOutcome<never>, { ok: false }>
const failed = (error: unknown): Failure => ({ ok: false, code: 'UNKNOWN_ERROR', error })

export type BudgetImportResult = BudgetSaveCounts & BudgetImportSummary

/**
 * Read `bytes` into the budget. The dry run answers the plan and the save's
 * preview counts and writes nothing; the real run saves the plan in one call.
 */
export async function importBudgetFile(
  ctx: OperationContext,
  input: { budget_id: string; filename: string; bytes: ArrayBuffer } & ImportBudgetOptions,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<BudgetImportResult>> {
  if (input.bytes.byteLength > BUDGET_IMPORT_MAX_BYTES) {
    return { ok: false, code: 'BUDGET_IMPORT_FILE_TOO_LARGE', details: { max_mb: BUDGET_IMPORT_MAX_BYTES / 1024 / 1024 } }
  }
  if (input.bytes.byteLength === 0) return { ok: false, code: 'BUDGET_IMPORT_UNREADABLE', details: { filename: input.filename } }

  const loaded = await loadBudget(ctx, input.budget_id)
  if ('failure' in loaded) return loaded.failure
  if (loaded.budget.archived_at) return { ok: false, code: 'BUDGET_ARCHIVED', details: { budget_id: input.budget_id } }
  const period = await loadPeriod(ctx, loaded.budget.fiscal_period_id)
  if ('failure' in period) return period.failure

  const read = await readBudgetFile(input.filename, input.bytes)
  if ('ok' in read) return read

  let chart: MappableAccount[]
  let storedMappings: SIEAccountMappingRecord[]
  let objects: Set<string>
  let existing: { account_number: string; month: string; dimensions: Record<string, string> }[] = []
  try {
    const [chartRows, mappings, dims, values] = await Promise.all([
      fetchAllRows<MappableAccount>(({ from, to }) =>
        ctx.supabase
          .from('chart_of_accounts')
          .select('account_number, account_name')
          .eq('company_id', ctx.companyId)
          .order('account_number')
          .range(from, to),
      ),
      loadMappings(ctx.supabase, ctx.companyId),
      fetchAllRows<{ id: string; sie_dim_no: number }>(({ from, to }) =>
        ctx.supabase.from('dimensions').select('id, sie_dim_no').eq('company_id', ctx.companyId).order('id').range(from, to),
      ),
      fetchAllRows<{ dimension_id: string; code: string }>(({ from, to }) =>
        ctx.supabase
          .from('dimension_values')
          .select('dimension_id, code')
          .eq('company_id', ctx.companyId)
          .order('id')
          .range(from, to),
      ),
    ])
    chart = chartRows
    storedMappings = mappings
    const dimNo = new Map(dims.map((d) => [d.id, String(d.sie_dim_no)]))
    objects = new Set(values.flatMap((v) => (dimNo.has(v.dimension_id) ? [`${dimNo.get(v.dimension_id)}|${v.code}`] : [])))
    if (input.replace) {
      const rows = await fetchAllRows<{ account_number: string; month: string; dimensions: Record<string, string> }>(({ from, to }) =>
        ctx.supabase
          .from('budget_lines')
          .select('account_number, month, dimensions')
          .eq('company_id', ctx.companyId)
          .eq('budget_id', input.budget_id)
          .gte('account_number', RESULTATKONTO_FIRST)
          .lte('account_number', RESULTATKONTO_LAST)
          .order('id')
          .range(from, to),
      )
      existing = rows.map((r) => ({ account_number: r.account_number, month: monthOf(r.month), dimensions: r.dimensions ?? {} }))
    }
  } catch (error) {
    ctx.log.error('budget import read failed', error as Error)
    return failed(error)
  }

  const plan = planBudgetImport({
    read,
    yearMonths: fiscalYearMonths(period.period.period_start, period.period.period_end),
    chart,
    storedMappings,
    objects,
    sign: input.sign,
    replace: input.replace,
    existing,
  })

  const noCounts: BudgetSaveCounts = { budget_id: input.budget_id, inserted: 0, updated: 0, deleted: 0, unchanged: 0 }
  if (plan.lines.length === 0) {
    // The preview still answers, so the user sees why nothing would be read.
    if (options.dryRun) return { ok: true, dryRun: true, preview: { ...noCounts, ...plan.summary } }
    return { ok: false, code: 'BUDGET_IMPORT_NOTHING_TO_IMPORT', details: { ...plan.summary } }
  }

  const saved = await saveLines(ctx, input.budget_id, plan.lines, options.dryRun === true)
  if ('failure' in saved) return saved.failure
  const result = { ...saved.counts, ...plan.summary }
  if (options.dryRun) return { ok: true, dryRun: true, preview: result }
  return { ok: true, data: result }
}
