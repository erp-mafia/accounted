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

/**
 * A company without an attest step (kontantmetoden, or no attest policy on,
 * see companyAttestsSupplierInvoices) leaves every unpaid invoice on
 * 'registered', so the "waiting for attest" chip would sit on every open
 * row. There registered is the normal state and reads as muted "Att betala".
 */
const REGISTERED_WITHOUT_ATTEST: StatusDisplay = { labelKey: 'status_registered_to_pay', chip: null }

export interface SupplierInvoiceStatusDisplayOptions {
  /**
   * Whether the company attests supplier invoices
   * (companyAttestsSupplierInvoices). Defaults to true: the chip stays where
   * attest is the real gate.
   */
  attests?: boolean
}

/** Null for a status this build does not know, so the caller can show the raw value. */
export function supplierInvoiceStatusDisplay(
  status: string,
  options: SupplierInvoiceStatusDisplayOptions = {},
): StatusDisplay | null {
  if (status === 'registered' && options.attests === false) return REGISTERED_WITHOUT_ATTEST
  return SUPPLIER_INVOICE_STATUS_DISPLAY[status as SupplierInvoiceStatus] ?? null
}

export const SUPPLIER_INVOICE_STATUSES = Object.keys(SUPPLIER_INVOICE_STATUS_DISPLAY) as SupplierInvoiceStatus[]
