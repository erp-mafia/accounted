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
 *     samlingsbetalning, IS that payment arriving, so it must get through.
 *     It may as well be another debit of the same amount, and then the bank
 *     still pays the supplier on the order's date: the person or agent is
 *     warned before confirming instead (checkBankHeldPayments below);
 *   - a draft or approved order: never sent (the database cancels it when the
 *     invoice is paid);
 *   - an unsigned one: never executes (the status sync cancels it at the bank);
 *   - an executed one: settled by the payment that records it, so marking it
 *     paid by hand is one of the ways its debit gets booked.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { OperationOutcome, OperationWarning } from '@/lib/operations/types'
import type { SupabaseDataClient } from '@/lib/supabase/data-client'
import { readInSlices } from '@/lib/supabase/read-in-slices'
import { formatCurrency } from '@/lib/utils'
import { BANK_HELD_PAYMENT_ORDER_STATUSES, SIGNED_PAYMENT_ORDER_STATUSES, type PaymentOrderStatus } from './status'

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

/** A payment the bank holds for a supplier invoice, as a person or an agent is told of it. */
export interface BankHeldPayment {
  supplier_invoice_id: string
  /** The supplier's number for the invoice: names it where several are settled at once. */
  supplier_invoice_number: string | null
  payment_order_id: string
  status: PaymentOrderStatus
  /**
   * Signed, or being signed: the bank pays it on requested_execution_date
   * unless it is cancelled there. False for an unsigned one: nothing leaves
   * without a signature, and once its invoice no longer needs paying the
   * status sync asks the bank to cancel it.
   */
  signed: boolean
  requested_execution_date: string
  amount: number
  currency: string
  payee_name: string
}

interface BankHeldPaymentRow {
  id: string
  supplier_invoice_id: string
  status: PaymentOrderStatus
  requested_execution_date: string
  amount: number | string
  currency: string
  payee_name: string
  /** A many-to-one embed: one object from PostgREST, an array in the generated types. */
  supplier_invoice: { supplier_invoice_number: string | null } | Array<{ supplier_invoice_number: string | null }> | null
}

/**
 * The payment the bank holds for each of the given supplier invoices, by
 * invoice id; an invoice without one is absent. An invoice has one open order
 * at most (uq_payment_orders_open_per_supplier_invoice); were there two, the
 * signed one answers, as the one that still executes. Runs on the server and
 * in the browser (members read their company's orders). Throws on a failed
 * read: a read that did not run never answers "none".
 */
export async function findBankHeldPayments(
  supabase: SupabaseDataClient,
  companyId: string,
  supplierInvoiceIds: readonly string[],
): Promise<Map<string, BankHeldPayment>> {
  const held = new Map<string, BankHeldPayment>()
  const ids = [...new Set(supplierInvoiceIds)]
  if (ids.length === 0) return held
  const { data, error } = await readInSlices<BankHeldPaymentRow>(ids, (slice) =>
    supabase
      .from('payment_orders')
      .select(
        'id, supplier_invoice_id, status, requested_execution_date, amount, currency, payee_name, supplier_invoice:supplier_invoices(supplier_invoice_number)',
      )
      .eq('company_id', companyId)
      .in('supplier_invoice_id', slice)
      .in('status', [...BANK_HELD_PAYMENT_ORDER_STATUSES])
      .order('created_at', { ascending: false }),
  )
  if (error) throw error
  for (const row of data) {
    const signed = SIGNED_PAYMENT_ORDER_STATUSES.has(row.status)
    const kept = held.get(row.supplier_invoice_id)
    if (kept && (kept.signed || !signed)) continue
    const invoice = Array.isArray(row.supplier_invoice) ? (row.supplier_invoice[0] ?? null) : row.supplier_invoice
    held.set(row.supplier_invoice_id, {
      supplier_invoice_id: row.supplier_invoice_id,
      supplier_invoice_number: invoice?.supplier_invoice_number ?? null,
      payment_order_id: row.id,
      status: row.status,
      signed,
      requested_execution_date: row.requested_execution_date,
      amount: Number(row.amount),
      currency: row.currency,
      payee_name: row.payee_name,
    })
  }
  return held
}

