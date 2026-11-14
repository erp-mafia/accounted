import { Invoice, Deadline } from '@/types'
import { isInvoiceOverdue as isCustomerInvoiceOverdue } from '@/lib/invoices/overdue'
import { isPastDue, todayIsoStockholm } from '@/lib/dates/iso'
import { isOpenDeadline } from '@/lib/deadlines/open'

// Parse ISO date string to Date object at start of day
export function parseDate(dateString: string): Date {
  const [year, month, day] = dateString.split('-').map(Number)
  return new Date(year, month - 1, day)
}

// Format date as ISO string (YYYY-MM-DD)
export function formatDateISO(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

// Get start of day
export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

// Check if date is before another
export function isBefore(date1: Date, date2: Date): boolean {
  return startOfDay(date1).getTime() < startOfDay(date2).getTime()
}

// Check if invoice is overdue
// The one overdue rule (lib/invoices/overdue.ts): an owed invoice past its
// due date with an open remainder, whatever its stored status.
export function isInvoiceOverdue(invoice: Invoice): boolean {
  return isCustomerInvoiceOverdue(invoice)
}

// Check if deadline is overdue
export function isDeadlineOverdue(deadline: Deadline): boolean {
  if (!isOpenDeadline(deadline)) return false
  return isPastDue(deadline.due_date, todayIsoStockholm())
}

// Swedish deadline type labels
export const DEADLINE_TYPE_LABELS: Record<string, string> = {
  delivery: 'Leverans',
  approval: 'Godkännande',
  invoicing: 'Fakturering',
  report: 'Rapport',
  revision: 'Revision',
  other: 'Övrigt'
}

// Swedish priority labels
export const PRIORITY_LABELS: Record<string, string> = {
  critical: 'Kritisk',
  important: 'Viktig',
  normal: 'Normal'
}
