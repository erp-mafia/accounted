/**
 * The /budget page's grid model (accounted#134, part 2). Pure and safe in
 * the browser: no Supabase, no Zod.
 *
 * The grid shows and takes amounts in the resultatrapport's sign (revenue
 * positive, costs negative), so a figure typed here reads the same in the
 * report's Budget column, and a class subtotal and the result are plain sums.
 * The database keeps the SIE sign (debit positive, as #PBUDGET); the flip
 * happens here and nowhere else in the page: toResultSign on the way in,
 * changedCells on the way out.
 */
import { roundOre } from '@/lib/money'

export interface GridRow {
  account_number: string
  account_name: string | null
  /** One per month of the year, resultatrapport sign. */
  amounts: number[]
}

export interface GridGroup {
  account_class: number
  rows: GridRow[]
  subtotal: number[]
  total: number
}

export interface GridModel {
  groups: GridGroup[]
  /** The budgeted result per month: the sum of every row. */
  result: number[]
  resultTotal: number
}

/** A cell's key in the edits map. */
export const cellKey = (account: string, monthIndex: number) => `${account}|${monthIndex}`

/** SIE sign to the resultatrapport's, and back (the same flip): never -0. */
export function flipSign(amount: number): number {
  return amount === 0 ? 0 : -amount
}

/** The grid route's rows (SIE sign) as the page shows them. */
export function toResultSign(rows: readonly GridRow[]): GridRow[] {
  return rows.map((r) => ({ ...r, amounts: r.amounts.map(flipSign) }))
}

/**
 * The rows with the user's edits laid over them, plus accounts added in the
 * page (all months 0 until typed into), sorted by account number.
 */
export function withEdits(
  rows: readonly GridRow[],
  edits: ReadonlyMap<string, number>,
  added: readonly { account_number: string; account_name: string | null }[],
  monthCount: number,
): GridRow[] {
  const byAccount = new Map(rows.map((r) => [r.account_number, r]))
  for (const a of added) {
    if (!byAccount.has(a.account_number)) {
      byAccount.set(a.account_number, { ...a, amounts: Array.from({ length: monthCount }, () => 0) })
    }
  }
  return [...byAccount.values()]
    .map((r) => ({
      ...r,
      amounts: r.amounts.map((v, i) => edits.get(cellKey(r.account_number, i)) ?? v),
    }))
    .sort((a, b) => a.account_number.localeCompare(b.account_number))
}

/** Rows grouped by BAS class (3-8) with subtotals per month and the result. */
export function groupGrid(rows: readonly GridRow[], monthCount: number): GridModel {
  const sum = (list: readonly GridRow[]) =>
    Array.from({ length: monthCount }, (_, i) => roundOre(list.reduce((s, r) => s + (r.amounts[i] ?? 0), 0)))
  const groups: GridGroup[] = []
  for (const account_class of [3, 4, 5, 6, 7, 8]) {
    const inClass = rows.filter((r) => Number(r.account_number[0]) === account_class)
    if (inClass.length === 0) continue
    const subtotal = sum(inClass)
    groups.push({ account_class, rows: inClass, subtotal, total: roundOre(subtotal.reduce((s, v) => s + v, 0)) })
  }
  const result = sum(rows)
  return { groups, result, resultTotal: roundOre(result.reduce((s, v) => s + v, 0)) }
}

/** A row's yearly total. */
export function rowTotal(row: GridRow): number {
  return roundOre(row.amounts.reduce((s, v) => s + v, 0))
}

/**
 * The cells the save writes: every edited cell whose amount differs from the
 * one loaded, in the SIE sign, tagged with the grid's tag. A cell set to 0 is
 * sent as 0, which removes it.
 */
export function changedCells(
  rows: readonly GridRow[],
  edits: ReadonlyMap<string, number>,
  months: readonly string[],
  dimensions: Record<string, string>,
): { account_number: string; month: string; dimensions: Record<string, string>; amount: number }[] {
  const loaded = new Map(rows.map((r) => [r.account_number, r.amounts]))
  const out: { account_number: string; month: string; dimensions: Record<string, string>; amount: number }[] = []
  for (const [key, value] of edits) {
    const [account, index] = key.split('|') as [string, string]
    const i = Number(index)
    const before = loaded.get(account)?.[i] ?? 0
    const after = roundOre(value)
    if (after === roundOre(before) || months[i] === undefined) continue
    out.push({ account_number: account, month: months[i]!, dimensions, amount: flipSign(after) })
  }
  return out.sort((a, b) => a.account_number.localeCompare(b.account_number) || a.month.localeCompare(b.month))
}
