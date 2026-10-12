import type { InvoiceStatus } from '@/types'
import { OVERDUE_CHIP, type StatusDisplay } from '@/lib/status-display'

/**
 * A customer invoice's status as every surface shows it: the invoice list
 * and detail, the customer page, the sales order and the transaction
 * invoice picker. Labels live in the `invoices` namespace.
 *
 * Sent and paid are the normal path and read as muted text; the rest
 * deviate and get a chip. The list and detail add what only they know (the
 * paid date, the days overdue, a collection case, a failed Peppol delivery)
 * on top of this.
 */
const INVOICE_STATUS_DISPLAY: Record<InvoiceStatus, StatusDisplay> = {
  draft: { labelKey: 'status_draft', chip: 'secondary' },
  sent: { labelKey: 'status_sent', chip: null },
  paid: { labelKey: 'status_paid', chip: null },
  partially_paid: { labelKey: 'status_partially_paid', chip: 'warning' },
  overdue: { labelKey: 'status_overdue', chip: OVERDUE_CHIP },
  cancelled: { labelKey: 'status_cancelled', chip: 'secondary' },
  credited: { labelKey: 'status_credited', chip: 'secondary' },
}

/** Null for a status this build does not know, so the caller can show the raw value. */
export function invoiceStatusDisplay(status: string): StatusDisplay | null {
  return INVOICE_STATUS_DISPLAY[status as InvoiceStatus] ?? null
}

export const INVOICE_STATUSES = Object.keys(INVOICE_STATUS_DISPLAY) as InvoiceStatus[]
