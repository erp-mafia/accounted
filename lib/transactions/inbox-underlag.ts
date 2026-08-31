/**
 * Inbox-underlag lifecycle for booked bank transactions.
 *
 * An invoice_inbox_items row leaves the active inbox ("Att göra") only when a
 * journal entry consumes it: created_journal_entry_id (or
 * created_supplier_invoice_id) is what deriveInboxStatus and the count pills
 * read. Historically only categorizeTransactionCore stamped that column, so a
 * matched item whose transaction was booked through any OTHER path (the /book
 * route, bulk-book, link-to-existing-voucher, or an attach that landed after
 * booking) stayed "linked" forever, pointing at a transaction that had left
 * the transactions work list (the 2026-08-12 user report).
 *
 * This module is the single implementation all booking and attach paths share:
 *
 *  - resolveBookedJournalEntryIds: which verifikat anchors each transaction,
 *    covering both direct journal_entry_id and the bulk-book
 *    transaction_voucher_links shape (see lib/transactions/is-booked.ts for
 *    why the column alone is not "booked").
 *  - propagateUnderlagForBookedTransaction: anchor the transaction's pinned
 *    document (transactions.document_id) and link matched items' documents to
 *    the verifikat (BFL 5 kap 6 §: the verifikation must reference its
 *    underlag), stamping created_journal_entry_id on the items. The pinned-doc
 *    leg matters because a document attached directly to a transaction has no
 *    inbox item to carry it: without it, booking through the manual dialog
 *    left document_attachments.journal_entry_id null and every underlag
 *    surface read "Underlag saknas" (the 2026-08-13 user report).
 *  - completeInboxItemsForBookedTransaction: the attach-time entry point that
 *    resolves first and propagates only when the transaction is booked.
 *
 * Everything here is best-effort by contract: the verifikat is already posted
 * when these run, so a failure is logged and repaired by re-running, never
 * allowed to roll back a compliant booking. Note that
 * invoice_inbox_items.created_journal_entry_id is UNIQUE (migration
 * 20260515090000): when several items share one samlingsverifikat only the
 * first stamp can land, so the stamp is a fast path, not the source of truth:
 * the inbox list ALSO derives "booked" from the matched transaction's state
 * via resolveBookedJournalEntryIds (GET /items enrichment).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { linkToJournalEntry } from '@/lib/core/documents/document-service'
import { createLogger } from '@/lib/logger'

const log = createLogger('transactions/inbox-underlag')

/** Postgres unique_violation: a sibling item already claimed this verifikat. */
const UNIQUE_VIOLATION = '23505'

/**
 * Map each booked transaction id to the journal entry that anchors it:
 * transactions.journal_entry_id first, then transaction_voucher_links
 * (the N-tx-to-1-JE bulk-book shape). Unbooked transactions are absent
 * from the returned map.
 *
 * The multi-allocation payment shape (invoice_payments /
 * supplier_invoice_payments) is deliberately not resolved here: those flows
 * consume inbox items through their own supplier-invoice lifecycle
 * (created_supplier_invoice_id), not through this one.
 */
export async function resolveBookedJournalEntryIds(
  supabase: SupabaseClient,
  companyId: string,
  txIds: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  if (txIds.length === 0) return map

  const { data: txs, error: txError } = await supabase
    .from('transactions')
    .select('id, journal_entry_id')
    .in('id', txIds)
    .eq('company_id', companyId)
  if (txError) {
    log.error('Failed to resolve transactions for booked-entry lookup', {
      company_id: companyId,
      error: txError.message,
    })
    return map
  }
  const unbooked: string[] = []
  for (const tx of (txs ?? []) as Array<{ id: string; journal_entry_id: string | null }>) {
    if (tx.journal_entry_id) map.set(tx.id, tx.journal_entry_id)
    else unbooked.push(tx.id)
  }
  if (unbooked.length === 0) return map

  const voucherLinked = await resolveVoucherLinkedEntryIds(supabase, companyId, unbooked)
  for (const [txId, journalEntryId] of voucherLinked) {
    if (!map.has(txId)) map.set(txId, journalEntryId)
  }
  return map
}

/**
 * The transaction_voucher_links leg of the resolution alone: for callers that
 * already hold transactions.journal_entry_id and only need the bulk-book
 * fallback.
 */
