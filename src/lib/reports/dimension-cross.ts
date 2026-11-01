import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre } from '@/lib/money'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { dbError } from '@/lib/errors/db-error'
import { isMissingRpcSignature } from '@/lib/bookkeeping/actor-rpc'
import { resultatrapportRows, signedAmount } from './resultatrapport'
import { defaultDimensionName, normalizeCode } from './dimension-pnl'
import { RESULTATKONTO_FIRST, RESULTATKONTO_LAST } from '@/lib/bookkeeping/result-account-ranges'
import { ACCOUNT_NUMBER_RE } from '@/lib/invariants'
import type { DimensionCrossLinesPage, DimensionCrossReport, DimensionCrossValue } from '@/types'

/**
 * Resultat across two dimensions (accounted#133): dimension A's values as
 * rows, dimension B's as columns, one amount per cell. "How much did region
 * Norr make through the web channel", where both are tags on the same line.
 *
 * Reconciliation is by construction, as in the per-dimension report: the
 * total is the resultatrapport's own rows and sign (resultatrapportRows and
 * signedAmount) over the measure's accounts, every tagged cell is the rounded
 * sum of the lines that carry its two tags, and the untagged x untagged cell
 * is the total less every other cell. The cells therefore sum to the
 * resultatrapport exactly, and swapping the axes transposes the matrix.
 *
 * The tagged pass is one SQL call, get_dimension_cross_buckets, over the same
 * entry set as get_dimension_pnl_buckets (no IB verifikat, no year-end chain),
 * read from ledger_tagset_days (migration 20261101121500).
 */

/** The whole result: classes 3 to 8. */
export const RESULT_ACCOUNTS = { from: RESULTATKONTO_FIRST, to: RESULTATKONTO_LAST } as const

const DIM_NO = /^[1-9]\d{0,3}$/

export interface DimensionCrossAxes {
  dimA: string
  dimB: string
  /** Inclusive account range inside 3000-8999; both or neither. Default: the whole result. */
  accountFrom?: string
  accountTo?: string
}

/**
 * The axes and the measure, checked the same way on every door (the dashboard
 * routes, v1 and MCP through the operations). Null when valid, else why not,
 * in Swedish (the report's error surface).
 */
export function dimensionCrossAxesError(axes: Partial<DimensionCrossAxes>): string | null {
  const { dimA, dimB, accountFrom, accountTo } = axes
  if (!dimA || !DIM_NO.test(dimA) || !dimB || !DIM_NO.test(dimB)) {
    return 'dim_a och dim_b måste vara SIE-dimensionsnummer.'
  }
  if (dimA === dimB) return 'dim_a och dim_b måste vara två olika dimensioner.'
  if ((accountFrom === undefined) !== (accountTo === undefined)) {
    return 'account_from och account_to anges tillsammans.'
  }
  if (accountFrom !== undefined && accountTo !== undefined) {
    if (!ACCOUNT_NUMBER_RE.test(accountFrom) || !ACCOUNT_NUMBER_RE.test(accountTo)) {
      return 'account_from och account_to måste vara fyrsiffriga kontonummer.'
    }
    if (accountFrom < RESULT_ACCOUNTS.from || accountTo > RESULT_ACCOUNTS.to) {
      return 'Kontointervallet måste ligga inom resultatkontona 3000-8999.'
    }
    if (accountFrom > accountTo) return 'account_from får inte vara efter account_to.'
  }
  return null
}

/** The RPCs are not in the database yet: the code shipped before its migration. */
export class DimensionCrossNotReadyError extends Error {
  readonly code = 'REPORT_NOT_READY'
  constructor() {
    super('The dimension cross report is not available in this database yet')
    this.name = 'DimensionCrossNotReadyError'
  }
}

