import type { ReconciliationItem } from './schemas'

/**
 * Sorting for the manual match view's two tables.
 *
 * Pure and separate from the component because both tables share it and the
 * matching flow is unforgiving: picking the wrong row books money against the
 * wrong verifikat, so the ordering that leads the eye is worth testing.
 *
 * Not a general table sort. The ledger side has a voucher column the bank side
 * does not, so a column that does not apply simply leaves the order untouched
 * rather than throwing.
 */
export type ReconSortColumn = 'date' | 'voucher' | 'description' | 'amount'
export type ReconSortDirection = 'asc' | 'desc'

export interface ReconSort {
  column: ReconSortColumn
  direction: ReconSortDirection
}

/** Newest first: an unreconciled row is usually a recent one. */
export const DEFAULT_RECON_SORT: ReconSort = { column: 'date', direction: 'desc' }

const collator = new Intl.Collator('sv', { numeric: true, sensitivity: 'base' })

/**
 * Rows with nothing in the sorted column go last, in BOTH directions.
 *
 * This has to be decided before the direction factor is applied, not inside
 * the comparator: multiplying it by -1 is exactly what would float the empty
 * rows to the top on a descending sort, pushing the real ones out of view.
 * Returns null when the rule does not apply and normal comparison should run.
 */
function emptyLast(
  a: ReconciliationItem,
  b: ReconciliationItem,
  column: ReconSortColumn,
): number | null {
  if (column !== 'voucher') return null
  const aHas = a.voucher_number != null
  const bHas = b.voucher_number != null
  if (aHas === bHas) return null
  return aHas ? -1 : 1
}

/** Vouchers sort by series then number, not as text: 'A9' before 'A10'. */
function compareVoucher(a: ReconciliationItem, b: ReconciliationItem): number {
  const series = collator.compare(a.voucher_series ?? '', b.voucher_series ?? '')
  if (series !== 0) return series
  return (a.voucher_number ?? 0) - (b.voucher_number ?? 0)
}

function compare(a: ReconciliationItem, b: ReconciliationItem, column: ReconSortColumn): number {
  switch (column) {
    case 'date':
      // ISO dates, so a plain string compare is chronological.
      return a.date.localeCompare(b.date)
    case 'voucher':
      return compareVoucher(a, b)
    case 'description':
      return collator.compare(a.description, b.description)
    case 'amount':
      // Signed: an outgoing -103 001 sorts below an incoming 35. Matching is
      // about finding a counterpart with the opposite sign, so keeping the
      // sign visible in the order is what makes the two tables line up.
      return a.amount - b.amount
  }
}

/**
 * Returns a new array; never mutates. The tie-break on item_id keeps the order
 * stable across refetches, so a row does not jump under the cursor between two
 * renders that both sort by the same column.
 */
export function sortReconciliationItems(
  items: ReconciliationItem[],
  sort: ReconSort,
): ReconciliationItem[] {
  const factor = sort.direction === 'asc' ? 1 : -1
  return [...items].sort((a, b) => {
    // Deliberately before the factor: see emptyLast.
    const empty = emptyLast(a, b, sort.column)
    if (empty !== null) return empty
    const primary = compare(a, b, sort.column)
    if (primary !== 0) return primary * factor
    return a.item_id.localeCompare(b.item_id)
  })
}

/**
 * Header click: a new column starts ascending, except amount and date, where
 * the useful first look is the largest or the most recent. Clicking the active
 * column flips it.
 */
export function nextReconSort(current: ReconSort, column: ReconSortColumn): ReconSort {
  if (current.column === column) {
    return { column, direction: current.direction === 'asc' ? 'desc' : 'asc' }
  }
  return { column, direction: column === 'amount' || column === 'date' ? 'desc' : 'asc' }
}
