/**
 * A card hold in Nordea's booked list (crm#2076). Since 2026-11-20 Nordea
 * lists a card purchase that has not settled among its booked entries, as
 * status BOOK dated on the day it was made, its text starting "Reservation "
 * ("Reservation Kortköp FACEBK *7K4XZ2PQ9M"). The purchase itself arrives
 * later as its own entry ("Kortköp 261119 KAFFEROSTERIET"), so the hold taken as
 * booked is the same purchase twice. Not booked whatever status it carries.
 * Nordea only, and only at the start of the text: a settled purchase can
 * carry the word ("Kortköp 260824 Hotel Reservation"), and no other bank's
 * row in production has ever started with it.
 *
 * Read by the syncs of both aggregators. Each leaves holds out of its read
 * before the ids are built (Connect already does on the Open Payments side,
 * where that path's booked filter lives), and each tells ingest that a hold
 * stored before that is not booked (IngestOptions.isNotBooked): the two feeds
 * share one id namespace, so a hold either stored can meet a purchase of the
 * other.
 *
 * @param bankName bank_connections.bank_name ('Nordea', 'Nordea Corporate', 'Nordea First Card')
 */
export function isNordeaCardHold(bankName: string | null | undefined, description: string): boolean {
  return /^nordea\b/i.test(bankName?.trim() ?? '') && description.trimStart().startsWith('Reservation ')
}