export async function generateDimensionCross(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  options: DimensionCrossAxes & {
    // The resultatrapport's window, each bound defaulting to the period's.
    // Callers validate both against the period (parseReportDateRange).
    fromDate?: string
    toDate?: string
  },
): Promise<DimensionCrossReport> {
  // Every door validates, but the generator is exported: guard here too.
  const invalid = dimensionCrossAxesError(options)
  if (invalid) throw new Error(invalid)
  const { dimA, dimB } = options
  const ranged = options.accountFrom !== undefined && options.accountTo !== undefined
  const accounts = ranged ? { from: options.accountFrom!, to: options.accountTo! } : { ...RESULT_ACCOUNTS }

  const { data: period } = await supabase
    .from('fiscal_periods')
    .select('period_start, period_end')
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .single()
  if (!period) throw new Error('Fiscal period not found')

  const [pnlRows, bucketRows, registry] = await Promise.all([
    resultatrapportRows(supabase, companyId, fiscalPeriodId, { fromDate: options.fromDate, toDate: options.toDate }),
    fetchCrossBuckets(supabase, companyId, fiscalPeriodId, dimA, dimB, options),
    loadRegistry(supabase, companyId, [dimA, dimB]),
  ])

  // ── The total: the resultatrapport over the measure's accounts ──
  // Without a range every result row counts, exactly the rows the
  // resultatrapport sums; a range keeps the accounts inside it.
  const inScope = new Set<string>()
  let totalRaw = 0
  for (const row of pnlRows) {
    if (ranged && (row.account_number < accounts.from || row.account_number > accounts.to)) continue
    inScope.add(row.account_number)
    totalRaw += signedAmount(row)
  }
  const total = roundOre(totalRaw)

  // ── Tagged cells, codes trimmed and merged as the per-dimension report does ──
  const sums = new Map<string, number>()
  const codesA = new Set<string>()
  const codesB = new Set<string>()
  let untaggedRow = false
  let untaggedColumn = false
  for (const bucket of bucketRows) {
    if (!inScope.has(bucket.account_number)) continue
    const a = normalizeCode(bucket.code_a ?? undefined)
    const b = normalizeCode(bucket.code_b ?? undefined)
    // Neither tag after trimming: part of the untagged x untagged remainder.
    if (a === null && b === null) continue
    if (a === null) untaggedRow = true
    else codesA.add(a)
    if (b === null) untaggedColumn = true
    else codesB.add(b)
    const key = cellKey(a, b)
    sums.set(key, (sums.get(key) ?? 0) + (Number(bucket.credit) || 0) - (Number(bucket.debit) || 0))
  }

  const cellValues = new Map<string, number>()
  let taggedTotal = 0
  for (const [key, value] of sums) {
    const rounded = roundOre(value)
    cellValues.set(key, rounded)
    taggedTotal += rounded
  }
  const remainder = roundOre(total - taggedTotal)
  if (Math.abs(remainder) >= 0.005) {
    untaggedRow = true
    untaggedColumn = true
  }
  cellValues.set(cellKey(null, null), remainder)

  const byCode = (a: string, b: string) => a.localeCompare(b, 'sv')
  const rowCodes: Array<string | null> = [...[...codesA].sort(byCode), ...(untaggedRow ? [null] : [])]
  const columnCodes: Array<string | null> = [...[...codesB].sort(byCode), ...(untaggedColumn ? [null] : [])]

  const cells = rowCodes.map((a) => columnCodes.map((b) => cellValues.get(cellKey(a, b)) ?? 0))
  const rowTotals = cells.map((row) => roundOre(row.reduce((s, v) => s + v, 0)))
  const columnTotals = columnCodes.map((_, j) => roundOre(cells.reduce((s, row) => s + row[j], 0)))

  const value = (dim: string) => (code: string | null): DimensionCrossValue => ({
    code,
    name: code === null ? null : (registry.names.get(dim)?.get(code) ?? null),
  })

  return {
    dim_a: { sie_dim_no: dimA, name: registry.dimensionNames.get(dimA) ?? defaultDimensionName(dimA) },
    dim_b: { sie_dim_no: dimB, name: registry.dimensionNames.get(dimB) ?? defaultDimensionName(dimB) },
    accounts,
    rows: rowCodes.map(value(dimA)),
    columns: columnCodes.map(value(dimB)),
    cells,
    row_totals: rowTotals,
    column_totals: columnTotals,
    total,
    period: {
      start: options.fromDate ?? period.period_start,
      end: options.toDate ?? period.period_end,
    },
  }
}

/** What the cells sum, for the exports' header. Stays Swedish (report surface). */
export function dimensionCrossMeasureNote(report: Pick<DimensionCrossReport, 'accounts'>): string {
  const { from, to } = report.accounts
  return from === RESULT_ACCOUNTS.from && to === RESULT_ACCOUNTS.to
    ? 'Belopp: resultatet, konto 3000-8999'
    : `Belopp: konto ${from}-${to}`
}

function cellKey(a: string | null, b: string | null): string {
  // JSON keeps a null code apart from a code that reads "null".
  return JSON.stringify([a, b])
}

interface CrossBucket {
  account_number: string
  code_a: string | null
  code_b: string | null
  debit: number
  credit: number
}

