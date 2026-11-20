/**
 * `invoice.sent`, emitted the same way by every door that issues an invoice
 * (the dashboard and v1 sends, mark-sent, an approved agent send, Peppol and
 * the recurring run).
 *
 * The event carries the invoice as the door holds it, at status 'sent', with
 * the payment reference its PDF prints (crm#1886): `payment_reference` and
 * `payment_reference_type`, read through withPaymentReference, the
 * projection the v1 and MCP invoice reads use. So a webhook receiver that
 * delivers the invoice itself gets the reference with the event, and it is
 * the one GET /invoices/{id} answers. Each door built the payload by hand
 * before, from the row it happened to hold, so no field could be added to
 * all of them in one place.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { eventBus } from '@/lib/events'
import { withPaymentReference } from '@/lib/invoices/payment-reference-fields'
import type { Logger } from '@/lib/logger'
import type { CompanySettings, Invoice } from '@/types'

export async function emitInvoiceSent(args: {
  supabase: SupabaseClient
  companyId: string
  userId: string
  /** The issued invoice, with whatever the door has joined onto it. */
  invoice: Invoice
  /** The company's settings row the door issued and rendered the invoice with. */
  settings: CompanySettings
  log: Logger
}): Promise<void> {
  const { supabase, companyId, userId, settings, log } = args
  let invoice: Invoice = { ...args.invoice, status: 'sent' }
  try {
    ;[invoice] = await withPaymentReference(supabase, companyId, [invoice], { company: settings })
  } catch (error) {
    // The invoice is issued either way, so the event still goes out, without
    // the two fields: absent says "not read", where null would say the
    // invoice has no reference.
    log.warn('invoice.sent is emitted without payment_reference: it could not be read', error)
  }
  await eventBus.emit({ type: 'invoice.sent', payload: { invoice, companyId, userId } })
}
