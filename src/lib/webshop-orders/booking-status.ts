import type { WebshopOrder } from '@/types'

export type WebshopOrderBookingStatus =
  | 'booked'
  | 'marked_booked'
  | 'invoiced'
  | 'in_transactions'
  | 'unpaid'
  | 'to_book'

/**
 * Where an order row stands, in the order the Orders page decides its status
 * chip: booked through the integration, marked as booked outside it,
 * invoiced, already in the legacy transactions feed, unpaid, or to book.
 */
export function webshopOrderBookingStatus(
  order: Pick<
    WebshopOrder,
    'journal_entry_id' | 'manually_booked_at' | 'invoice_id' | 'legacy_transaction_id' | 'is_paid' | 'row_type'
  >,
): WebshopOrderBookingStatus {
  if (order.journal_entry_id) return 'booked'
  if (order.manually_booked_at) return 'marked_booked'
  if (order.invoice_id) return 'invoiced'
  if (order.legacy_transaction_id) return 'in_transactions'
  if (!order.is_paid && order.row_type === 'order') return 'unpaid'
  return 'to_book'
}
