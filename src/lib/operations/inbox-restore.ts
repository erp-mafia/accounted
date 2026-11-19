/**
 * Putting a deleted inbox item back (Senast borttagna), behind the dashboard
 * routes (/api/inkorg/items/removed, /api/inkorg/items/restore) and the v1
 * operations (inbox-items.list-removed, inbox-items.restore).
 *
 * deleteInboxItem (lib/documents/inbox-item-actions.ts) removes the item's
 * row and keeps its document in the archive; the decision row the deletion
 * writes keeps the row as it was (suggestion_log.removed_item, migration
 * 20261117192013). Nothing else is stored:
 *
 *   - the list is those decision rows, newest first, one per document, minus
 *     what cannot be put back any more;
 *   - putting one back inserts the kept row again under its own id, so the
 *     primary key lets it happen once and "restored" is the item existing;
 *   - its reading, its mail fields, the door it came through, the keys a
 *     redelivery is recognised by and its created_at come back as they were:
 *     nothing is read again, and usage counts the item in the month it always
 *     belonged to (lib/usage/counters.ts counts items by created_at);
 *   - it comes back open: the bank row it was matched to and Arkiv's routing
 *     are not restored, a reading that was in flight is not waited for, and
 *     the pointer to the WhatsApp message it came in is left out (that row
 *     may be gone, and its redelivery window closed long ago).
 *
 * Refused when the item is in the inbox again or its document has another
 * item (one document, one inbox item: lib/documents/queued-inbox-item.ts),
 * when the document sits on a verifikat or is the underlag of a supplier
 * invoice, an expense claim or a bank transaction, and when a byte-identical
 * copy is queued or booked. The copy goes with its document, so a document
 * deleted from the archive has nothing left to put back. What a page may
 * promise before the removal (the confirm's sentence, Ångra, the approval
 * sentence of a staged removal) is removalCanBePutBack
 * (lib/documents/inbox-item-state.ts): an item without a document keeps no
 * copy at all.
 *
 * A dry run reads and checks; it writes nothing.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { readingSummary } from '@/lib/documents/inbox-item-actions'
import { withDocumentHold } from '@/lib/documents/inbox-item-state'
import { hasQueuedOrBookedTwin } from '@/lib/documents/queued-inbox-item'
import { UUID_RE } from '@/lib/invariants/uuid'
import { isMissingColumnError } from '@/lib/pending-operations/agent-reason'
import { proposeBankMatchForInboxItem } from './inbox-bank-match'
import type { OperationContext, OperationOutcome } from './types'

type Failure = Extract<OperationOutcome<never>, { ok: false }>

const NOT_FOUND: Failure = { ok: false, code: 'INBOX_ITEM_RESTORE_NOT_FOUND' }

function failed(error: unknown): Failure {
  return { ok: false, code: 'UNKNOWN_ERROR', error }
}

/** How many deleted items the list shows. */
export const REMOVED_INBOX_ITEMS_LIMIT = 20

/** How many of the newest deletions are read to fill the list: what was put back or taken since is skipped. */
const REMOVED_SCAN = 3 * REMOVED_INBOX_ITEMS_LIMIT

export interface RemovedInboxItem {
  inbox_item_id: string
  document_id: string
  file_name: string | null
  vendor_name: string | null
  amount: number | null
  currency: string | null
  email_from: string | null
  email_subject: string | null
  removed_at: string
  /** Who deleted it, as the decision row names them: the door and the person it acted for. */
  removed_by: { actor_type: string; user_id: string | null }
}

/** A deleted item and the document it carried. */
interface RemovedRef {
  inboxItemId: string
  documentId: string
}

/** What the kept document says, and why its item cannot be put back, if so. */
interface RestoreState {
  documents: Map<string, { file_name: string | null; sha256_hash: string | null }>
  refusals: Map<string, Failure>
}

/** The kept document, with the status of the verifikat that holds it (what withDocumentHold reads). */
interface DocumentRow {
  id: string
  file_name: string | null
  sha256_hash: string | null
  journal_entry_id: string | null
  entry?: { status: string | null } | Array<{ status: string | null }> | null
}

