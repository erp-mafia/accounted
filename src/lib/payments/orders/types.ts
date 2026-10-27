import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'
import { PaymentProviderError } from '@/lib/payments/initiation/provider'
import type { DebtorSnapshot } from './debtor'
import type { PaymentOrderStatus } from './status'

/** A payment_orders row (migration 20261010090000). */
export interface PaymentOrderRow {
  id: string
  company_id: string
  user_id: string
  /**
   * skattekonto: a payment in to Skatteverket's bankgiro with the company's OCR number (migration 20261016180000).
   * salary: one employee's net pay on a salary run, to the account on the employee card (migration 20261027100000).
   * Neither has a supplier invoice.
   */
  purpose: 'supplier_invoice' | 'skattekonto' | 'salary'
  supplier_invoice_id: string | null
  /** The salary run and employee a salary payment pays; null for every other purpose. */
  salary_run_id: string | null
  employee_id: string | null
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
  payee_source: 'invoice' | 'supplier' | 'skatteverket' | 'employee'
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
  /** Written right before the bank is asked to create the payment, cleared with its answer (the migration's rule 1). */
  create_started_at: string | null
  /** Set while a create may have reached the bank but no payment id is held (see the migration's rule 1). */
  outcome_unknown_at: string | null
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
  | 'outcome_unknown'
  | 'provider_cancelled'
  | 'released'
  | 'rebatched'
  | 'invoice_closed'
  /** A payment made anew after the bank refused a second BankID on the first (migration 20261012170000). */
  | 'recreated_after_expired_signing'

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

function eventRows(events: PaymentOrderEvent[]) {
  return events.map((e) => ({
    company_id: e.company_id,
    payment_order_id: e.payment_order_id ?? null,
    batch_id: e.batch_id ?? null,
    event_type: e.event_type,
    from_status: e.from_status ?? null,
    to_status: e.to_status ?? null,
    provider_status: e.provider_status ?? null,
    actor_user_id: e.actor_user_id ?? null,
    detail: e.detail ?? {},
  }))
}

/**
 * Append events and report whether they were written; never throws. The
 * one insert site for payment_order_events. A caller whose next write depends
 * on the event checks the answer: the database lets a payment id go only
 * after a provider_cancelled event names it.
 */
export async function recordPaymentOrderEvents(writer: SupabaseClient, events: PaymentOrderEvent[]): Promise<boolean> {
  if (events.length === 0) return true
  try {
    const { error } = await writer.from('payment_order_events').insert(eventRows(events))
    return !error
  } catch {
    return false
  }
}

/**
 * Append events that record what already happened, often at the bank: tried
 * twice, and when both fail they go to the error log with their ids, so what
 * the bank did is never known only to an insert that was lost. Never throws:
 * a failed write here must not undo a status the bank already reported.
 */
export async function logPaymentOrderEvents(writer: SupabaseClient, events: PaymentOrderEvent[], log: Logger): Promise<boolean> {
  if (await recordPaymentOrderEvents(writer, events)) return true
  if (await recordPaymentOrderEvents(writer, events)) return true
  log.error('payment order events could not be recorded', undefined, {
    events: events.map((e) => ({
      companyId: e.company_id,
      orderId: e.payment_order_id ?? null,
      batchId: e.batch_id ?? null,
      type: e.event_type,
      detail: e.detail ?? {},
    })),
  })
  return false
}

/**
 * The text kept on an order for people: the provider's own words, short, with
 * long digit runs (account numbers, personnummer) masked. Anything that is not
 * a provider failure (a database or programming error) keeps no text at all.
 */
export function sanitizedProviderMessage(error: unknown): string | null {
  if (!(error instanceof PaymentProviderError)) return null
  const text = error.message.replace(/\d[\d\s-]{4,}\d/g, '***').replace(/\s+/g, ' ').trim()
  return text ? text.slice(0, 200) : null
}
