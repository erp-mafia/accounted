export default {
  rule: 'webshop-order-booked',
  says: 'A webshop order reads booked when the verifikat it names stands: one a plain storno reversed with no rättelse in its place releases the order, which keeps naming it until it is booked again in that verifikat\'s series and fiscal year, so deleting the storno makes the order read booked again with nothing put back.',
  home: 'src/lib/webshop-orders/booking-status.ts: isWebshopBookingReleased, webshopOrderBookingStatus, whereWebshopOrderBooked; the reads: src/lib/webshop-orders/released-booking.ts; the placement of a new booking: src/lib/webshop-orders/book-order.ts: placeOrderBooking',
  why: 'A storno of an order\'s verifikat left the order reading booked from its pointer alone, so it could never be booked again; clearing the pointer instead would lose which orders a day verifikat books, and the order would read unbooked once the storno was deleted.',
  match: [
    // The lists' booked split written from the pointer alone, the void-aware
    // mark arm included.
    /journal_entry_id\.not\.is\.null,(?:and\()?manually_booked_at\.not\.is\.null/,
    // The status read without the verifikat's release.
    /webshopOrderBookingStatus\(\s*\w+\s*\)/,
    // A booked flag read from the pointer alone.
    /\bconst booked = \w+\.journal_entry_id\b/,
  ],
  sanctioned: ['lib/webshop-orders/booking-status.ts'],
  allowed: {},
  scan: [
    'app/(dashboard)/orders/',
    'app/api/webshop-orders/',
    'app/api/v1/companies/[companyId]/webshop-orders/',
    'components/orders/',
    'lib/webshop-orders/',
    'lib/operations/webshop-orders.ts',
  ],
}
