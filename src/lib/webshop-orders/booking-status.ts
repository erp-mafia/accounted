import type { WebshopOrder } from '@/types'

export type WebshopOrderBookingStatus =
  | 'booked'
  | 'marked_booked'
  | 'voided'
  | 'invoiced'
  | 'in_transactions'
  | 'cancelled'
  | 'unpaid'
  | 'to_book'

/**
 * The row status of an order the store cancelled. WooCommerce sends it as
 * its own order status; the Shopify sync writes it when the order carries a
 * cancelledAt (lib/order-sync there).
 */
export const WEBSHOP_ORDER_CANCELLED_STATUS = 'cancelled'

/** Whether the store reports the order cancelled. Refund rows never are. */
export function isCancelledInStore(order: Pick<WebshopOrder, 'row_type' | 'status'>): boolean {
  return order.row_type === 'order' && order.status === WEBSHOP_ORDER_CANCELLED_STATUS
}

/**
 * A cancelled order that the store refunded nothing on: nothing shows that
 * money moved, so it may be voided (makulerad) instead of booked, and a
 * machine never books it as a sale (the bulk and day bookings refuse it).
 * Once the store has refunded money, the payment and the refund are
 * affärshändelser that are booked (BFL 5 kap 1 §): the order books, with its
 * refund rows, like any other.
 */
export function isCancelledWithoutRefund(
  order: Pick<WebshopOrder, 'row_type' | 'status' | 'refunded_total'>,
): boolean {
  return isCancelledInStore(order) && order.refunded_total === 0
}

/**
 * Whether the row can be marked as voided: an order the store cancelled
 * without a refund, still open (not booked, invoiced or marked).
 */
export function isVoidable(
  order: Pick<
    WebshopOrder,
    'row_type' | 'status' | 'refunded_total' | 'journal_entry_id' | 'invoice_id' | 'manually_booked_at'
  >,
): boolean {
  return (
    isCancelledWithoutRefund(order) &&
    order.journal_entry_id === null &&
    order.invoice_id === null &&
    order.manually_booked_at === null
  )
}

/**
 * A void the store no longer backs: the row is voided, but the store has
 * since reopened the order or refunded money on it. The row stays closed
 * until a person undoes the void; the Orders page flags it so they do.
 */
export function isVoidOutdated(
  order: Pick<WebshopOrder, 'row_type' | 'status' | 'refunded_total' | 'manually_booked_at' | 'manually_voided'>,
): boolean {
  return order.manually_booked_at !== null && order.manually_voided === true && !isCancelledWithoutRefund(order)
}

/**
 * The PostgREST or-filter for rows closed by an exit that books: booked
 * through the integration, or marked as booked outside it. A voided row
 * carries the mark too but booked nothing, so it is neither booked nor open.
 */
export const BOOKED_EXITS_FILTER =
  'journal_entry_id.not.is.null,and(manually_booked_at.not.is.null,manually_voided.is.false)'

/**
 * Where an order row stands, in the order the Orders page decides its status
 * chip: booked through the integration, marked as booked outside it or
 * voided, invoiced, already in the legacy transactions feed, cancelled in the
 * store, unpaid, or to book.
 */
export function webshopOrderBookingStatus(
  order: Pick<
    WebshopOrder,
    | 'journal_entry_id'
    | 'manually_booked_at'
    | 'manually_voided'
    | 'invoice_id'
    | 'legacy_transaction_id'
    | 'is_paid'
    | 'row_type'
    | 'status'
  >,
): WebshopOrderBookingStatus {
  if (order.journal_entry_id) return 'booked'
  if (order.manually_booked_at) return order.manually_voided ? 'voided' : 'marked_booked'
  if (order.invoice_id) return 'invoiced'
  if (order.legacy_transaction_id) return 'in_transactions'
  if (isCancelledInStore(order)) return 'cancelled'
  if (!order.is_paid && order.row_type === 'order') return 'unpaid'
  return 'to_book'
}