/**
 * How the invoice is about to be settled: with a bank row, which may be the
 * held payment itself arriving, or another way (a payment registered by hand,
 * an existing verifikat, a credit), which a signed payment refuses
 * (SI_BANK_PAYMENT_UNDER_WAY).
 */
export type BankHeldPaymentVia = 'bank_row' | 'other'

/** A signed payment the bank still makes on its date. */
export const SIGNED_BANK_PAYMENT_WARNING = 'SI_SIGNED_BANK_PAYMENT'
/** An unsigned payment the bank holds: it never executes, and the status sync asks the bank to cancel it. */
export const UNSIGNED_BANK_PAYMENT_WARNING = 'SI_UNSIGNED_BANK_PAYMENT'
/** The orders could not be read: nobody can say whether the bank holds a payment. */
export const BANK_PAYMENT_CHECK_FAILED_WARNING = 'SI_BANK_PAYMENT_CHECK_FAILED'

/**
 * A warning about a payment the bank holds, naming the order and its invoice,
 * so a client can act on it (POST /payment-orders/{id}/cancel) and a dialog
 * can keep it beside the invoice it is about. The warning that the check could
 * not run names neither.
 */
export interface BankHeldPaymentWarning extends OperationWarning {
  payment_order_id?: string
  supplier_invoice_id?: string
}

/**
 * What a person or an agent is told about a payment the bank holds, before
 * the invoice is paid or closed another way: a warning, never a refusal. One
 * sentence in each language, for the API's warnings and the dialogs alike.
 * "Signed or being signed", as the refusal SI_BANK_PAYMENT_UNDER_WAY says it:
 * awaiting_signature and awaiting_second_signer are not fully signed yet.
 */
export function bankHeldPaymentWarning(payment: BankHeldPayment, via: BankHeldPaymentVia): BankHeldPaymentWarning {
  const ids = { payment_order_id: payment.payment_order_id, supplier_invoice_id: payment.supplier_invoice_id }
  const amount = formatCurrency(payment.amount, payment.currency)
  const number = payment.supplier_invoice_number?.trim()
  const invoiceSv = number ? `Leverantörsfaktura ${number}` : 'Fakturan'
  const invoiceEn = number ? `Supplier invoice ${number}` : 'The invoice'
  if (!payment.signed) {
    return {
      code: UNSIGNED_BANK_PAYMENT_WARNING,
      message_sv: `${invoiceSv} har en osignerad betalning på ${amount} hos banken. Utan signering går inga pengar, och banken ombeds sedan att avbryta den.`,
      message_en: `${invoiceEn} has an unsigned payment of ${amount} at the bank. No money leaves without a signature, and the bank is then asked to cancel it.`,
      ...ids,
    }
  }
  const date = payment.requested_execution_date
  const signedSv = `${invoiceSv} har en betalning på ${amount} via banken som är signerad eller signeras just nu, med betalningsdag ${date}.`
  const signedEn = `${invoiceEn} has a bank payment of ${amount} that is signed or being signed, with payment date ${date}.`
  return via === 'bank_row'
    ? {
        code: SIGNED_BANK_PAYMENT_WARNING,
        message_sv: `${signedSv} Är den här bankraden inte den betalningen betalar banken ändå: avbryt betalningen under Betalningar eller i banken, eller välj en annan rad.`,
        message_en: `${signedEn} If this bank row is not that payment, the bank pays anyway: cancel the payment under Payments or in the bank, or pick another row.`,
        ...ids,
      }
    : {
        code: SIGNED_BANK_PAYMENT_WARNING,
        message_sv: `${signedSv} Banken genomför den ändå: avbryt den under Betalningar först, eller matcha dragningen mot fakturan när pengarna har gått.`,
        message_en: `${signedEn} The bank makes it anyway: cancel it under Payments first, or match its debit to the invoice once the money has left.`,
        ...ids,
      }
}

