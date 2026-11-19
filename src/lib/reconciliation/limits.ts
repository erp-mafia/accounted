/**
 * Size limits shared by every door that settles ONE bank row against several
 * documents. Pure constants: the API schemas import them, and those reach
 * client bundles.
 */
import { MAX_ROWS_PER_REQUEST } from '@/lib/lists/collect-pages'

/**
 * Most verifikat one bank row can be split across (the reconciliation 1:N
 * link and the transactions-page link), and most invoices one bank row can
 * pay in a batch match. The largest such row is a ROT/RUT payout:
 * Skatteverket pays every beslut of the day in one transfer, one invoice per
 * buyer, and a begäran filed in another system is settled here invoice by
 * invoice on 1510. 200, sized to one payout of 138 verifikat (crm#1144),
 * refused three bundled begäran of up to 100 ärenden each (crm#1297).
 *
 * The cap is what one verifikat can carry and still be read whole. A batch
 * match books up to two lines per invoice (1510 or 2440, plus an öre or
 * kursdifferens line) and one bank line, and the rättelse preview and the
 * reconciliation read a verifikat's lines in one select, which PostgREST cuts
 * at MAX_ROWS_PER_REQUEST without an error. 499 invoices make at most 999
 * lines.
 *
 * The reconciliation view pages at MAX_ITEMS_LIMIT, below this, so it never
 * offers a selection the server refuses. The per-invoice events after the
 * RPC take about 70 ms each, so the routes that commit a batch export a
 * maxDuration above the 60 s platform default.
 */
export const MAX_BANK_ROW_SPLIT = Math.floor((MAX_ROWS_PER_REQUEST - 1) / 2)

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
