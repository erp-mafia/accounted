import type { SupplierInvoiceStatus } from '@/types'
import { OVERDUE_CHIP, type StatusDisplay } from '@/lib/status-display'

/**
 * A supplier invoice's status as every surface shows it: the supplier
 * invoice list and detail and the supplier page. Labels live in the
 * `supplier_invoices` namespace.
 *
 * Approved (attesterad) and paid are the normal flow and read as muted
 * text; registered is the "waiting for attest" outline chip, and the rest
 * deviate.
 */
const SUPPLIER_INVOICE_STATUS_DISPLAY: Record<SupplierInvoiceStatus, StatusDisplay> = {
  registered: { labelKey: 'status_registered', chip: 'outline' },
  approved: { labelKey: 'status_approved', chip: null },
  paid: { labelKey: 'status_paid', chip: null },
  partially_paid: { labelKey: 'status_partially_paid', chip: 'warning' },
  overdue: { labelKey: 'status_overdue', chip: OVERDUE_CHIP },
  disputed: { labelKey: 'status_disputed', chip: 'warning' },
  credited: { labelKey: 'status_credited', chip: 'secondary' },
  reversed: { labelKey: 'status_reversed', chip: 'secondary' },
}

/** Null for a status this build does not know, so the caller can show the raw value. */
export function supplierInvoiceStatusDisplay(status: string): StatusDisplay | null {
  return SUPPLIER_INVOICE_STATUS_DISPLAY[status as SupplierInvoiceStatus] ?? null
}

export const SUPPLIER_INVOICE_STATUSES = Object.keys(SUPPLIER_INVOICE_STATUS_DISPLAY) as SupplierInvoiceStatus[]
