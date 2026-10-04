import type { SupabaseClient } from '@supabase/supabase-js'
import type { DebtorSnapshot } from './debtor'
import type { PaymentOrderStatus } from './status'

/** A payment_orders row (migration 20261004010200). */
export interface PaymentOrderRow {
  id: string
  company_id: string
  user_id: string
  purpose: 'supplier_invoice'
  supplier_invoice_id: string | null
  batch_id: string | null
  status: PaymentOrderStatus
  amount: number
  currency: string
  requested_execution_date: string
  cash_account_id: string
  debtor_snapshot: DebtorSnapshot
  payee_type: 'bankgiro' | 'plusgiro' | 'bank_account' | 'iban'
  payee_bankgiro: string | null
  payee_plusgiro: string | null
  payee_clearing: string | null
  payee_account: string | null
  payee_iban: string | null
  payee_bic: string | null
  payee_name: string
  payee_source: 'invoice' | 'supplier'
  payee_check: 'unchecked' | 'known' | 'new' | 'changed'
  reference_type: 'ocr' | 'message'
  reference: string
  end_to_end_id: string
  idempotency_key: string
  provider: 'open_payments' | null
  provider_payment_id: string | null
  provider_payment_product: string | null
  provider_status: string | null
  provider_status_at: string | null
  provider_error_code: string | null
  provider_error_message: string | null
  approved_by: string | null
  approved_at: string | null
  submitted_by: string | null
  submitted_at: string | null
  signed_at: string | null
  executed_at: string | null
  cancelled_by: string | null
  cancelled_at: string | null
  matched_transaction_id: string | null
  supplier_invoice_payment_id: string | null
  matched_at: string | null
  created_at: string
  updated_at: string
}

export type PaymentOrderBatchStatus =
  | 'created'
  | 'awaiting_signature'
  | 'awaiting_second_signer'
  | 'signed'
  | 'rejected'
  | 'cancelled'
  | 'failed'

/** A payment_order_batches row: one BankID signing. */
export interface PaymentOrderBatchRow {
  id: string
  company_id: string
  user_id: string
  provider: 'open_payments'
  signing_target: 'payment' | 'basket'
  provider_batch_id: string | null
  status: PaymentOrderBatchStatus
  provider_status: string | null
  provider_status_at: string | null
  provider_authorisation_id: string | null
  signing_method: 'same_device' | 'qr' | 'redirect' | null
  signer_user_id: string | null
  signing_started_at: string | null
  signed_at: string | null
  order_count: number
  total_amount: number
  currency: string
  created_at: string
  updated_at: string
}

export type PaymentOrderEventType =
  | 'created'
  | 'edited'
  | 'approved'
  | 'unapproved'
  | 'submitted'
  | 'signing_started'
  | 'status_changed'
  | 'cancel_requested'
  | 'cancelled'
  | 'matched'
  | 'unmatched'
  | 'error'

export interface PaymentOrderEvent {
  company_id: string
  payment_order_id?: string | null
  batch_id?: string | null
  event_type: PaymentOrderEventType
  from_status?: string | null
  to_status?: string | null
  provider_status?: string | null
  actor_user_id?: string | null
  detail?: Record<string, unknown>
}

/**
 * Append events. Never throws: the event log explains what happened, and a
 * failed write there must not undo a status the bank already reported.
 */
export async function logPaymentOrderEvents(writer: SupabaseClient, events: PaymentOrderEvent[]): Promise<void> {
  if (events.length === 0) return
  await writer
    .from('payment_order_events')
    .insert(
      events.map((e) => ({
        company_id: e.company_id,
        payment_order_id: e.payment_order_id ?? null,
        batch_id: e.batch_id ?? null,
        event_type: e.event_type,
        from_status: e.from_status ?? null,
        to_status: e.to_status ?? null,
        provider_status: e.provider_status ?? null,
        actor_user_id: e.actor_user_id ?? null,
        detail: e.detail ?? {},
      })),
    )
    .then(
      () => undefined,
      () => undefined,
    )
}