/**
 * Where each deleted item's document stands now, for the list (which hides
 * what cannot be put back) and the restore (which refuses it): one rule,
 * read for any number of items in six queries. A failed read throws: an
 * unknown hold never reads as "free to put back".
 */
async function readRestoreState(supabase: SupabaseClient, companyId: string, refs: readonly RemovedRef[]): Promise<RestoreState> {
  const state: RestoreState = { documents: new Map(), refusals: new Map() }
  if (refs.length === 0) return state
  const itemIds = refs.map((ref) => ref.inboxItemId)
  const documentIds = [...new Set(refs.map((ref) => ref.documentId))]
  const [documents, itemsById, itemsByDocument, supplierInvoices, expenseClaims, transactions] = await Promise.all([
    supabase
      .from('document_attachments')
      .select('id, file_name, sha256_hash, journal_entry_id, entry:journal_entries!document_attachments_journal_entry_id_fkey(status)')
      .eq('company_id', companyId)
      .in('id', documentIds),
    supabase.from('invoice_inbox_items').select('id').eq('company_id', companyId).in('id', itemIds),
    supabase.from('invoice_inbox_items').select('document_id').eq('company_id', companyId).in('document_id', documentIds),
    supabase.from('supplier_invoices').select('document_id').eq('company_id', companyId).in('document_id', documentIds),
    supabase.from('expense_claims').select('document_id').eq('company_id', companyId).in('document_id', documentIds),
    supabase.from('transactions').select('document_id').eq('company_id', companyId).in('document_id', documentIds),
  ])
  for (const read of [documents, itemsById, itemsByDocument, supplierInvoices, expenseClaims, transactions]) {
    if (read.error) throw read.error
  }
  const documentIdsOf = (read: { data: unknown }) =>
    new Set(((read.data ?? []) as Array<{ document_id: string | null }>).map((row) => row.document_id))
  const inInbox = new Set(((itemsById.data ?? []) as Array<{ id: string }>).map((row) => row.id))
  const queued = documentIdsOf(itemsByDocument)
  const onSupplierInvoice = documentIdsOf(supplierInvoices)
  const onExpenseClaim = documentIdsOf(expenseClaims)
  const onTransaction = documentIdsOf(transactions)
  // The verifikat that holds the document and still books it: the inbox's one reading of that link.
  const heldBy = new Map<string, string | null>()
  for (const row of (documents.data ?? []) as unknown as DocumentRow[]) {
    state.documents.set(row.id, { file_name: row.file_name ?? null, sha256_hash: row.sha256_hash ?? null })
    heldBy.set(row.id, withDocumentHold({ document_hold: { journal_entry_id: row.journal_entry_id, entry: row.entry } }).document_journal_entry_id)
  }
  for (const { inboxItemId, documentId } of refs) {
    const journalEntryId = heldBy.get(documentId)
    // The copy goes with its document, so a missing one was deleted this instant.
    if (journalEntryId === undefined) state.refusals.set(inboxItemId, NOT_FOUND)
    else if (inInbox.has(inboxItemId) || queued.has(documentId)) state.refusals.set(inboxItemId, { ok: false, code: 'INBOX_ITEM_RESTORE_IN_INBOX' })
    else if (journalEntryId) state.refusals.set(inboxItemId, { ok: false, code: 'INBOX_ITEM_RESTORE_BOOKED', details: { journal_entry_id: journalEntryId } })
    else if (onSupplierInvoice.has(documentId)) state.refusals.set(inboxItemId, { ok: false, code: 'INBOX_ITEM_RESTORE_LINKED', details: { linked_to: 'supplier_invoice' } })
    else if (onExpenseClaim.has(documentId)) state.refusals.set(inboxItemId, { ok: false, code: 'INBOX_ITEM_RESTORE_LINKED', details: { linked_to: 'expense_claim' } })
    else if (onTransaction.has(documentId)) state.refusals.set(inboxItemId, { ok: false, code: 'INBOX_ITEM_RESTORE_LINKED', details: { linked_to: 'bank_transaction' } })
  }
  return state
}

