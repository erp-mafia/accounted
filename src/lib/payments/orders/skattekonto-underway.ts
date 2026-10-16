/**
 * What the company's bank payments to the skattekonto (payment_orders with
 * purpose 'skattekonto') already cover and the synced saldo cannot show yet.
 * Dependency-free on purpose: Hem's Betala row and the payment dialog read it
 * on the server (lib/worklist/categories.ts), the Skattekonto page's own
 * shortfall line in the browser, and the two must never disagree.
 */
import { sumOre } from '@/lib/money'

/** A skattekonto payment through the bank that a person approved and the bank has not finished: from approved to accepted. */
export const SKATTEKONTO_PAYMENT_UNDERWAY_STATUSES = ['approved', 'submitted', 'awaiting_signature', 'awaiting_second_signer', 'accepted'] as const

/** The statuses to read: the ones on their way, and executed (counted only after the saldo was fetched). */
export const SKATTEKONTO_PAYMENT_COVER_STATUSES = [...SKATTEKONTO_PAYMENT_UNDERWAY_STATUSES, 'executed'] as const

export interface SkattekontoPaymentOrderCover {
  amount: number | string
  status: string
  executed_at: string | null
}

/**
 * Every order on its way to the bank (approved up to accepted) covers its
 * amount, and so does every one the bank executed after the saldo was
 * fetched. A draft nobody approved pays nothing. Without a snapshot
 * (fetchedAtMs null) only the orders on their way count, since nothing tells
 * whether an executed one already reached the charge the company reads.
 */
export function skattekontoPaymentsCovering(orders: readonly SkattekontoPaymentOrderCover[], fetchedAtMs: number | null): number {
  const underway = new Set<string>(SKATTEKONTO_PAYMENT_UNDERWAY_STATUSES)
  const covering = orders.filter(
    (order) =>
      underway.has(order.status) ||
      (order.status === 'executed' && fetchedAtMs !== null && order.executed_at !== null && Date.parse(order.executed_at) > fetchedAtMs),
  )
  return sumOre(covering.map((order) => Number(order.amount)))
}
