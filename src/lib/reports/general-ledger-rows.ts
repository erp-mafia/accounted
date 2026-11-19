import { equalOre, sumOre } from '@/lib/money'
import { readVerifikatSearch, type VerifikatSearch } from '@/lib/bookkeeping/verifikat-search'

/**
 * One account's huvudbok rows in another order, or narrowed by a search.
 *
 * The rows arrive in ledger order (bokföringsdatum, verifikat number, line),
 * each with the account's balance after it. This module only reorders and
 * filters them: no amount and no balance is computed here, so a row carries
 * the same numbers in every arrangement. Pure and client-safe: the huvudbok
 * view arranges the rows it already holds with it, and the lines route
 * arranges an account that is read a page at a time, so both give the same
 * rows for the same sort and search.
 */

/** What the arrangement reads of a huvudbok line. */
export interface LedgerRow {
  date: string
  voucher_series: string
  voucher_number: number
  description: string
  debit: number
  credit: number
}

export type LedgerRowSortColumn = 'date' | 'voucher' | 'debit' | 'credit'

export interface LedgerRowSort {
  column: LedgerRowSortColumn
  ascending: boolean
}

/** Ledger order: oldest first, the order the running balance runs in. */
export const LEDGER_ROW_ORDER: LedgerRowSort = { column: 'date', ascending: true }

const SORT_TOKEN_RE = /^(date|voucher|debit|credit)_(asc|desc)$/

/** 'date_desc' as a sort, or null when the token names none. */
export function parseLedgerRowSort(token: string | null | undefined): LedgerRowSort | null {
  const match = SORT_TOKEN_RE.exec(token ?? '')
  return match ? { column: match[1] as LedgerRowSortColumn, ascending: match[2] === 'asc' } : null
}

export function ledgerRowSortToken(sort: LedgerRowSort): string {
  return `${sort.column}_${sort.ascending ? 'asc' : 'desc'}`
}

export function isLedgerRowOrder(sort: LedgerRowSort): boolean {
  return sort.column === LEDGER_ROW_ORDER.column && sort.ascending === LEDGER_ROW_ORDER.ascending
}

/**
 * Whether the rows' balances read as a running balance in this arrangement:
 * in date order, either direction (newest first is ledger order backwards, so
 * each row still shows the balance after it), with every row present. Sorted
 * on anything else, or narrowed by a search, the balance of one row says
 * nothing about the row beside it.
 */
export function ledgerBalanceRuns(sort: LedgerRowSort, search: string | null | undefined): boolean {
  return sort.column === 'date' && !search?.trim()
}

/**
 * True when a row is what the search asks for: its text holds the needle, or
 * the needle is its verifikat's label ("A71"), its debit or credit amount
 * ("12 500 kr") or its bokföringsdatum ("2026-03-15", "2026-03"). The same
 * reading of the needle as the verifikat list's search (readVerifikatSearch).
 */
export function matchesLedgerRowSearch(
  row: LedgerRow,
  search: string,
  needle: VerifikatSearch = readVerifikatSearch(search),
): boolean {
  const text = search.trim().toLocaleLowerCase('sv-SE')
  if (row.description.toLocaleLowerCase('sv-SE').includes(text)) return true
  if (
    needle.voucher &&
    row.voucher_number === needle.voucher.number &&
    row.voucher_series.toUpperCase() === needle.voucher.series
  ) {
    return true
  }
  if (needle.amount !== null && (equalOre(row.debit, needle.amount) || equalOre(row.credit, needle.amount))) {
    return true
  }
  return needle.dates !== null && row.date >= needle.dates.from && row.date <= needle.dates.to
}

function compareVoucher(a: LedgerRow, b: LedgerRow): number {
  if (a.voucher_series !== b.voucher_series) return a.voucher_series < b.voucher_series ? -1 : 1
  return a.voucher_number - b.voucher_number
}

/**
 * Rows sorted on one side's amount. A row with nothing on that side has an
 * empty cell there, and empty cells go last in both directions, in ledger
 * order: smallest first then starts at the smallest amount, not at the rows
 * of the other side. Equal amounts keep their ledger order in both
 * directions: the sort is stable and the direction sits in the comparator.
 */
function sortBySide<T extends LedgerRow>(rows: readonly T[], side: 'debit' | 'credit', ascending: boolean): T[] {
  const filled = rows.filter((row) => row[side] > 0)
  const empty = rows.filter((row) => !(row[side] > 0))
  filled.sort((a, b) => (ascending ? a[side] - b[side] : b[side] - a[side]))
  return [...filled, ...empty]
}

function sortLedgerRows<T extends LedgerRow>(rows: readonly T[], sort: LedgerRowSort): T[] {
  switch (sort.column) {
    case 'date':
      // The rows come in ledger order. Newest first is that order backwards,
      // ties included (the verifikat of one day, the lines of one verifikat):
      // it is the one other order the balance is shown in, and only the exact
      // reverse reads as a running balance, each row's balance less its own
      // movement being the balance of the row under it.
      return sort.ascending ? [...rows] : [...rows].reverse()
    case 'voucher': {
      // Stable, with the direction in the comparator and not in a reverse():
      // the lines of one verifikat keep their ledger order whichever way the
      // verifikat run.
      const direction = sort.ascending ? 1 : -1
      return [...rows].sort((a, b) => direction * compareVoucher(a, b))
    }
    case 'debit':
    case 'credit':
      return sortBySide(rows, sort.column, sort.ascending)
  }
}

export interface ArrangedLedgerRows<T> {
  rows: T[]
  /**
   * With a search: the debit and credit of the rows it found. Null without
   * one: the account's own totals describe every row.
   */
  matched: { debit: number; credit: number } | null
}

/** `rows` (in ledger order) narrowed by `search` and put in `sort` order. */
export function arrangeLedgerRows<T extends LedgerRow>(
  rows: readonly T[],
  view: { sort?: LedgerRowSort | null; search?: string | null },
): ArrangedLedgerRows<T> {
  const search = view.search?.trim() ?? ''
  const sort = view.sort ?? LEDGER_ROW_ORDER
  if (!search) return { rows: sortLedgerRows(rows, sort), matched: null }
  const needle = readVerifikatSearch(search)
  const found = rows.filter((row) => matchesLedgerRowSearch(row, search, needle))
  return {
    rows: sortLedgerRows(found, sort),
    matched: {
      debit: sumOre(found.map((row) => row.debit)),
      credit: sumOre(found.map((row) => row.credit)),
    },
  }
}