const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null

interface RemovedListRow {
  created_at: string
  actor_type: string
  resolved_by: string | null
  document_id: string | null
  removed_item_id: string | null
  email_from: string | null
  email_subject: string | null
  supplier: unknown
  invoice: unknown
  totals: unknown
}

/**
 * The deleted items that can still be put back, newest first, at most
 * REMOVED_INBOX_ITEMS_LIMIT: one per document (its latest deletion), without
 * the ones that are back in the inbox or whose document something else took
 * since. Read from the newest REMOVED_SCAN deletions, so a company that put
 * most of them back sees fewer than the limit. Items deleted before the copy
 * was kept (or while the database has no column for it yet) are not listed.
 * A byte-identical copy that is queued or booked is only found when the item
 * is put back: the list does not read every file's hash twins.
 */
export async function listRemovedInboxItems(ctx: OperationContext): Promise<OperationOutcome<{ removed_items: RemovedInboxItem[] }>> {
  const { data, error } = await ctx.supabase
    .from('suggestion_log')
    .select(
      'created_at, actor_type, resolved_by, document_id, removed_item_id:removed_item->>id, email_from:removed_item->>email_from, email_subject:removed_item->>email_subject, supplier:removed_item->extracted_data->supplier, invoice:removed_item->extracted_data->invoice, totals:removed_item->extracted_data->totals',
    )
    .eq('company_id', ctx.companyId)
    .not('removed_item', 'is', null)
    .order('created_at', { ascending: false })
    .limit(REMOVED_SCAN)
  if (error) return isMissingColumnError(error) ? { ok: true, data: { removed_items: [] } } : failed(error)

  // The latest deletion of each document: an older copy of the same item, or of another item on the same file, is spent.
  const latest: Array<RemovedListRow & RemovedRef> = []
  const seen = new Set<string>()
  for (const row of (data ?? []) as unknown as RemovedListRow[]) {
    if (!row.removed_item_id || !row.document_id || seen.has(row.document_id) || seen.has(row.removed_item_id)) continue
    seen.add(row.document_id).add(row.removed_item_id)
    latest.push({ ...row, inboxItemId: row.removed_item_id, documentId: row.document_id })
  }

  let state: RestoreState
  try {
    state = await readRestoreState(ctx.supabase, ctx.companyId, latest)
  } catch (err) {
    return failed(err)
  }
  const removed_items = latest
    .filter((row) => !state.refusals.has(row.inboxItemId))
    .slice(0, REMOVED_INBOX_ITEMS_LIMIT)
    .map((row): RemovedInboxItem => {
      const { vendor_name, amount, currency } = readingSummary({ supplier: row.supplier, invoice: row.invoice, totals: row.totals })
      return {
        inbox_item_id: row.inboxItemId,
        document_id: row.documentId,
        file_name: state.documents.get(row.documentId)?.file_name ?? null,
        vendor_name,
        amount,
        currency,
        email_from: row.email_from ?? null,
        email_subject: row.email_subject ?? null,
        removed_at: row.created_at,
        removed_by: { actor_type: row.actor_type, user_id: row.resolved_by ?? null },
      }
    })
  return { ok: true, data: { removed_items } }
}

/**
 * Put a deleted inbox item back as it was deleted, once. The id is the
 * item's own (the one its DELETE named). Answers INBOX_ITEM_RESTORE_NOT_FOUND
 * when the company has no kept copy under that id, and the refusals above
 * otherwise; two calls racing past the checks meet on the primary key and
 * the second answers INBOX_ITEM_RESTORE_IN_INBOX.
 */
