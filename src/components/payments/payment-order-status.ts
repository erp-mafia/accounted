import type { PaymentOrderStatus } from '@/lib/payments/orders/status'

/**
 * How a payment order's status reads on screen. The labels are the plan's
 * seven words (Att betala, I betalning, Signerad, Planerad, Betald, Väntar på
 * andra attestant, Misslyckad) mapped onto payment_orders.status; the keys
 * live in the `bank_payments` message namespace (status_<status>).
 *
 * Chips mark exceptions (design convention 5): the normal flow (approved,
 * accepted, executed) is muted text; only a deviating row gets a Badge.
 */

export type StatusBadgeVariant = 'secondary' | 'outline' | 'warning' | 'destructive'

export const PAYMENT_ORDER_STATUS_BADGE: Partial<Record<PaymentOrderStatus, StatusBadgeVariant>> = {
  draft: 'outline',
  awaiting_signature: 'warning',
  awaiting_second_signer: 'warning',
  rejected: 'destructive',
  failed: 'destructive',
  cancelled: 'secondary',
}

/** The Betalningar page sections, in reading order. */
export type PaymentOrderSection = 'to_approve' | 'to_sign' | 'in_progress' | 'planned' | 'paid' | 'closed'

export const PAYMENT_ORDER_SECTIONS: readonly PaymentOrderSection[] = ['to_approve', 'to_sign', 'in_progress', 'planned', 'paid', 'closed']

export function sectionOf(order: { status: PaymentOrderStatus; outcome_unknown_at: string | null }): PaymentOrderSection {
  switch (order.status) {
    case 'draft':
      return 'to_approve'
    case 'approved':
      return 'to_sign'
    case 'submitted':
    case 'awaiting_signature':
    case 'awaiting_second_signer':
      return 'in_progress'
    case 'accepted':
      return 'planned'
    case 'executed':
      return 'paid'
    case 'rejected':
    case 'cancelled':
    case 'failed':
      return 'closed'
  }
}

/**
 * An order a person has to settle: the bank's answer was lost (outcome
 * unknown), or the payment sits submitted with an id and no signing moves it.
 * Cancel is refused for these; the resolve action is the way out.
 */
export function needsResolution(order: { status: PaymentOrderStatus; outcome_unknown_at: string | null }): boolean {
  return order.status === 'submitted' && order.outcome_unknown_at !== null
}

/**
 * Statuses the lifecycle lets a person cancel from the list: before the bank
 * has it, or while the payment waits there. A submitted order whose create is
 * still on its way is refused by the server (PAYMENT_ORDER_CREATE_IN_PROGRESS)
 * and one whose outcome is unknown is resolved instead (needsResolution).
 */
export function canCancel(order: { status: PaymentOrderStatus; outcome_unknown_at: string | null }): boolean {
  if (order.status === 'draft' || order.status === 'approved') return true
  if (order.status === 'submitted') return order.outcome_unknown_at === null
  return order.status === 'awaiting_signature' || order.status === 'awaiting_second_signer' || order.status === 'accepted'
}

/** Codes after which signing again cannot help; mirrors PERMANENT_SIGNING_FAILURES in lib/payments/orders/signing.ts. */
export const PERMANENT_SIGNING_FAILURES: ReadonlySet<string> = new Set([
  'PSU_RIGHTS_MISSING',
  'BANKID_NOT_ACTIVATED',
  'TPP_KYC_INVALID',
  'SCA_REDIRECT_UNSUPPORTED',
])
