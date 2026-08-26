import { getDisplayTotal } from '@/lib/invoices/rounding'
import type { Invoice, InvoiceStatus } from '@/types'

export type InvoiceListSortColumn = 'number' | 'customer' | 'due' | 'amount' | 'status'
export type InvoiceListSortDirection = 'asc' | 'desc'

export interface InvoiceListSort {
  column: InvoiceListSortColumn
  direction: InvoiceListSortDirection
}

const swedishCollator = new Intl.Collator('sv', {
  numeric: true,
  sensitivity: 'base',
})

const statusRank: Record<InvoiceStatus, number> = {
  draft: 0,
  sent: 1,
  partially_paid: 2,
  overdue: 3,
  paid: 4,
  credited: 6,
  cancelled: 7,
}

function displayedNumber(invoice: Invoice): string | null {
  return invoice.invoice_number ?? invoice.external_invoice_number ?? null
}

function displayedCustomer(invoice: Invoice): string | null {
  return invoice.customer?.name ?? null
}

function displayedDueDate(invoice: Invoice): string | null {
  if (invoice.credited_invoice_id || invoice.status === 'draft') return null
  return invoice.due_date || null
}

function displayedStatusRank(invoice: Invoice): number {
  if (invoice.status === 'cancelled') return statusRank.cancelled
  if (invoice.status === 'paid') return statusRank.paid
  if (invoice.credited_invoice_id) return 5
  return statusRank[invoice.status]
}

function compareNullable<T>(
  left: T | null,
  right: T | null,
  direction: InvoiceListSortDirection,
  compare: (a: T, b: T) => number,
): number {
  if (left === null) return right === null ? 0 : 1
  if (right === null) return -1
  const result = compare(left, right)
  return direction === 'asc' ? result : -result
}

function comparePrimary(
  left: Invoice,
  right: Invoice,
  sort: InvoiceListSort,
  oreRounding: boolean,
): number {
  switch (sort.column) {
    case 'number':
      return compareNullable(
        displayedNumber(left),
        displayedNumber(right),
        sort.direction,
        swedishCollator.compare,
      )
    case 'customer':
      return compareNullable(
        displayedCustomer(left),
        displayedCustomer(right),
        sort.direction,
        swedishCollator.compare,
      )
    case 'due':
      return compareNullable(
        displayedDueDate(left),
        displayedDueDate(right),
        sort.direction,
        (a, b) => a.localeCompare(b),
      )
    case 'amount': {
      const leftTotal = getDisplayTotal(left, { ore_rounding: oreRounding }).displayed
      const rightTotal = getDisplayTotal(right, { ore_rounding: oreRounding }).displayed
      const result = leftTotal - rightTotal
      return sort.direction === 'asc' ? result : -result
    }
    case 'status': {
      const result = displayedStatusRank(left) - displayedStatusRank(right)
      return sort.direction === 'asc' ? result : -result
    }
  }
}

export function sortInvoiceList(
  invoices: Invoice[],
  sort: InvoiceListSort,
  oreRounding: boolean,
): Invoice[] {
  return [...invoices].sort((left, right) => {
    const primary = comparePrimary(left, right, sort, oreRounding)
    if (primary !== 0) return primary

    const dateTieBreak = right.invoice_date.localeCompare(left.invoice_date)
    if (dateTieBreak !== 0) return dateTieBreak
    return left.id.localeCompare(right.id)
  })
}
