/**
 * Pin a document (underlag) to a bank transaction, and take it off again.
 * One implementation behind the dashboard route
 * (/api/transactions/[id]/attach-document, POST and DELETE), the v1
 * operations (lib/operations/documents.ts) and the MCP approval of
 * attach_document_to_transaction (lib/pending-operations/commit.ts), so every
 * door applies the same rules:
 *
 * Attach:
 *   - both rows must belong to the company (service-role doors skip RLS);
 *   - a pinned document that is already räkenskapsinformation (linked to a
 *     verifikat) is never replaced: storno the entry first;
 *   - a document that is the underlag of ANOTHER verifikat is refused; the
 *     same verifikat (directly or through a bulk-book voucher link) is an
 *     idempotent re-attach;
 *   - on a booked transaction the link propagates to
 *     document_attachments.journal_entry_id at once (BFL 5 kap 6 §: the
 *     verifikat must reference its underlag), and a failed propagation is an
 *     error, never a silent success;
 *   - the inbox item the document came from is marked matched, and completed
 *     against the anchoring verifikat when the transaction is already booked;
 *   - replacing a document is logged as a rättelse (BFL 5 kap 5 §).
 *
 * Detach:
 *   - refused once the pinned document is linked to a verifikat (BFL 5 kap 6 §);
 *   - the inbox back-link is released FIRST, then the pin is cleared with a
 *     compare-and-set, so a concurrent attach wins and a stale back-link can
 *     never re-anchor the detached document on the next booking.
 *
 * A dry run reads and checks; it writes nothing.
 */
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import { appendProcessingHistory } from '@/lib/processing-history/append'
import { errorCauseTag } from '@/lib/errors/db-error'
import {
  completeInboxItemsForBookedTransaction,
  resolveVoucherLinkedEntryIds,
} from '@/lib/transactions/inbox-underlag'

type Failure = Extract<OperationOutcome<never>, { ok: false }>

const TX_NOT_FOUND: Failure = { ok: false, code: 'TX_CATEGORIZE_TX_NOT_FOUND' }
const DOC_NOT_FOUND: Failure = { ok: false, code: 'DOC_NOT_FOUND' }

function failed(error: unknown): Failure {
  return { ok: false, code: 'UNKNOWN_ERROR', error }
}

function isImmutabilityError(error: unknown): boolean {
  return ((error as { message?: string } | null)?.message ?? '').includes('BFL_DOCUMENT_IMMUTABILITY')
}

export interface AttachDocumentResult {
  transaction_id: string
  document_id: string
  previous_document_id: string | null
  journal_entry_id: string | null
}

export interface DetachDocumentResult {
  transaction_id: string
  document_id: null
  detached_document_id: string | null
}

/**
 * Pin document_id to the transaction. Idempotent: attaching the document
 * already pinned is a no-op success; attaching another replaces the pin
 * (logged as a rättelse) unless the current one is räkenskapsinformation.
 */
