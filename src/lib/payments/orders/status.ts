/**
 * Payment order statuses (payment_orders.status, migration 20261010090000).
 *
 * Provider-neutral: what the company needs to know about a payment it asked
 * its bank to make. Each provider adapter maps its own status vocabulary onto
 * these; the raw provider status is kept next to it (provider_status).
 *
 * The database trigger enforce_payment_order_lifecycle() is the authority on
 * which moves are allowed; PAYMENT_ORDER_TRANSITIONS mirrors it so callers can
 * decide before writing, and a unit test pins the two lists together.
 */

export const PAYMENT_ORDER_STATUSES = [
  'draft',
  'approved',
  'submitted',
  'awaiting_signature',
  'awaiting_second_signer',
  'accepted',
  'executed',
  'rejected',
  'cancelled',
  'failed',
] as const

export type PaymentOrderStatus = (typeof PAYMENT_ORDER_STATUSES)[number]

/** No move leaves these. */
export const FINAL_PAYMENT_ORDER_STATUSES: ReadonlySet<PaymentOrderStatus> = new Set([
  'executed',
  'rejected',
  'cancelled',
  'failed',
])

/** The bank has the payment and has not finished with it: what the status poll walks. */
export const IN_FLIGHT_PAYMENT_ORDER_STATUSES: ReadonlySet<PaymentOrderStatus> = new Set([
  'submitted',
  'awaiting_signature',
  'awaiting_second_signer',
  'accepted',
])

/**
 * Signed, or being signed: the bank pays it on its date unless it is
 * cancelled there. A second payment of the invoice meanwhile pays the
 * supplier twice (findSignedBankPayment). Not here: 'submitted' is unsigned
 * and never executes (the status sync cancels it at the bank once its
 * invoice is paid another way), and an executed order is settled by the
 * payment that records it.
 */
export const SIGNED_PAYMENT_ORDER_STATUSES: ReadonlySet<PaymentOrderStatus> = new Set([
  'awaiting_signature',
  'awaiting_second_signer',
  'accepted',
])

/** Statuses in which the instruction (amount, payee, reference, debtor, date) may still be edited. */
export const EDITABLE_PAYMENT_ORDER_STATUSES: ReadonlySet<PaymentOrderStatus> = new Set(['draft'])

export const PAYMENT_ORDER_TRANSITIONS: Readonly<Record<PaymentOrderStatus, readonly PaymentOrderStatus[]>> = {
  draft: ['approved', 'cancelled'],
  approved: ['draft', 'submitted', 'cancelled', 'failed'],
  // Back to approved only when the bank holds nothing (the trigger checks it).
  submitted: ['approved', 'awaiting_signature', 'awaiting_second_signer', 'accepted', 'executed', 'rejected', 'cancelled', 'failed'],
  awaiting_signature: ['submitted', 'awaiting_second_signer', 'accepted', 'executed', 'rejected', 'cancelled', 'failed'],
  awaiting_second_signer: ['accepted', 'executed', 'rejected', 'cancelled', 'failed'],
  accepted: ['executed', 'rejected', 'cancelled', 'failed'],
  executed: [],
  rejected: [],
  cancelled: [],
  failed: [],
}

export function canMovePaymentOrder(from: PaymentOrderStatus, to: PaymentOrderStatus): boolean {
  return from === to || PAYMENT_ORDER_TRANSITIONS[from].includes(to)
}

/**
 * Whether an order still covers its invoice: the invoice must not be put in
 * another order or a payment file. An executed order counts until its debit
 * is matched to the invoice (supplier_invoice_payment_id set): before that the
 * invoice still shows as unpaid, and a second payment would pay it twice.
 * Same rule as the partial unique index uq_payment_orders_open_per_supplier_invoice.
 */
export function isOpenPaymentOrder(order: {
  status: PaymentOrderStatus | string
  supplier_invoice_payment_id?: string | null
}): boolean {
  if (order.status === 'executed') return !order.supplier_invoice_payment_id
  return !FINAL_PAYMENT_ORDER_STATUSES.has(order.status as PaymentOrderStatus)
}

/**
 * Every status an open order can have, for a plain .in('status', ...) read.
 * 'executed' is included because an executed order stays open until its debit
 * is matched; isOpenPaymentOrder then drops the matched ones in code. A
 * literal list rather than a PostgREST or-string keeps the read checkable by
 * the phantom-column guard.
 */
export const OPEN_PAYMENT_ORDER_CANDIDATE_STATUSES: readonly PaymentOrderStatus[] = PAYMENT_ORDER_STATUSES.filter(
  (status) => status === 'executed' || !FINAL_PAYMENT_ORDER_STATUSES.has(status),
)

/**
 * Signing statuses a finalised BankID leaves on its batch
 * (payment_order_batches.status): the person signed, and nothing in that
 * signing waits for them any more.
 */
export const SIGNING_FINISHED_BATCH_STATUSES: ReadonlySet<string> = new Set(['signed', 'awaiting_second_signer'])

/**
 * The bank is confirming the payment: its BankID finalised (the batch is
 * signed) while the bank still answers that it has only received it (RCVD),
 * so the order stays awaiting_signature (applyProviderState never moves an
 * order on a 'submitted' answer). Nothing is left to sign. A bank may confirm
 * one payment of a basket minutes after the rest (crm desk #1267,
 * Handelsbanken); the signing poll follows it for a while, then the status
 * sync. Shown as such, not as waiting for a signature.
 */
export function isBankConfirming(
  order: { status: PaymentOrderStatus | string; outcome_unknown_at?: string | null },
  batchStatus: string | null | undefined,
): boolean {
  return (
    order.status === 'awaiting_signature' &&
    !order.outcome_unknown_at &&
    typeof batchStatus === 'string' &&
    SIGNING_FINISHED_BATCH_STATUSES.has(batchStatus)
  )
}
