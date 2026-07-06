/**
 * Centralised predicate for "is this bank transaction anchored to a
 * verifikat?": single source of truth that readers across the inbox,
 * history list, and MCP filters use to decide whether a tx is unbooked
 * (needs categorisation) vs already attached to a journal entry.
 *
 * Three storage locations to consider, all of which can independently
 * make a tx "booked":
 *
 *  1. transactions.journal_entry_id: the 1:1 case (single tx → single
 *     verifikat via categorisation, match-invoice, or match-supplier-invoice).
 *
 *  2. invoice_payments / supplier_invoice_payments: the multi-allocation
 *     case (PR #603's match_batch_allocate). One tx with multiple payment
 *     rows pointing at the same combined verifikat; the row in transactions
 *     itself has journal_entry_id = NULL because no single invoice ID
 *     captures the full picture.
 *
 *  3. transaction_voucher_links: the N-tx-to-1-JE case (the bulk-book
 *     flow). Same combined verifikat, multiple bank lines, each tx's row
 *     in transactions has journal_entry_id = NULL for N>1.
 *
 * If a reader only checks `tx.journal_entry_id`, every multi-tx and
 * multi-allocation case falsely shows as "unbooked" and would re-surface
 * in the inbox or hide the "Open verifikat" affordance. Use this helper
 * to avoid that.
 *
 * The Postgres mirror is `public.is_transaction_booked(uuid)`
 * (migration 20260529120000_transaction_voucher_links.sql): same
 * predicate, three storage locations, in SQL.
 */

interface TxLike {
  id: string
  journal_entry_id: string | null
}

interface PaymentLike {
  transaction_id: string | null
}

interface VoucherLinkLike {
  transaction_id: string
}

/**
 * @param tx - the bank transaction row (must include `journal_entry_id`)
 * @param payments - rows from invoice_payments AND supplier_invoice_payments
 *                   filtered to ones whose transaction_id might equal tx.id.
 *                   May be empty if the reader didn't fetch them.
 * @param voucherLinks - rows from transaction_voucher_links filtered to ones
 *                       whose transaction_id might equal tx.id. May be empty.
 */
export function isTransactionBooked(
  tx: TxLike,
  payments: PaymentLike[] = [],
  voucherLinks: VoucherLinkLike[] = [],
): boolean {
  if (tx.journal_entry_id != null) return true
  if (payments.some((p) => p.transaction_id === tx.id)) return true
  if (voucherLinks.some((v) => v.transaction_id === tx.id)) return true
  return false
}

/**
 * Resolve the "primary" journal_entry_id to link to from the UI when a
 * tx has multiple anchoring rows. Order of precedence:
 *
 *   1. tx.journal_entry_id (the 1:1 case, always the right answer)
 *   2. First voucher-link row (multi-tx bulk-book points all txs at one JE)
 *   3. First payment row (multi-allocation puts each invoice on its own
 *      payment row but they all share the combined verifikat)
 *
 * Returns null if none of the three are present, in which case the tx
 * is not booked at all.
 */
export function getPrimaryJournalEntryId(
  tx: TxLike,
  payments: { transaction_id: string | null; journal_entry_id: string | null }[] = [],
  voucherLinks: { transaction_id: string; journal_entry_id: string }[] = [],
): string | null {
  if (tx.journal_entry_id != null) return tx.journal_entry_id
  const link = voucherLinks.find((v) => v.transaction_id === tx.id)
  if (link) return link.journal_entry_id
  const payment = payments.find((p) => p.transaction_id === tx.id && p.journal_entry_id != null)
  return payment?.journal_entry_id ?? null
}
