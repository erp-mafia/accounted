/**
 * The bank payment that will pay a supplier invoice unless someone cancels
 * it: an order signed, or being signed, with BankID
 * (SIGNED_PAYMENT_ORDER_STATUSES).
 *
 * While one exists, every door that settles or closes the invoice some other
 * way pays the supplier twice, because the bank still executes the signed
 * order: mark paid, the link to an existing verifikat (the Befintlig
 * verifikation tab sits beside mark paid in the same dialog), the credit, and
 * marking the invoice as typed into the internet bank by hand. All refuse with
 * SI_BANK_PAYMENT_UNDER_WAY, and the way out is to cancel the bank payment
 * under Betalningar first (crm#1243). Once the money has left, the bank refuses
 * that cancel: the way out is then the match to the bank row, or the status sync
 * moving the order to executed. A kvittning asks a wider question of its own
 * (paymentInFlightSupplierInvoiceIds).
 *
 * Deliberately not refused:
 *   - the bank row itself: a match to a bank row, one invoice or a
 *     samlingsbetalning, IS that payment arriving, so it must get through;
 *   - a draft or approved order: never sent (the database cancels it when the
 *     invoice is paid);
 *   - an unsigned one: never executes (the status sync cancels it at the bank);
 *   - an executed one: settled by the payment that records it, so marking it
 *     paid by hand is one of the ways its debit gets booked.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { SIGNED_PAYMENT_ORDER_STATUSES } from './status'

export interface SignedBankPayment {
  id: string
  status: string
  requested_execution_date: string | null
}

export async function findSignedBankPayment(
  supabase: SupabaseClient,
  companyId: string,
  supplierInvoiceId: string,
): Promise<SignedBankPayment | null> {
  const { data, error } = await supabase
    .from('payment_orders')
    .select('id, status, requested_execution_date')
    .eq('company_id', companyId)
    .eq('supplier_invoice_id', supplierInvoiceId)
    .in('status', [...SIGNED_PAYMENT_ORDER_STATUSES])
    .order('created_at', { ascending: false })
    .limit(1)
  if (error) throw error
  const row = ((data ?? []) as SignedBankPayment[])[0]
  return row ?? null
}

/** The refusal's details: which payment, where it stands and when the bank pays it. */
export function signedBankPaymentDetails(payment: SignedBankPayment): Record<string, unknown> {
  return {
    payment_order_id: payment.id,
    payment_order_status: payment.status,
    requested_execution_date: payment.requested_execution_date,
  }
}