export async function resolveVoucherLinkedEntryIds(
  supabase: SupabaseClient,
  companyId: string,
  txIds: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  if (txIds.length === 0) return map
  const { data: links, error: linkError } = await supabase
    .from('transaction_voucher_links')
    .select('transaction_id, journal_entry_id')
    .in('transaction_id', txIds)
    .eq('company_id', companyId)
  if (linkError) {
    log.error('Failed to resolve voucher links for booked-entry lookup', {
      company_id: companyId,
      error: linkError.message,
    })
    return map
  }
  for (const link of (links ?? []) as Array<{ transaction_id: string; journal_entry_id: string }>) {
    if (!map.has(link.transaction_id)) map.set(link.transaction_id, link.journal_entry_id)
  }
  return map
}

/**
 * Whether an inbox item's underlag actually references the verifikat that
 * booked its transaction. Both readers of "this item is booked" need it:
 *
 *  - the inbox list enrichment, so an item whose document never reached the
 *    verifikat (a failed link, or a document anchored to a DIFFERENT
 *    verifikat) keeps showing in "Att göra" instead of reading as booked on
 *    the transaction's word alone (#1548)
 *  - the reconciliation pass, to classify what a re-run repaired and what
 *    still needs a human
 *
 *  'anchored'           : document_attachments.journal_entry_id equals the
 *                         verifikat, or the item carries no document (there
 *                         is no underlag to link; the stamp is all that is
 *                         missing)
 *  'unlinked'           : the document references no verifikat yet
 *                         (transient: a re-run of the propagation links it)
 *  'unlinked_locked'    : unlinked, and the verifikat sits in a closed or
 *                         locked period, so enforce_period_lock_documents
 *                         rejects the link until someone unlocks the period
 *                         (not transient: a re-run fails the same way)
 *  'anchored_elsewhere' : the document references another verifikat
 *                         (permanent: never stolen, a human decides)
 *
 * One batched select for N items, plus one lock-state read for the verifikat
 * of every unlinked item. Items whose document row cannot be read (select
 * error) are absent from the map: callers treat absence as unknown, never as
 * anchored. A failed lock-state read leaves the item 'unlinked' (the
 * propagation is what fails safely, so erring towards "retry" is harmless).
 */
export type UnderlagAnchoring = 'anchored' | 'unlinked' | 'unlinked_locked' | 'anchored_elsewhere'

export interface UnderlagAnchoringResult {
  status: UnderlagAnchoring
  /** The verifikat the document currently references, if any. */
  document_journal_entry_id: string | null
}

export async function resolveUnderlagAnchoring(
  supabase: SupabaseClient,
  companyId: string,
  items: Array<{ id: string; document_id: string | null; journalEntryId: string }>,
): Promise<Map<string, UnderlagAnchoringResult>> {
  const map = new Map<string, UnderlagAnchoringResult>()
  const withDocument: typeof items = []
  for (const item of items) {
    if (item.document_id) withDocument.push(item)
    else map.set(item.id, { status: 'anchored', document_journal_entry_id: null })
  }
  if (withDocument.length === 0) return map

  const docIds = Array.from(new Set(withDocument.map((i) => i.document_id as string)))
  const { data: docs, error } = await supabase
    .from('document_attachments')
    .select('id, journal_entry_id')
    .in('id', docIds)
    .eq('company_id', companyId)
  if (error) {
    log.error('Failed to resolve document anchoring for inbox items', {
      company_id: companyId,
      error: error.message,
    })
    return map
  }
  const entryByDoc = new Map<string, string | null>()
  for (const doc of (docs ?? []) as Array<{ id: string; journal_entry_id: string | null }>) {
    entryByDoc.set(doc.id, doc.journal_entry_id)
  }
  const unlinked: typeof items = []
  for (const item of withDocument) {
    const docId = item.document_id as string
    if (!entryByDoc.has(docId)) continue // unreadable row: unknown, not anchored
    const current = entryByDoc.get(docId) ?? null
    const status: UnderlagAnchoring =
      current === null
        ? 'unlinked'
        : current === item.journalEntryId
          ? 'anchored'
          : 'anchored_elsewhere'
    if (status === 'unlinked') unlinked.push(item)
    map.set(item.id, { status, document_journal_entry_id: current })
  }
  if (unlinked.length === 0) return map

  const lockedEntryIds = await resolveLockedJournalEntryIds(
    supabase,
    companyId,
    Array.from(new Set(unlinked.map((i) => i.journalEntryId))),
  )
  for (const item of unlinked) {
    if (lockedEntryIds.has(item.journalEntryId)) {
      map.set(item.id, { status: 'unlinked_locked', document_journal_entry_id: null })
    }
  }
  return map
}