async function fetchCrossBuckets(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  dimA: string,
  dimB: string,
  options: { fromDate?: string; toDate?: string },
): Promise<CrossBucket[]> {
  const { data, error } = await supabase.rpc('get_dimension_cross_buckets', {
    p_company_id: companyId,
    p_fiscal_period_id: fiscalPeriodId,
    p_dim_a: dimA,
    p_dim_b: dimB,
    p_from_date: options.fromDate ?? null,
    p_to_date: options.toDate ?? null,
  })
  if (error) {
    if (isMissingRpcSignature(error)) throw new DimensionCrossNotReadyError()
    throw dbError(error, 'get_dimension_cross_buckets failed')
  }
  return (Array.isArray(data) ? data : []) as CrossBucket[]
}

/** Registry names for the headers (read-only: never seeds). Archived values keep their names. */
async function loadRegistry(
  supabase: SupabaseClient,
  companyId: string,
  dims: string[],
): Promise<{ dimensionNames: Map<string, string>; names: Map<string, Map<string, string>> }> {
  const { data: dimRows } = await supabase
    .from('dimensions')
    .select('id, sie_dim_no, name')
    .eq('company_id', companyId)
    .in('sie_dim_no', dims.map(Number))
  const dimensionNames = new Map<string, string>()
  const names = new Map<string, Map<string, string>>()
  const dimByRowId = new Map<string, string>()
  for (const d of (dimRows ?? []) as Array<{ id: string; sie_dim_no: number; name: string }>) {
    dimensionNames.set(String(d.sie_dim_no), d.name)
    dimByRowId.set(d.id, String(d.sie_dim_no))
    names.set(String(d.sie_dim_no), new Map())
  }
  if (dimByRowId.size === 0) return { dimensionNames, names }
  const values = await fetchAllRows<{ dimension_id: string; code: string; name: string }>(({ from, to }) =>
    supabase
      .from('dimension_values')
      .select('dimension_id, code, name')
      .eq('company_id', companyId)
      .in('dimension_id', [...dimByRowId.keys()])
      .order('code', { ascending: true })
      .range(from, to),
  )
  for (const v of values) {
    const dim = dimByRowId.get(v.dimension_id)
    if (dim) names.get(dim)?.set(v.code, v.name)
  }
  return { dimensionNames, names }
}

// ─────────────────────────────────────────────────────────────────
// The lines behind one cell
// ─────────────────────────────────────────────────────────────────

export interface DimensionCrossCursor {
  date: string
  voucher_number: number
  line_id: string
}

export const DIMENSION_CROSS_LINES_PAGE = 200

/**
 * The lines one cell sums, a page at a time, in line order: the same entry
 * set and accounts as the cell, the codes compared trimmed, a null code the
 * untagged row or column. `next` continues the page.
 */
export async function fetchDimensionCrossLines(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  cell: DimensionCrossAxes & {
    codeA: string | null
    codeB: string | null
    fromDate?: string
    toDate?: string
    after?: DimensionCrossCursor
    limit?: number
  },
): Promise<DimensionCrossLinesPage> {
  const invalid = dimensionCrossAxesError(cell)
  if (invalid) throw new Error(invalid)
  const { data, error } = await supabase.rpc('get_dimension_cross_lines', {
    p_company_id: companyId,
    p_fiscal_period_id: fiscalPeriodId,
    p_dim_a: cell.dimA,
    p_code_a: normalizeCode(cell.codeA ?? undefined),
    p_dim_b: cell.dimB,
    p_code_b: normalizeCode(cell.codeB ?? undefined),
    p_account_from: cell.accountFrom ?? null,
    p_account_to: cell.accountTo ?? null,
    p_from_date: cell.fromDate ?? null,
    p_to_date: cell.toDate ?? null,
    p_after_date: cell.after?.date ?? null,
    p_after_voucher: cell.after?.voucher_number ?? null,
    p_after_line_id: cell.after?.line_id ?? null,
    p_limit: cell.limit ?? DIMENSION_CROSS_LINES_PAGE,
  })
  if (error) {
    if (isMissingRpcSignature(error)) throw new DimensionCrossNotReadyError()
    throw dbError(error, 'get_dimension_cross_lines failed')
  }
  const page = (data ?? { lines: [], has_more: false }) as Omit<DimensionCrossLinesPage, 'next'>
  const lines = (page.lines ?? []).map((l) => ({
    ...l,
    debit_amount: Number(l.debit_amount) || 0,
    credit_amount: Number(l.credit_amount) || 0,
  }))
  const last = lines[lines.length - 1]
  return {
    lines,
    has_more: page.has_more === true,
    next:
      page.has_more === true && last
        ? { after_date: last.entry_date, after_voucher: last.voucher_number, after_line: last.line_id }
        : null,
  }
}
