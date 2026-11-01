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
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
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
 * verifikat?" (categorizeTransaction behind every categorize door, the
 * manual book route, link-journal-entry). A row is already booked when
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
  tx: AnchoredTransaction,
): Promise<TransactionBookableVerdict> {
  const anchors = await readPostedAnchors(supabase, companyId, tx)
  if (anchors === 'read_error') {
    return { ok: false, code: 'TRANSACTION_ALREADY_CATEGORIZED', journalEntryId: null, via: 'read_error' }
  }
  if (anchors.pointer) {
    return { ok: false, code: 'TRANSACTION_ALREADY_CATEGORIZED', journalEntryId: anchors.pointer.id, via: 'pointer' }
  }
  if (anchors.linked[0]) {
    return { ok: false, code: 'TRANSACTION_ALREADY_CATEGORIZED', journalEntryId: anchors.linked[0].id, via: 'link' }
  }
  return { ok: true }
}

interface AnchoredTransaction {
  id: string
  journal_entry_id: string | null
  transaction_voucher_links?: Array<{ journal_entry_id: string; role?: string | null }> | null
}

/** What decideBankRowRebooking reads off a row: a door's select carries these columns. */
export interface GatedBankRow extends AnchoredTransaction {
  reconciliation_method?: string | null
  is_ignored?: boolean | null
}

/** A posted verifikat that anchors a bank row, as the gates read it. */
interface PostedAnchor {
  id: string
  source_type: string | null
  source_id: string | null
  voucher_series: string | null
  voucher_number: number | null
}

/**
 * The posted verifikat a bank row is anchored to: the pointer's, and every
 * other one a 'bank_line' junction row names (in link order). 'read_error'
 * when a read failed: the gates fail closed on it.
 */
async function readPostedAnchors(
  supabase: SupabaseClient,
  companyId: string,
  tx: AnchoredTransaction,
): Promise<{ pointer: PostedAnchor | null; linked: PostedAnchor[] } | 'read_error'> {
  let links = tx.transaction_voucher_links
  if (!Array.isArray(links)) {
    const { data, error } = await supabase
      .from('transaction_voucher_links')
      .select('journal_entry_id, role')
      .eq('company_id', companyId)
      .eq('transaction_id', tx.id)
    if (error) return 'read_error'
    links = (data ?? []) as Array<{ journal_entry_id: string; role?: string | null }>
  }

  const linkIds = links
    .filter((row) => (row.role ?? 'bank_line') === 'bank_line')
    .map((row) => row.journal_entry_id)
  const ids = [...new Set([tx.journal_entry_id, ...linkIds].filter((id): id is string => !!id))]
  if (ids.length === 0) return { pointer: null, linked: [] }

  const { data: entries, error: entriesError } = await supabase
    .from('journal_entries')
    .select('id, status, source_type, source_id, voucher_series, voucher_number')
    .eq('company_id', companyId)
    .in('id', ids)
  if (entriesError) return 'read_error'

  const posted = new Map(
    ((entries ?? []) as Array<PostedAnchor & { status: string }>)
      .filter((entry) => entry.status === 'posted')
      .map((entry) => [entry.id, entry]),
  )
  const pointer = (tx.journal_entry_id && posted.get(tx.journal_entry_id)) || null
  const linked = [...new Set(linkIds)]
    .filter((id) => id !== tx.journal_entry_id)
    .flatMap((id) => posted.get(id) ?? [])
  return { pointer, linked }
}

/**
 * How a refused row can be opened again, one answer per shape, verified door
 * by door in tests/pg/customer-bank-match-doors.pg.test.ts:
 *
 *   - uncategorize: the pointer's verifikat is undone by storno
 *     (POST /transactions/{id}/uncategorize, gnubok_uncategorize_transaction,
 *     or Återför on the verifikat), which also runs the payment mirror when
 *     that verifikat is a payment.
 *   - unlink: a link to a verifikat that stands on its own is taken off and
 *     the verifikat stays posted (Koppla bort, gnubok_reconcile_unmatch).
 *     Uncategorize would reverse that independent verifikat.
 *   - reverse_voucher: a row with no pointer, booked inside a samlingsverifikat
 *     or a verifikat of its own through a link. Uncategorize cannot reach it
 *     and Koppla bort refuses it: only a storno of the verifikat releases it,
 *     with every other row that verifikat explains (gnubok_reverse_journal_entry,
 *     Återför on the verifikat).
 *   - restore: an ignored row comes back with Återställ
 *     (gnubok_ignore_transaction restore: true,
 *     DELETE /transactions/{id}/ignore).
 */
export type BankRowUndo = 'uncategorize' | 'unlink' | 'reverse_voucher' | 'restore'

/** The gate's refusal, as a door maps it. */
export interface BankRowRefusal {
  outcome: 'refuse'
  /** The pointer, a bank_line link, a reconciliation link on the pointer, an ignored row, or a failed read. */
  via: 'pointer' | 'link' | 'reconciliation' | 'ignored' | 'read_error'
  /** The posted verifikat that books the row; null when none does or a read failed. */
  journalEntryId: string | null
  /** Its voucher label ("A12"), null when unnumbered or unread. */
  voucher: string | null
  replaceable: boolean
  /** How the row opens again; null after a failed read, where a retry is the answer. */
  undo: BankRowUndo | null
}