/**
 * Which of the given verifikat sit in a closed or locked fiscal period: the
 * same (is_closed, locked_at) pair enforce_period_lock_documents checks, so
 * a document link to them is known to fail before it is attempted. A read
 * error yields an empty set (nothing is reported as locked on a guess).
 */
async function resolveLockedJournalEntryIds(
  supabase: SupabaseClient,
  companyId: string,
  entryIds: string[],
): Promise<Set<string>> {
  const locked = new Set<string>()
  if (entryIds.length === 0) return locked
  const { data, error } = await supabase
    .from('journal_entries')
    // fiscal_periods also points back at journal_entries (closing_entry_id,
    // opening_balance_entry_id), so PostgREST refuses the bare embed as
    // ambiguous; name the FK explicitly.
    .select('id, fiscal_period:fiscal_periods!journal_entries_fiscal_period_id_fkey(is_closed, locked_at)')
    .in('id', entryIds)
    .eq('company_id', companyId)
  if (error) {
    log.error('Failed to resolve period lock state for inbox underlag anchoring', {
      company_id: companyId,
      error: error.message,
    })
    return locked
  }
  type PeriodLock = { is_closed?: boolean | null; locked_at?: string | null }
  for (const row of (data ?? []) as Array<{ id: string; fiscal_period: PeriodLock | PeriodLock[] | null }>) {
    const period = Array.isArray(row.fiscal_period) ? row.fiscal_period[0] : row.fiscal_period
    if (period?.is_closed || period?.locked_at) locked.add(row.id)
  }
  return locked
}

/**
 * Anchor one document to the verifikat, with the guard semantics every
 * booking path shares: a document already pointing at THIS verifikat is a
 * no-op (a same-value rewrite would trip the period-lock trigger), a document
 * anchored to ANOTHER verifikat is never stolen, and a failed link is
 * reported so the caller can withhold any consumed-stamp. Returns true when
 * the document ends up referencing the verifikat.
 */
