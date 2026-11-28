/**
 * The supplier invoice side of a storno of its registration verifikat
 * (source_type supplier_invoice_registered).
 *
 * reverseEntry() (lib/bookkeeping/engine.ts) runs both functions through the
 * reversal hook list (lib/composition/reversal-hooks.ts). The invoice is the
 * one whose registration_journal_entry_id names the verifikat, never the one
 * its source_id names: a registration that was posted and never linked (the
 * create flow undoing a failed registration, Bokför losing its link race)
 * registers no invoice and reverses freely.
 *
 * Before the storno: refused while the invoice is credited. Its credit note's
 * verifikat took the purchase out of the ledger already, so a storno of the
 * registration would take it out a second time. The credit is undone first
 * with Ångra kreditering (uncreditSupplierInvoice, manage.ts), which reverses
 * the credit note's own verifikat (supplier_credit_note), never this one. A
 * credit note row rests at 'credited' too and can name a verifikat of its
 * own; it is not the invoice this check is about. Then refused while the
 * invoice has payments (a payment row, or a paid amount). They clear 2440
 * against the registration, so they are undone first.
 *
 * After the storno: the pointer is cleared. That is the state of an invoice
 * registered without its verifikat (defer_invoice_booking, #967), and the
 * state delete_last_voucher leaves when it deletes a registration verifikat
 * (the foreign key is ON DELETE SET NULL): the invoice reads not booked and
 * the Bokför step (book-service.ts) books it again. Its status is left as it
 * is.
 *
 * Kept free of engine imports so the engine can reach it through the
 * composition seam without a cycle.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  SupplierInvoiceRegistrationCreditedError,
  SupplierInvoiceRegistrationHasPaymentsError,
} from '@/lib/bookkeeping/errors'
import { createLogger } from '@/lib/logger'

const log = createLogger('supplier-invoices/registration-reversal')

/**
 * Throws SupplierInvoiceRegistrationCreditedError when the invoice the
 * verifikat registers is credited, and SupplierInvoiceRegistrationHasPaymentsError
 * when it has payments.
 */
export async function assertSupplierInvoiceRegistrationReversible(
  supabase: SupabaseClient,
  companyId: string,
  journalEntryId: string,
): Promise<void> {
  const { data, error } = await supabase
    .from('supplier_invoices')
    .select('id, paid_amount, status, is_credit_note')
    .eq('company_id', companyId)
    .eq('registration_journal_entry_id', journalEntryId)
  if (error) throw new Error(`supplier invoice registration: lookup by voucher failed: ${error.message}`)
  const invoices = (data ?? []) as Array<{
    id: string
    paid_amount: number | string | null
    status: string
    is_credit_note: boolean | null
  }>
  if (invoices.length === 0) return

  const credited = invoices.find((invoice) => invoice.status === 'credited' && invoice.is_credit_note !== true)
  if (credited) throw new SupplierInvoiceRegistrationCreditedError(credited.id)

  const paid = invoices.find((invoice) => Number(invoice.paid_amount ?? 0) > 0)
  if (paid) throw new SupplierInvoiceRegistrationHasPaymentsError(paid.id)

  const { data: payments, error: paymentsError } = await supabase
    .from('supplier_invoice_payments')
    .select('supplier_invoice_id')
    .eq('company_id', companyId)
    .in('supplier_invoice_id', invoices.map((invoice) => invoice.id))
    .limit(1)
  if (paymentsError) {
    throw new Error(`supplier invoice registration: payment lookup failed: ${paymentsError.message}`)
  }
  const payment = ((payments ?? []) as Array<{ supplier_invoice_id: string }>)[0]
  if (payment) throw new SupplierInvoiceRegistrationHasPaymentsError(payment.supplier_invoice_id)
}

/** Clears the registration pointer that names the reversed verifikat, so the invoice reads not booked. */
export async function releaseSupplierInvoiceRegistrationAfterReversal(
  supabase: SupabaseClient,
  companyId: string,
  journalEntryId: string,
): Promise<void> {
  const { error } = await supabase
    .from('supplier_invoices')
    .update({ registration_journal_entry_id: null })
    .eq('company_id', companyId)
    .eq('registration_journal_entry_id', journalEntryId)
  if (error) {
    // The storno stands (BFL); the invoice still reads booked against it
    // until the pointer is cleared by hand.
    log.error('supplier invoice registration not released after a storno', error as unknown as Error, {
      companyId,
      journalEntryId,
    })
  }
}
