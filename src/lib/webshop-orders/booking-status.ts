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
 * without a refund, still open (not booked, invoiced or marked). An order
 * that names a verifikat is not, even one a storno released
 * (isWebshopBookingReleased): the mark refuses it like Skapa faktura does,
 * since deleting the storno posts that verifikat again.
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
 * Whether the verifikat an order names (webshop_orders.journal_entry_id) has
 * released it. A plain storno (reverseEntry) reverses the verifikat and leaves
 * the pointer where it is: the order reads not booked, and booking it again
 * moves the pointer to the new verifikat, which the freeze trigger allows once
 * the old one is no longer posted. Deleting that storno with Radera senaste
 * verifikat posts the verifikat again, and the order reads booked by itself:
 * nothing is put back, also for a day booking, whose verifikat names no single
 * order. The pointer is the only record of which orders a day verifikat
 * books, so it is never cleared.
 *
 * A rättelse (correctEntry) reverses the verifikat too, but books its
 * correction in its place (correction_of_id): that order stays booked. A
 * draft or cancelled verifikat is a booking in flight, which its own claim
 * cleans up: the order stays booked here too.
 */
export function isWebshopBookingReleased(
  entry: { status: string } | null | undefined,
  hasRattelse: boolean,
): boolean {
  return entry?.status === 'reversed' && !hasRattelse
}

/**
 * Where an order row stands, in the order the Orders page decides its status
 * chip: booked through the integration, marked as booked outside it or
 * voided, invoiced, already in the legacy transactions feed, cancelled in the
 * store, unpaid, or to book. `released` is isWebshopBookingReleased for the
 * verifikat the order names: a released order is not booked, and reads as if
 * it had never been.
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
  options: { released?: boolean } = {},
): WebshopOrderBookingStatus {
  if (order.journal_entry_id && !options.released) return 'booked'
  if (order.manually_booked_at) return order.manually_voided ? 'voided' : 'marked_booked'
  if (order.invoice_id) return 'invoiced'
  if (order.legacy_transaction_id) return 'in_transactions'
  if (isCancelledInStore(order)) return 'cancelled'
  if (!order.is_paid && order.row_type === 'order') return 'unpaid'
  return 'to_book'
}

/** The filters whereWebshopOrderBooked writes, on any query of webshop_orders. */
interface BookedFilter {
  or(filters: string): BookedFilter
  is(column: string, value: null): BookedFilter
}

/**
 * The or-filter arm for a row marked as booked outside the integration. A
 * voided row carries the mark too but booked nothing, so it is neither booked
 * nor open.
 */
const MARKED_BOOKED_FILTER = 'and(manually_booked_at.not.is.null,manually_voided.is.false)'

/**
 * The lists' booked and unbooked split as a filter on a query of
 * webshop_orders. Booked is every exit that books: an order that names a
 * verifikat that stands, or one marked as booked outside the integration,
 * never a voided row. Unbooked is the open set: no verifikat, or one that
 * released the order (`releasedEntryIds`, from
 * readCompanyReleasedWebshopBookings), and no mark, a void included. With no
 * released verifikat the filters read the pointer alone.
 */
export function whereWebshopOrderBooked<Query>(
  query: Query,
  booked: 'booked' | 'unbooked',
  releasedEntryIds: readonly string[],
): Query {
  const q = query as unknown as BookedFilter
  const released = releasedEntryIds.join(',')
  if (booked === 'booked') {
    const standing =
      releasedEntryIds.length === 0
        ? 'journal_entry_id.not.is.null'
        : `and(journal_entry_id.not.is.null,journal_entry_id.not.in.(${released}))`
    return q.or(`${standing},${MARKED_BOOKED_FILTER}`) as unknown as Query
  }
  const open =
    releasedEntryIds.length === 0
      ? q.is('journal_entry_id', null)
      : q.or(`journal_entry_id.is.null,journal_entry_id.in.(${released})`)
  return open.is('manually_booked_at', null) as unknown as Query
}