/** The answer of checkBankHeldPayments. */
export interface BankHeldPaymentCheck {
  /** The payments the bank holds, one per invoice that has one. */
  payments: BankHeldPayment[]
  /** One per payment (bankHeldPaymentWarning), or the one saying that the check could not run. */
  warnings: BankHeldPaymentWarning[]
  /** The read failed: payments is empty because nothing could be read, not because nothing is held. */
  failed: boolean
  /** Why it failed, for the caller's log. */
  error?: unknown
}

/**
 * The check that could not run (a failed read, or one that did not answer in
 * time): said as a warning of its own, never as "nothing held".
 */
function failedBankHeldPaymentCheck(error: unknown): BankHeldPaymentCheck {
  return {
    error,
    payments: [],
    warnings: [
      {
        code: BANK_PAYMENT_CHECK_FAILED_WARNING,
        message_sv:
          'Det gick inte att kontrollera om banken har en betalning av fakturan. Titta under Betalningar innan du fortsätter.',
        message_en: 'Could not check whether the bank holds a payment of the invoice. Look under Payments before you go on.',
      },
    ],
    failed: true,
  }
}

/** The read, or a rejection once timeoutMs has passed without its answer (none without a timeoutMs). */
function answerWithin<T>(read: Promise<T>, timeoutMs: number | undefined): Promise<T> {
  if (timeoutMs === undefined) return read
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`bank payment orders: no answer within ${timeoutMs} ms`)), timeoutMs)
  })
  return Promise.race([read, late]).finally(() => clearTimeout(timer))
}

/**
 * The payments the bank holds for these supplier invoices and what to say of
 * them, for every door that pays or closes an invoice while one may stand.
 * Never throws: a failed read is a warning of its own, so the action goes on
 * and nobody takes a check that did not run for a clean one. A dialog passes
 * `timeoutMs`, so a read that hangs holds its confirm no longer: past it the
 * check reads as not run.
 */
export async function checkBankHeldPayments(
  supabase: SupabaseDataClient,
  companyId: string,
  supplierInvoiceIds: readonly string[],
  via: BankHeldPaymentVia,
  options: { timeoutMs?: number } = {},
): Promise<BankHeldPaymentCheck> {
  let held: Map<string, BankHeldPayment>
  try {
    held = await answerWithin(findBankHeldPayments(supabase, companyId, supplierInvoiceIds), options.timeoutMs)
  } catch (error) {
    // Said, not swallowed: the failure is a warning of its own, and the error
    // goes back to the caller for its log.
    return failedBankHeldPaymentCheck(error)
  }
  // In the order the invoices were given: a dialog's rows, a request's allocations.
  const payments = [...new Set(supplierInvoiceIds)].flatMap((id) => held.get(id) ?? [])
  return { payments, warnings: payments.map((payment) => bankHeldPaymentWarning(payment, via)), failed: false }
}

/**
 * An operation's outcome with what the check found: the orders
 * (bank_payments) and their warnings in a dry run's preview, the warnings
 * beside a write's answer. A refusal stays as it is: nothing was written.
 */
export function withBankHeldPaymentWarnings<O>(
  outcome: OperationOutcome<O>,
  check: BankHeldPaymentCheck,
): OperationOutcome<O> {
  if (!outcome.ok || check.warnings.length === 0) return outcome
  if (outcome.dryRun) {
    const earlier = Array.isArray(outcome.preview.warnings) ? outcome.preview.warnings : []
    return {
      ...outcome,
      preview: { ...outcome.preview, bank_payments: check.payments, warnings: [...earlier, ...check.warnings] },
    }
  }
  return { ...outcome, warnings: [...(outcome.warnings ?? []), ...check.warnings] }
}
