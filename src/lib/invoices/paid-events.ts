import { eventBus } from '@/lib/events/bus'
import { createLogger } from '@/lib/logger'
import type { Invoice, SupplierInvoice } from '@/types'

const log = createLogger('invoice-paid-events')

/**
 * The one door for the public `invoice.paid` and `supplier_invoice.paid`
 * events, whose contract is "the invoice is now fully paid"
 * (lib/webhooks/public-events.ts).
 *
 * Every settlement path calls it right after the write that moved the
 * invoice, passing the status THAT write set:
 *   - "Markera som betald" (dashboard, v1, MCP) and the Stripe sync,
 *   - the bank match (dashboard, v1, MCP), the batch allocation (dashboard,
 *     v1, MCP), the link to an existing voucher and the link of a bank
 *     transaction to an existing verifikat.
 *
 * The settling write is always guarded on a payable status: a CAS update
 * `.in('status', [...payable])`, or an RPC that locks the row and re-checks
 * it. Only one write can win that guard and move the invoice to 'paid', so
 * the event fires exactly once per transition to fully paid, and never for
 * a partial payment ('partially_paid').
 *
 * Before this existed only the mark-paid doors emitted (on partials too),
 * while every bank-match door emitted `*.match_confirmed` alone, so an
 * integration subscribed to invoice.paid never heard about an invoice settled
 * by a bank match: the common case.
 *
 * Best-effort: the payment has already committed, so an emit failure is
 * logged and returned as 'emit_failed', never thrown. A caller that surfaces
 * warnings (v1 mark-paid) maps that outcome to its own warning.
 */
export type PaidEventOutcome = 'emitted' | 'not_fully_paid' | 'emit_failed'

export interface InvoicePaidEventParams {
  /** The status the settling write just set on the invoice. */
  newStatus: string
  /** The invoice as it stands after the write (status, paid/remaining, paid_at). */
  invoice: Invoice
  /** The amount this payment applied to the invoice, in the invoice currency. */
  paymentAmount: number
  /** Payment date (YYYY-MM-DD). */
  paymentDate: string
  userId: string
  companyId: string
}

export async function emitInvoicePaidIfSettled(
  params: InvoicePaidEventParams,
): Promise<PaidEventOutcome> {
  const { newStatus, invoice, paymentAmount, paymentDate, userId, companyId } = params
  if (newStatus !== 'paid') return 'not_fully_paid'
  try {
    await eventBus.emit({
      type: 'invoice.paid',
      payload: { invoice, paymentAmount, paymentDate, userId, companyId },
    })
    return 'emitted'
  } catch (err) {
    log.warn('invoice.paid emit failed', err as Error, { companyId, invoiceId: invoice.id })
    return 'emit_failed'
  }
}

export interface SupplierInvoicePaidEventParams {
  /** The status the settling write just set on the supplier invoice. */
  newStatus: string
  /** The supplier invoice as it stands after the write. */
  supplierInvoice: SupplierInvoice
  /** The amount this payment applied to the invoice, in the invoice currency. */
  paymentAmount: number
  userId: string
  companyId: string
}

export async function emitSupplierInvoicePaidIfSettled(
  params: SupplierInvoicePaidEventParams,
): Promise<PaidEventOutcome> {
  const { newStatus, supplierInvoice, paymentAmount, userId, companyId } = params
  if (newStatus !== 'paid') return 'not_fully_paid'
  try {
    await eventBus.emit({
      type: 'supplier_invoice.paid',
      payload: { supplierInvoice, paymentAmount, userId, companyId },
    })
    return 'emitted'
  } catch (err) {
    log.warn('supplier_invoice.paid emit failed', err as Error, {
      companyId,
      supplierInvoiceId: supplierInvoice.id,
    })
    return 'emit_failed'
  }
}
