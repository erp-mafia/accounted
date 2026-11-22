export default {
  rule: 'nordea-card-hold',
  says: "A Nordea bank-feed entry whose text starts with 'Reservation ' is a card hold, not a booked row, whatever status and date it carries.",
  home: 'src/lib/bank-sync/card-hold.ts: isNordeaCardHold (the Open Payments read: Connect, isBookedListReservation)',
  why: "From 2026-11-20 Nordea sent card holds as booked entries, and each one was imported next to the purchase that settled it later: the same card purchase twice (crm#2076).",
  match: [
    // The hold's text tested by hand.
    /startsWith\(\s*['"`]Reservation /,
    /\/\^\s*(?:\\s\*)?Reservation/,
  ],
  sanctioned: ['lib/bank-sync/card-hold.ts'],
}
