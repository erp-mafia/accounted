import type { PaymentOrderStatus } from '@/lib/payments/orders/status'

/**
 * How a payment order's status reads on screen. The labels are the plan's
 * seven words (Att betala, I betalning, Signerad, Planerad, Betald, Väntar på
 * signering i banken, Misslyckad) mapped onto payment_orders.status; the keys
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
 * How long the bank may go without answering about a payment it holds before
 * the row says so. The status sync asks every 15 minutes and every answer
 * moves provider_status_at, so a day is close to a hundred reads the bank
 * refused or never answered (SEB and Länsförsäkringar refuse one without the
 * signer's IP address, which signings started before 2026-10-31 lack).
 */
export const BANK_SILENT_AFTER_MS = 24 * 60 * 60_000

const AT_THE_BANK: ReadonlySet<PaymentOrderStatus> = new Set(['submitted', 'awaiting_signature', 'awaiting_second_signer', 'accepted'])

/**
 * When the bank last answered about a payment it still holds, once that is
 * longer ago than BANK_SILENT_AFTER_MS; null while it answers, and for an
 * order whose outcome is unknown (needsResolution has its own line).
 */
export function bankSilentSince(
  order: { status: PaymentOrderStatus; provider_status_at: string | null; outcome_unknown_at: string | null },
  now: number = Date.now(),
): string | null {
  if (!AT_THE_BANK.has(order.status) || order.outcome_unknown_at !== null || !order.provider_status_at) return null
  const at = Date.parse(order.provider_status_at)
  return Number.isFinite(at) && now - at > BANK_SILENT_AFTER_MS ? order.provider_status_at : null
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

/**
 * Signera igen on a row: the order waits unsigned at the bank in a signing
 * nobody is in (sign_again, decided by the server with isSignableAgain). The
 * restart signs its whole signing, so the dialog shows every order of that
 * signing that waits too.
 */
export function signAgainOrders<T extends { id: string; batch_id: string | null; sign_again?: boolean }>(order: T, orders: readonly T[]): T[] {
  if (!order.sign_again || !order.batch_id) return []
  return orders.filter((o) => o.batch_id === order.batch_id && o.sign_again === true)
}

/**
 * A BankID that ended unsigned (cancelled, abandoned, expired): the server
 * cancelled the signing's payments at the bank and names the orders it let
 * go, approved again (sign_anew, crm#1470). Signing again is a new signing
 * over them; the server leaves the list empty for a failure signing cannot
 * fix, and when the bank kept a payment.
 */
export function signsAnew(view: { status: string; sign_anew?: readonly string[] }): boolean {
  return view.status === 'failed' && (view.sign_anew?.length ?? 0) > 0
}

/**
 * Codes after which signing again cannot help (the fix is in the online bank
 * or at the provider); mirrors PERMANENT_SIGNING_FAILURES in
 * lib/payments/orders/signing.ts, which is server-only.
 */
export const PERMANENT_SIGNING_FAILURES: ReadonlySet<string> = new Set([
  'PSU_RIGHTS_MISSING',
  'PSU_CREDENTIALS_INVALID',
  'PSU_OPEN_BANKING_RIGHTS_MISSING',
  'BANK_AGREEMENT_MISSING',
  'PAYMENT_PRODUCT_AGREEMENT_MISSING',
  'BANKID_NOT_ACTIVATED',
  'BANKID_EXTENDED_USE_REQUIRED',
  'KYC_INVALID',
  'TPP_KYC_INVALID',
  'AMOUNT_LIMITATION_CONTROL_FAILED',
  'SCA_REDIRECT_UNSUPPORTED',
])

/**
 * The pauses between reads of a payment the bank is still confirming after
 * the BankID (follow_up): short at first, when the bank usually answers, then
 * longer, capped at 30 s. The server stops following a few minutes after the
 * signing (FOLLOW_BANK_CONFIRMATION_MS); the reads also run out here, so a
 * screen left open never polls without end.
 */
const FOLLOW_UP_DELAYS_MS: readonly number[] = [2_000, 3_000, 5_000, 10_000, 15_000]
const FOLLOW_UP_MAX_DELAY_MS = 30_000
export const FOLLOW_UP_MAX_READS = 20

/** The pause before read number `attempt` (from 0), or null when the reads have run out. */
export function followUpDelayMs(attempt: number): number | null {
  if (attempt < 0 || attempt >= FOLLOW_UP_MAX_READS) return null
  return FOLLOW_UP_DELAYS_MS[attempt] ?? FOLLOW_UP_MAX_DELAY_MS
}