async function anchorDocumentToJournalEntry(
  supabase: SupabaseClient,
  companyId: string,
  documentId: string,
  journalEntryId: string,
  logContext: Record<string, unknown>,
): Promise<boolean> {
  const { data: doc } = await supabase
    .from('document_attachments')
    .select('journal_entry_id')
    .eq('id', documentId)
    .eq('company_id', companyId)
    .maybeSingle()
  const currentDocEntryId = (doc?.journal_entry_id as string | null) ?? null
  if (currentDocEntryId === journalEntryId) return true
  if (currentDocEntryId !== null) {
    // Anchored to another verifikat: preserved, never stolen (BFL 5 kap 6-7 §).
    log.warn('Document already anchored to another verifikat; leaving it', {
      ...logContext,
      document_id: documentId,
      document_journal_entry_id: currentDocEntryId,
      journal_entry_id: journalEntryId,
    })
    return false
  }
  try {
    await linkToJournalEntry(supabase, companyId, documentId, journalEntryId)
    return true
  } catch (err) {
    log.error('Failed to link document to journal entry', {
      ...logContext,
      document_id: documentId,
      journal_entry_id: journalEntryId,
      error: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}

/**
 * Propagate the underlag onto the verifikat that booked a transaction.
 * Without this, BFL 7 kap is violated: a verifikation exists with no underlag
 * attached even though the user explicitly linked a document (or an inbox
 * item with a document) to this transaction. We:
 *   1. anchor the transaction's own pinned document (transactions.document_id)
 *      when it does not reference a verifikat yet: a document attached
 *      directly to the transaction has no inbox item, so nothing else carries
 *      it onto the verifikat
 *   2. find the inbox item(s) where matched_transaction_id = txId that no
 *      journal entry or supplier invoice has consumed yet
 *   3. for each item with a document_id, set
 *      document_attachments.journal_entry_id = journalEntryId, skipped when
 *      the document already points at a verifikat: a same-value rewrite would
 *      trip the period-lock trigger, and a different verifikat's underlag is
 *      never stolen
 *   4. stamp invoice_inbox_items.created_journal_entry_id so the inbox row
 *      visibly moves to "Bokförda" and shows "Öppna verifikation"
 * Errors are logged but never fail the caller: the verifikation itself is
 * already posted, and the link can be repaired by re-running this step.
 */
export async function propagateUnderlagForBookedTransaction(
  supabase: SupabaseClient,
  companyId: string,
  txId: string,
  journalEntryId: string,
): Promise<void> {
  try {
    // The pin is read fresh here (not passed in from the caller's pre-booking
    // snapshot) so an attach that lands concurrently with the booking is
    // still anchored. The bulk-book RPC already anchors pins atomically;
    // there this read finds the doc pointing at the same verifikat and no-ops.
    const { data: tx } = await supabase
      .from('transactions')
      .select('document_id')
      .eq('id', txId)
      .eq('company_id', companyId)
      .maybeSingle()
    const pinnedDocumentId = (tx?.document_id as string | null) ?? null
    if (pinnedDocumentId) {
      await anchorDocumentToJournalEntry(supabase, companyId, pinnedDocumentId, journalEntryId, {
        transaction_id: txId,
        source: 'transaction_pin',
      })
    }

    const { data: matchedInboxItems } = await supabase
      .from('invoice_inbox_items')
      .select('id, document_id')
      .eq('company_id', companyId)
      .eq('matched_transaction_id', txId)
      .is('created_journal_entry_id', null)
      .is('created_supplier_invoice_id', null)
    for (const inbox of (matchedInboxItems ?? []) as Array<{
      id: string
      document_id: string | null
    }>) {
      // Whether this item's underlag actually references a verifikat. The
      // stamp below is conditional on it: stamping after a FAILED document
      // link would hide the item from every future run of this same query
      // (.is('created_journal_entry_id', null)), making the promised
      // "repaired by re-running" impossible and leaving a posted
      // verifikation with no underlag reference (BFL 5 kap 6-7 §) that
      // nothing surfaces anymore. Similarly, an item whose document is
      // anchored to a DIFFERENT verifikat is not stamped: that would hide
      // the very signal that the mismatch needs a human.
      let underlagSettled = true
      if (inbox.document_id) {
        underlagSettled = await anchorDocumentToJournalEntry(
          supabase,
          companyId,
          inbox.document_id,
          journalEntryId,
          { inbox_item_id: inbox.id, source: 'inbox_match' },
        )
      }
      if (!underlagSettled) continue
      // CAS on the null predicate so a concurrent stamp stays a no-op, and
      // unique_violation tolerated: on a samlingsverifikat only one item can
      // hold the UNIQUE created_journal_entry_id, and the inbox list derives
      // "booked" from the transaction's state for the rest.
      const { error: stampError } = await supabase
        .from('invoice_inbox_items')
        .update({ created_journal_entry_id: journalEntryId })
        .eq('id', inbox.id)
        .eq('company_id', companyId)
        .is('created_journal_entry_id', null)
      if (stampError && stampError.code !== UNIQUE_VIOLATION) {
        log.error('Failed to stamp inbox item created_journal_entry_id', {
          inbox_item_id: inbox.id,
          journal_entry_id: journalEntryId,
          error: stampError.message,
        })
      }
    }
  } catch (err) {
    log.error('Failed to propagate underlag from matched inbox items', err)
  }
}

/**
 * Attach-time entry point: when a document lands on (or an item is matched to)
 * a transaction that is ALREADY booked, resolve the anchoring verifikat and
 * complete the matched inbox items against it. No-op for unbooked
 * transactions: the booking paths call propagateUnderlagForBookedTransaction
 * themselves when the verifikat is created later.
 *
 * Callers that already read transactions.journal_entry_id pass it via
 * `directJournalEntryId` (null meaning "the column is null") to skip the
 * redundant transaction fetch; the voucher-link fallback still runs then.
 *
 * Returns the resolved journal entry id, or null when the transaction is not
 * booked.
 */
export async function completeInboxItemsForBookedTransaction(
  supabase: SupabaseClient,
  companyId: string,
  txId: string,
  opts?: { directJournalEntryId: string | null },
): Promise<string | null> {
  let journalEntryId: string | null
  if (opts) {
    journalEntryId =
      opts.directJournalEntryId ??
      (await resolveVoucherLinkedEntryIds(supabase, companyId, [txId])).get(txId) ??
      null
  } else {
    journalEntryId =
      (await resolveBookedJournalEntryIds(supabase, companyId, [txId])).get(txId) ?? null
  }
  if (!journalEntryId) return null
  await propagateUnderlagForBookedTransaction(supabase, companyId, txId, journalEntryId)
  return journalEntryId
}