/**
 * What a door that books a NEW verifikat on a bank row may do with the row
 * (decideBankRowRebooking):
 *
 *   - open: nothing posted anchors the row; book.
 *   - replace: the row's own booking, which the caller asked to reverse:
 *     storno `journalEntryId`, then book.
 *   - refuse: the row is booked or ignored (or a read failed). `replaceable`
 *     says the booking is the row's own, so the door may offer to reverse it.
 */
export type BankRowRebooking =
  | { outcome: 'open' }
  | { outcome: 'replace'; journalEntryId: string }
  | BankRowRefusal

/**
 * The code a door answers a refusal with. An ignored row is one code on every
 * door, and so is a failed read: it says nothing about the row, so the answer
 * is a retry and an approval stays pending. A booked row is the door's own
 * code, which its caller already reads.
 */
export function bankRowRefusalCode(refusal: BankRowRefusal, alreadyBookedCode: string): string {
  if (refusal.via === 'ignored') return 'BANK_ROW_IGNORED'
  if (refusal.via === 'read_error') return 'BANK_ROW_READ_FAILED'
  return alreadyBookedCode
}

/**
 * The gate a door that books a new verifikat on a bank row asks first: is
 * the row already booked, and if so, may this request reverse that booking?
 * Same read as assertTransactionBookable (the pointer and the bank_line links
 * to a posted verifikat; a failed read refuses).
 *
 * An ignored row is refused here, by every door that passes its is_ignored:
 * it can carry no verifikat (CHECK transactions_is_ignored_no_journal_entry),
 * so the write after the posting failed and left a voucher behind it. The
 * categorize and book doors ask assertTransactionBookable instead: booking an
 * ignored row there is the person's way of taking it back, and they clear
 * is_ignored in the same write.
 *
 * Only the row's OWN booking can be reversed, and only when the caller asks
 * (`replace`): the pointer names a posted verifikat booked from this row
 * (source_type 'bank_transaction', source_id the row, which the categorize
 * and book doors write), the row is not a reconciliation link
 * (reconciliation_method set), and no bank_line link names another posted
 * verifikat. Everything else always refuses. A link-only row (a bulk-book
 * samlingsverifikat with N>1, a 1:N split) is booked by a verifikat that
 * explains other rows too, and a reconciliation link points at an
 * independent verifikat (an SIE import, a salary run, a hand booking) whose
 * storno would be an over-broad rättelse (BFL 5 kap 5 §). A pointer with no
 * method that names another source (a customer payment, an utlägg payout)
 * is not the row's own booking either: its storno would leave that record
 * settled without its verifikat.
 */
export async function decideBankRowRebooking(
  supabase: SupabaseClient,
  companyId: string,
  tx: GatedBankRow,
  opts: { replace: boolean },
): Promise<BankRowRebooking> {
  if (tx.is_ignored) {
    return { outcome: 'refuse', via: 'ignored', journalEntryId: null, voucher: null, replaceable: false, undo: 'restore' }
  }
  const anchors = await readPostedAnchors(supabase, companyId, tx)
  if (anchors === 'read_error') {
    return { outcome: 'refuse', via: 'read_error', journalEntryId: null, voucher: null, replaceable: false, undo: null }
  }
  const { pointer, linked } = anchors
  const refuse = (
    via: 'pointer' | 'link' | 'reconciliation',
    entry: PostedAnchor,
    undo: BankRowUndo,
    replaceable = false,
  ): BankRowRebooking => ({
    outcome: 'refuse',
    via,
    journalEntryId: entry.id,
    voucher: anchorVoucherLabel(entry),
    replaceable,
    undo,
  })
  if (!pointer) {
    if (!linked[0]) return { outcome: 'open' }
    return refuse('link', linked[0], tx.reconciliation_method ? 'unlink' : 'reverse_voucher')
  }
  if (tx.reconciliation_method) return refuse('reconciliation', pointer, 'unlink')
  const own = isBookedFromRow(pointer, tx.id) && linked.length === 0
  if (own && opts.replace) return { outcome: 'replace', journalEntryId: pointer.id }
  return refuse('pointer', pointer, 'uncategorize', own)
}

/**
 * decideBankRowRebooking for a door that holds only the row's id. A row that
 * is not there is open: the door's own write refuses it, as it always did. A
 * failed read refuses, like every read behind this gate.
 */
export async function decideBankRowRebookingById(
  supabase: SupabaseClient,
  companyId: string,
  transactionId: string,
  opts: { replace: boolean },
): Promise<BankRowRebooking> {
  const { data, error } = await supabase
    .from('transactions')
    .select('id, journal_entry_id, reconciliation_method, is_ignored, transaction_voucher_links(journal_entry_id, role)')
    .eq('id', transactionId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) {
    return { outcome: 'refuse', via: 'read_error', journalEntryId: null, voucher: null, replaceable: false, undo: null }
  }
  if (!data) return { outcome: 'open' }
  return decideBankRowRebooking(supabase, companyId, data as GatedBankRow, opts)
}

/**
 * The verifikat was booked from this bank row (the categorize and book
 * doors write source_type 'bank_transaction' with the row as source_id):
 * the row's own booking, not a link to a verifikat that existed before.
 */
export function isBookedFromRow(
  entry: { source_type?: string | null; source_id?: string | null },
  transactionId: string,
): boolean {
  return entry.source_type === 'bank_transaction' && entry.source_id === transactionId
}

function anchorVoucherLabel(entry: PostedAnchor): string | null {
  return entry.voucher_number ? formatVoucher(entry) : null
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
  return formatVoucher(je)
}