export async function attachDocumentToTransaction(
  ctx: OperationContext,
  transactionId: string,
  documentId: string,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<AttachDocumentResult>> {
  const { supabase, companyId, userId, log } = ctx

  // A failed read answers 404 like a missing row (a malformed id is a cast
  // error in Postgres): the same answer the dashboard route always gave.
  const { data: tx, error: txError } = await supabase
    .from('transactions')
    .select('id, document_id, journal_entry_id')
    .eq('id', transactionId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (txError || !tx) return TX_NOT_FOUND

  const previousDocumentId = (tx.document_id as string | null) ?? null

  // The pinned document is räkenskapsinformation: say so before the DB
  // trigger raises a raw check violation. Same refusal the trigger enforces.
  if (previousDocumentId && previousDocumentId !== documentId) {
    const { data: existing, error: existingError } = await supabase
      .from('document_attachments')
      .select('journal_entry_id')
      .eq('id', previousDocumentId)
      .eq('company_id', companyId)
      .maybeSingle()
    if (existingError) return failed(existingError)
    if (existing?.journal_entry_id) {
      return { ok: false, code: 'DOC_ATTACH_REPLACES_POSTED', details: { previous_document_id: previousDocumentId } }
    }
  }

  const { data: document, error: docError } = await supabase
    .from('document_attachments')
    .select('id, file_name, journal_entry_id')
    .eq('id', documentId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (docError || !document) return DOC_NOT_FOUND

  // A document that already serves as underlag for a DIFFERENT verifikat
  // cannot be pinned here: propagating would either corrupt that link or be
  // blocked by the document-metadata immutability trigger. The same verifikat
  // (a bulk-booked transaction is anchored through transaction_voucher_links)
  // is an idempotent re-attach.
  const docJournalEntryId = (document.journal_entry_id as string | null) ?? null
  if (docJournalEntryId && docJournalEntryId !== tx.journal_entry_id) {
    const voucherLinked = await resolveVoucherLinkedEntryIds(supabase, companyId, [transactionId])
    if (docJournalEntryId !== voucherLinked.get(transactionId)) {
      return { ok: false, code: 'DOC_ATTACH_OTHER_VERIFIKAT', details: { journal_entry_id: docJournalEntryId } }
    }
  }

  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      preview: {
        transaction_id: transactionId,
        document_id: documentId,
        document_file_name: (document.file_name as string | null) ?? null,
        previous_document_id: previousDocumentId,
        replaces_document: previousDocumentId != null && previousDocumentId !== documentId,
        transaction_booked: tx.journal_entry_id != null,
        journal_entry_id: (tx.journal_entry_id as string | null) ?? null,
      },
    }
  }

  // Race-free read of journal_entry_id: UPDATE ... RETURNING, so the value we
  // propagate against reflects any concurrent categorize that committed
  // before our UPDATE took the row lock. Attach-then-categorize and
  // categorize-then-attach end in the same state.
  const { data: postUpdate, error: updateError } = await supabase
    .from('transactions')
    .update({ document_id: documentId })
    .eq('id', transactionId)
    .eq('company_id', companyId)
    .select('journal_entry_id')
    .maybeSingle()
  if (updateError) {
    if (isImmutabilityError(updateError)) {
      return { ok: false, code: 'DOC_ATTACH_REPLACES_POSTED', details: { previous_document_id: previousDocumentId } }
    }
    log.error('attach document: transaction update failed', { cause: errorCauseTag(updateError) })
    return failed(updateError)
  }
  if (!postUpdate) return TX_NOT_FOUND

  // The inbox item this document came from reads "Kopplad" from now on.
  // Best-effort: the (compliant) attach must not roll back over it.
  const { error: inboxLinkErr } = await supabase
    .from('invoice_inbox_items')
    .update({ matched_transaction_id: transactionId })
    .eq('document_id', documentId)
    .eq('company_id', companyId)
    .is('matched_transaction_id', null)
    .is('created_supplier_invoice_id', null)
  if (inboxLinkErr) {
    log.error('attach document: inbox back-link failed', { cause: errorCauseTag(inboxLinkErr) })
  }

  // Booked transaction: the verifikat references its underlag at once. The
  // period-lock trigger raises on ANY journal_entry_id write, even a
  // same-value rewrite, so an idempotent re-attach skips it.
  const journalEntryId = (postUpdate.journal_entry_id as string | null) ?? null
  if (journalEntryId && docJournalEntryId !== journalEntryId) {
    const { error: linkErr } = await supabase
      .from('document_attachments')
      .update({ journal_entry_id: journalEntryId })
      .eq('id', documentId)
      .eq('company_id', companyId)
    if (linkErr) {
      const linkMsg = (linkErr as { message?: string }).message ?? ''
      if (/locked\/closed fiscal period|Bokföringen är låst/i.test(linkMsg)) {
        // Honest about the partial write: the pin (and the inbox back-link)
        // persisted; only the verifikat link was blocked.
        return { ok: false, code: 'DOC_ATTACH_PERIOD_LOCKED', details: { journal_entry_id: journalEntryId } }
      }
      log.error('attach document: propagation to the verifikat failed', { cause: errorCauseTag(linkErr) })
      return { ok: false, code: 'DOC_ATTACH_PROPAGATION_FAILED', details: { journal_entry_id: journalEntryId } }
    }
  }

  // Complete matched inbox items against the anchoring verifikat (direct or
  // through a samlingsverifikat's voucher link), so an after-the-fact attach
  // resolves them. Best-effort, logged inside.
  const effectiveJournalEntryId = await completeInboxItemsForBookedTransaction(
    supabase,
    companyId,
    transactionId,
    { directJournalEntryId: journalEntryId },
  )

  // Rättelse trail (BFL 5 kap 5 §): a replaced document stays traceable.
  if (previousDocumentId && previousDocumentId !== documentId) {
    try {
      await appendProcessingHistory({
        companyId,
        correlationId: transactionId,
        aggregateType: 'BankTransaction',
        aggregateId: transactionId,
        eventType: 'TransactionDocumentReplaced',
        payload: {
          transaction_id: transactionId,
          previous_document_id: previousDocumentId,
          new_document_id: documentId,
          journal_entry_id: effectiveJournalEntryId,
        },
        actor: { type: 'user', id: userId },
        occurredAt: new Date(),
      })
    } catch (logErr) {
      log.error('attach document: rättelse event failed', logErr as Error)
    }
  }

  return {
    ok: true,
    data: {
      transaction_id: transactionId,
      document_id: documentId,
      previous_document_id: previousDocumentId,
      journal_entry_id: effectiveJournalEntryId,
    },
  }
}

/**
 * Take the document off a transaction that is not booked against it. A
 * transaction with no document answers success (nothing to detach).
 */
export async function detachDocumentFromTransaction(
  ctx: OperationContext,
  transactionId: string,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<DetachDocumentResult>> {
  const { supabase, companyId, log } = ctx

  const { data: tx, error: fetchError } = await supabase
    .from('transactions')
    .select('id, document_id')
    .eq('id', transactionId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (fetchError || !tx) return TX_NOT_FOUND

  const pinnedDocumentId = (tx.document_id as string | null) ?? null
  if (pinnedDocumentId) {
    const { data: doc, error: docError } = await supabase
      .from('document_attachments')
      .select('journal_entry_id')
      .eq('id', pinnedDocumentId)
      .eq('company_id', companyId)
      .maybeSingle()
    if (docError) return failed(docError)
    if (doc?.journal_entry_id) {
      return { ok: false, code: 'DOC_DETACH_POSTED', details: { document_id: pinnedDocumentId } }
    }
  }

  if (options.dryRun) {
    const { data: inboxItems, error: inboxError } = await supabase
      .from('invoice_inbox_items')
      .select('id')
      .eq('company_id', companyId)
      .eq('matched_transaction_id', transactionId)
      .is('created_journal_entry_id', null)
    if (inboxError) return failed(inboxError)
    return {
      ok: true,
      dryRun: true,
      preview: {
        transaction_id: transactionId,
        document_id: pinnedDocumentId,
        would_detach: pinnedDocumentId != null,
        released_inbox_item_ids: ((inboxItems ?? []) as Array<{ id: string }>).map((i) => i.id),
      },
    }
  }

  // Step 1: release the inbox back-link BEFORE the pin. Otherwise the item
  // still says matched_transaction_id = this transaction, and the next
  // categorize/book anchors the DETACHED document onto the new verifikat as
  // immutable underlag (BFL 5 kap 7 §). Items already consumed by a verifikat
  // stay. Not best-effort: a stale back-link is the defect this prevents.
  const { error: inboxUnlinkErr } = await supabase
    .from('invoice_inbox_items')
    .update({ matched_transaction_id: null })
    .eq('company_id', companyId)
    .eq('matched_transaction_id', transactionId)
    .is('created_journal_entry_id', null)
  if (inboxUnlinkErr) {
    // Coded cause only: raw driver messages can quote row values.
    log.error('detach document: inbox unlink failed', { cause: errorCauseTag(inboxUnlinkErr) })
    return { ok: false, code: 'DOC_DETACH_INBOX_UNLINK_FAILED' }
  }

  // Step 2: clear the pin only if it is still the document read above (or
  // still empty). A concurrent attach wins; this detach then did not happen.
  let clearPin = supabase
    .from('transactions')
    .update({ document_id: null })
    .eq('id', transactionId)
    .eq('company_id', companyId)
  clearPin = pinnedDocumentId ? clearPin.eq('document_id', pinnedDocumentId) : clearPin.is('document_id', null)
  const { data: cleared, error: updateError } = await clearPin.select('id').maybeSingle()
  if (updateError) {
    // The enforce_transactions_document_immutability trigger's stable prefix.
    if (isImmutabilityError(updateError)) {
      return { ok: false, code: 'DOC_DETACH_POSTED', details: { document_id: pinnedDocumentId } }
    }
    log.error('detach document: transaction update failed', { cause: errorCauseTag(updateError) })
    return failed(updateError)
  }
  if (!cleared) return { ok: false, code: 'DOC_DETACH_CONCURRENT' }

  return {
    ok: true,
    data: { transaction_id: transactionId, document_id: null, detached_document_id: pinnedDocumentId },
  }
}
