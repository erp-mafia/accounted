import { getDisplayTotal } from '@/lib/invoices/rounding'
import type { SupplierInvoice, SupplierInvoiceStatus } from '@/types'

// Mirrors lib/invoices/invoice-list-sort.ts: pure comparators over the values
// the list actually displays, Swedish collation for text, nulls always last,
// and a stable newest-date/id tie-break. Kept separate because the column set
// and status lifecycle differ from customer invoices.

export type SupplierInvoiceListSortColumn =
  | 'supplier'
  | 'number'
  | 'invoice_date'
  | 'due'
  | 'amount'
  | 'remaining'
  | 'status'
export type SupplierInvoiceListSortDirection = 'asc' | 'desc'

export interface SupplierInvoiceListSort {
  column: SupplierInvoiceListSortColumn
  direction: SupplierInvoiceListSortDirection
}

const swedishCollator = new Intl.Collator('sv', {
  numeric: true,
  sensitivity: 'base',
})

// Lifecycle order: waiting-for-attest first, then the payment queue, with
// exception and terminal states at the end.
const statusRank: Record<SupplierInvoiceStatus, number> = {
  registered: 0,
  approved: 1,
  partially_paid: 2,
  overdue: 3,
  disputed: 4,
  paid: 5,
  credited: 6,
  reversed: 7,
}

function displayedSupplier(invoice: SupplierInvoice): string | null {
  return invoice.supplier?.name || null
}

function displayedNumber(invoice: SupplierInvoice): string | null {
  return invoice.supplier_invoice_number || null
}

// The Belopp cell resolves öresavrundning from the per-invoice flag with the
// company fallback pinned off (supplier invoices never had a company-wide
// rounding setting); sorting must rank the same displayed value.
function displayedAmount(invoice: SupplierInvoice): number {
  return getDisplayTotal(
    { total: invoice.total, currency: invoice.currency, ore_rounding: invoice.ore_rounding },
    { ore_rounding: false },
  ).displayed
}

function compareNullable<T>(
  left: T | null,
  right: T | null,
  direction: SupplierInvoiceListSortDirection,
  compare: (a: T, b: T) => number,
): number {
  if (left === null) return right === null ? 0 : 1
  if (right === null) return -1
  const result = compare(left, right)
  return direction === 'asc' ? result : -result
}

function comparePrimary(
  left: SupplierInvoice,
  right: SupplierInvoice,
  sort: SupplierInvoiceListSort,
): number {
  const sign = sort.direction === 'asc' ? 1 : -1
  switch (sort.column) {
    case 'supplier':
      return compareNullable(
        displayedSupplier(left),
        displayedSupplier(right),
        sort.direction,
        swedishCollator.compare,
      )
    case 'number':
      return compareNullable(
        displayedNumber(left),
        displayedNumber(right),
        sort.direction,
        swedishCollator.compare,
      )
    case 'invoice_date':
      return sign * left.invoice_date.localeCompare(right.invoice_date)
    case 'due':
      return sign * left.due_date.localeCompare(right.due_date)
    case 'amount':
      return sign * (displayedAmount(left) - displayedAmount(right))
    case 'remaining':
      return sign * (left.remaining_amount - right.remaining_amount)
    case 'status':
      return sign * (statusRank[left.status] - statusRank[right.status])
  }
}

export function sortSupplierInvoiceList<T extends SupplierInvoice>(
  invoices: T[],
  sort: SupplierInvoiceListSort,
): T[] {
  return [...invoices].sort((left, right) => {
    const primary = comparePrimary(left, right, sort)
    if (primary !== 0) return primary

    const dateTieBreak = right.invoice_date.localeCompare(left.invoice_date)
    if (dateTieBreak !== 0) return dateTieBreak
    return left.id.localeCompare(right.id)
  })
}
