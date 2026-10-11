/**
 * Size limits shared by every door that settles ONE bank row against several
 * documents. Pure constants: the API schemas import them, and those reach
 * client bundles.
 */

/**
 * Most verifikat one bank row can be split across (the reconciliation 1:N
 * link and the transactions-page link), and most invoices one bank row can
 * pay in a batch match. A ROT/RUT payout from Skatteverket pays one invoice
 * per buyer, so one bank row can carry 100+ of them: the old caps of 50 and
 * 100 refused a real payout of 138 verifikat (crm#1144). 200 is also the
 * reconciliation view's page size (MAX_ITEMS_LIMIT), so the view never offers
 * a selection the server refuses.
 */
export const MAX_BANK_ROW_SPLIT = 200

/**
 * Most verifikat ids one links request may name across all its pairs: the
 * bound that 200 pairs of at most 50 verifikat gave before the split cap
 * rose, kept so a larger split does not make the whole request, and the
 * stage-time dry run of it, larger too.
 */
export const MAX_LINK_REQUEST_ENTRIES = 10_000

/**
 * Ids per PostgREST `.in()` read on these paths. Ids travel in the GET query
 * string, and a gateway with the stock 8 KB header buffer answers a long one
 * with 414 before PostgREST sees it (#2395); a split of MAX_BANK_ROW_SPLIT
 * verifikat is read in slices of this size.
 */
export const ID_READ_CHUNK = 100