export async function restoreInboxItem(
  ctx: OperationContext,
  inboxItemId: string,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<{ id: string; document_id: string; restored: true }>> {
  if (!UUID_RE.test(inboxItemId)) return NOT_FOUND
  const { data, error } = await ctx.supabase
    .from('suggestion_log')
    .select('created_at, document_id, removed_item')
    .eq('company_id', ctx.companyId)
    .not('removed_item', 'is', null)
    .eq('removed_item->>id', inboxItemId)
    .order('created_at', { ascending: false })
    .limit(1)
  if (error) return isMissingColumnError(error) ? NOT_FOUND : failed(error)
  const kept = ((data ?? []) as Array<{ created_at: string; document_id: string | null; removed_item: unknown }>)[0]
  const item = record(kept?.removed_item)
  const documentId = kept?.document_id
  if (!kept || !item || !documentId) return NOT_FOUND

  let state: RestoreState
  try {
    state = await readRestoreState(ctx.supabase, ctx.companyId, [{ inboxItemId, documentId }])
  } catch (err) {
    return failed(err)
  }
  const refusal = state.refusals.get(inboxItemId)
  if (refusal) return refusal
  const document = state.documents.get(documentId)
  try {
    if (await hasQueuedOrBookedTwin(ctx.supabase, ctx.companyId, { id: documentId, sha256_hash: document?.sha256_hash })) {
      return { ok: false, code: 'INBOX_ITEM_RESTORE_DUPLICATE' }
    }
  } catch (err) {
    return failed(err)
  }

  const reading = record(item.extracted_data)
  if (options.dryRun) {
    const summary = readingSummary(reading)
    return {
      ok: true,
      dryRun: true,
      preview: {
        inbox_item_id: inboxItemId,
        document_id: documentId,
        inbox_item_restored: true,
        file_name: document?.file_name ?? null,
        supplier_name: summary.vendor_name,
        amount: summary.amount,
        currency: summary.currency,
        email_from: text(item.email_from),
        email_subject: text(item.email_subject),
        removed_at: kept.created_at,
      },
    }
  }

  // A supplier deleted since would refuse the row (its live column would have been cleared).
  let matchedSupplierId = text(item.matched_supplier_id)
  if (matchedSupplierId) {
    const { data: supplier, error: supplierError } = await ctx.supabase
      .from('suppliers')
      .select('id')
      .eq('id', matchedSupplierId)
      .eq('company_id', ctx.companyId)
      .maybeSingle()
    if (supplierError) return failed(supplierError)
    if (!supplier) matchedSupplierId = null
  }

  const { error: insertError } = await ctx.supabase.from('invoice_inbox_items').insert({
    id: inboxItemId,
    company_id: ctx.companyId,
    user_id: text(item.user_id) ?? ctx.userId,
    document_id: documentId,
    // Nothing is reading it any more: an item deleted mid-reading comes back as received.
    status: item.status === 'error' ? 'error' : 'received',
    source: text(item.source) ?? 'upload',
    extracted_data: reading,
    extraction_skipped: item.extraction_skipped === true,
    matched_supplier_id: matchedSupplierId,
    kind_hint: text(item.kind_hint),
    channel_context: record(item.channel_context),
    email_from: text(item.email_from),
    email_subject: text(item.email_subject),
    email_received_at: text(item.email_received_at),
    email_body_text: text(item.email_body_text),
    resend_email_id: text(item.resend_email_id),
    resend_attachment_id: text(item.resend_attachment_id),
    raw_email_payload: record(item.raw_email_payload),
    correlation_id: text(item.correlation_id),
    error_message: text(item.error_message),
    // As it arrived: its place in the list, and the month usage counts it in.
    created_at: text(item.created_at) ?? undefined,
  })
  if (insertError) {
    // Its own id (put back a moment ago) or a key a new delivery of the same mail or e-invoice holds: it is in the inbox.
    if (insertError.code === '23505') return { ok: false, code: 'INBOX_ITEM_RESTORE_IN_INBOX' }
    return failed(insertError)
  }
  ctx.log.info('inbox item restored', { inbox_item_id: inboxItemId, document_id: documentId, removed_at: kept.created_at })
  // Open again: match on arrival looks in the bank for its payment.
  await proposeBankMatchForInboxItem(ctx.supabase, ctx.companyId, inboxItemId, ctx.log)
  return { ok: true, data: { id: inboxItemId, document_id: documentId, restored: true } }
}
