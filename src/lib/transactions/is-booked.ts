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
import type { SupabaseClient } from '@supabase/supabase-js'

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

/**
 * The re-booking guards' narrower question: does an embedded
 * transaction_voucher_links set hold a 'bank_line' row? A bank_line row is a
 * slice of the row's bank amount (the bulk-book samlingsverifikat, the 1:N
 * split of issue #1553), so its presence means the row is booked and a
 * second booking (manualLink, categorize, link-journal-entry) must refuse.
 * Rows with role 'other' (a residual booking, lib/reconciliation/residual.ts)
 * or 'clearing' are supplementary anchors. Since #2061 the engine drops them
 * together with the pointer when the main verifikat is reversed, so a row
 * with only a supplementary anchor is a leftover from before that change;
 * such a row must still not be stranded with no way to re-book it. The list
 * readers (fetchJunctionLinkedTxIds, is_transaction_booked()) keep counting
 * every role, and agree with the worklist because no released row keeps one.
 */
export function hasBankLineJunctionRow(
  rows: Array<{ role?: string | null }> | null | undefined,
): boolean {
  if (!Array.isArray(rows)) return false
  return rows.some((row) => (row.role ?? 'bank_line') === 'bank_line')
}

export type TransactionBookableVerdict =
  | { ok: true }
  | {
      ok: false
      code: 'TRANSACTION_ALREADY_CATEGORIZED'
      /** The posted verifikat that already books the row; null when a read failed. */
      journalEntryId: string | null
      /** Which anchor names it: the 1:1 pointer or a bank_line junction row. */
      via: 'pointer' | 'link' | 'read_error'
    }

/**
 * The booking doors' single answer to "may this bank row get a NEW
 * verifikat?" (categorize, v1 categorize, batch-categorize, the manual book
 * route, and the shared categorize core). A row is already booked when
 *
 *   - its pointer (transactions.journal_entry_id) names a posted verifikat, or
 *   - a 'bank_line' transaction_voucher_links row names a posted verifikat
 *     (a bulk-book samlingsverifikat, a 1:N split, or a correction that
 *     re-pointed the link, see relinkTransactionsToEntry).
 *
 * A pointer or link to a verifikat that is no longer posted (reversed by a
 * storno, the uncategorize path) does not count: the row reads as unbooked in
 * the UI and must be bookable again (issue #988). Bulk-book with N=1 writes the
 * pointer AND a link to the same verifikat; that is one booking, reported once.
 * Supplementary roles ('other', 'clearing') never count, see
 * hasBankLineJunctionRow.
 *
 * Checking only the pointer misses every link-only row, which is how a
 * bulk-booked row got a second verifikat. A failed read fails closed (refuses
 * the booking), like hasLiveJournalEntryLink: a retry is cheap, a second
 * verifikat is a storno.
 *
 * Pass `tx.transaction_voucher_links` when the caller already embedded them on
 * its transactions read; otherwise they are read here.
 */
export async function assertTransactionBookable(
  supabase: SupabaseClient,
  companyId: string,
  tx: {
    id: string
    journal_entry_id: string | null
    transaction_voucher_links?: Array<{ journal_entry_id: string; role?: string | null }> | null
  },
): Promise<TransactionBookableVerdict> {
  let links = tx.transaction_voucher_links
  if (!Array.isArray(links)) {
    const { data, error } = await supabase
      .from('transaction_voucher_links')
      .select('journal_entry_id, role')
      .eq('company_id', companyId)
      .eq('transaction_id', tx.id)
    if (error) {
      return { ok: false, code: 'TRANSACTION_ALREADY_CATEGORIZED', journalEntryId: null, via: 'read_error' }
    }
    links = (data ?? []) as Array<{ journal_entry_id: string; role?: string | null }>
  }

  const linkIds = links
    .filter((row) => (row.role ?? 'bank_line') === 'bank_line')
    .map((row) => row.journal_entry_id)
  const ids = [...new Set([tx.journal_entry_id, ...linkIds].filter((id): id is string => !!id))]
  if (ids.length === 0) return { ok: true }

  const { data: entries, error: entriesError } = await supabase
    .from('journal_entries')
    .select('id, status')
    .eq('company_id', companyId)
    .in('id', ids)
  if (entriesError) {
    return { ok: false, code: 'TRANSACTION_ALREADY_CATEGORIZED', journalEntryId: null, via: 'read_error' }
  }

  const posted = new Set(
    ((entries ?? []) as Array<{ id: string; status: string }>)
      .filter((entry) => entry.status === 'posted')
      .map((entry) => entry.id),
  )
  if (tx.journal_entry_id && posted.has(tx.journal_entry_id)) {
    return { ok: false, code: 'TRANSACTION_ALREADY_CATEGORIZED', journalEntryId: tx.journal_entry_id, via: 'pointer' }
  }
  const linked = linkIds.find((id) => posted.has(id))
  if (linked) {
    return { ok: false, code: 'TRANSACTION_ALREADY_CATEGORIZED', journalEntryId: linked, via: 'link' }
  }
  return { ok: true }
}

/**
 * A transaction_voucher_links row as PostgREST embeds it on a transactions
 * select (`transaction_voucher_links(journal_entry_id, role, ...)`): no
 * transaction_id, because the parent row is the transaction. The optional
 * `journal_entry` is the nested voucher label when the reader asked for it.
 */
export interface EmbeddedVoucherLink {
  journal_entry_id: string
  role?: string | null
  journal_entry?: { voucher_series: string | null; voucher_number: number | null } | null
}

interface TxWithEmbeddedLinks {
  journal_entry_id: string | null
  transaction_voucher_links?: EmbeddedVoucherLink[] | null
}

/**
 * Every verifikat a row is anchored to, for a row read WITH the junction
 * embedded: the 1:1 pointer first, then each bank_line junction row (a row
 * split over several verifikat, #1553, or bulk-booked into a
 * samlingsverifikat), deduplicated. Empty means unbooked. Readers that only
 * check `journal_entry_id` show a split row as "Ej bokförd" (crm#48).
 *
 * Supplementary roles ('other', 'clearing') do not count here: they are
 * residual anchors, not the booking of the bank line itself (see
 * hasBankLineJunctionRow).
 */
export function getLinkedJournalEntryIds(tx: TxWithEmbeddedLinks): string[] {
  const out: string[] = []
  if (tx.journal_entry_id != null) out.push(tx.journal_entry_id)
  for (const link of tx.transaction_voucher_links ?? []) {
    if ((link.role ?? 'bank_line') !== 'bank_line') continue
    if (!out.includes(link.journal_entry_id)) out.push(link.journal_entry_id)
  }
  return out
}

/** Display label for an embedded link's verifikat ("V200"), null when the
 *  reader did not embed journal_entry or the voucher is unnumbered. */
export function embeddedVoucherLabel(link: EmbeddedVoucherLink): string | null {
  const je = link.journal_entry
  if (!je || je.voucher_number == null) return null
  return `${je.voucher_series ?? ''}${je.voucher_number}`
}
