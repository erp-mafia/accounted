export default {
  rule: 'booking-precedent-reading',
  says: "How a company booked a counterparty's bank rows before is read through one module: one call for the rows, one reading of what an earlier verifikat booked.",
  home: 'src/lib/transactions/booking-precedent.ts: loadBookingPrecedents, bookedAs, precedentProposal',
  why: 'A second reader of the same function would decide the account and the moms of an earlier booking its own way, and the same row would be proposed two bookings.',
  match: [
    // The database function called outside the module that reads its answer.
    /\.rpc\(\s*['"]booking_precedents['"]/,
  ],
  sanctioned: ['lib/transactions/booking-precedent.ts'],
}
