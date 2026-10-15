/**
 * The bank payment that will pay a supplier invoice unless someone cancels
 * it: an order signed, or being signed, with BankID
 * (SIGNED_PAYMENT_ORDER_STATUSES).
 *
 * While one exists, recording a payment the person made another way (mark
 * paid) or marking the invoice as typed into the internet bank by hand pays
 * the supplier twice: the bank still executes the signed order. Both doors
 * refuse with SI_BANK_PAYMENT_UNDER_WAY, and the way out is to cancel the
 * bank payment under Betalningar first (crm#1243).
 *
 * Deliberately not refused: a draft or approved order was never sent (the
 * database cancels it when the invoice is paid), an unsigned one never
 * executes (the status sync cancels it at the bank), and an executed one is
 * settled by the payment that records it, so marking it paid by hand is one
 * of the ways its debit gets booked.
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
