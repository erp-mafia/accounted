/**
 * Pin a document (underlag) to a bank transaction, and take it off again.
 * One implementation behind the dashboard route
 * (/api/transactions/[id]/attach-document, POST and DELETE), the v1
 * operations (lib/operations/documents.ts), whose attach is also the staged
 * MCP tool gnubok_attach_document_to_transaction, so every door applies the
 * same rules:
 *
 * Attach:
 *   - both rows must belong to the company (service-role doors skip RLS);
 *   - a pinned document that is already räkenskapsinformation (linked to a
 *     verifikat) is never replaced. When that verifikat is the row's own
 *     booking, another document is added to it as one more underlag and the
 *     pin stays (attachBesidePin); a pin on any other verifikat still needs
 *     a storno first;
 *   - a document that is the underlag of ANOTHER verifikat is refused; the
 *     same verifikat (directly or through a bulk-book voucher link) is an
 *     idempotent re-attach;
 *   - with checkFit, a document that plainly belongs to another purchase
 *     (lib/documents/bank-match/fit.ts: it asks for more than the row paid
 *     and names another seller, or its money goes the other way) is refused,
 *     DOC_ROW_MISMATCH, unless the caller states a mismatchReason (crm#1479,
 *     crm#1779);
 *   - a document sits on one bank row at a time, as in the app, where a
 *     matched document is released from its row before it is paired again:
 *     attaching one that another row holds (that row's pin, or the row its
 *     inbox item is matched to) moves it here, and the other row lets go of
 *     both, so its booking never anchors a document that was moved away
 *     (crm#1950). A row a verifikat books never loses its document this way:
 *     the attach is refused like a document on another verifikat. Nor does a
 *     document leave its row for a verifikat in a closed or locked period;
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
 * A dry run reads and checks; it writes nothing. Its preview also carries
 * both sides of the pairing (date, amount, counterparty; file, vendor,
 * amount), the rows the document would leave and any waiting proposal for
 * it, for whoever approves it.
 */
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import { appendProcessingHistory } from '@/lib/processing-history/append'
import { errorCauseTag } from '@/lib/errors/db-error'
import { isPeriodLockRefusal } from '@/lib/errors/get-structured-error'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { loadDocumentClaims, sharedDocumentWarning } from '@/lib/receipt-hunt/document-claims'
import {
  completeInboxItemsForBookedTransaction,
  lockedJournalEntryIds,
  resolveVoucherLinkedEntryIds,
} from '@/lib/transactions/inbox-underlag'
import { linkBasisColumns } from '@/lib/links/stamp'
import type { LinkEvidence } from '@/lib/links/link-basis'
import { documentFitGate, type DocumentFitDeps } from '@/lib/documents/bank-match/fit'

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
  /** The bank rows the document sat on and left: it sits on one at a time. */
  moved_from_transaction_ids: string[]
}

export interface DetachDocumentResult {
  transaction_id: string
  document_id: null
  detached_document_id: string | null
}

/**
 * Whether a pinned document stays underlag when another one takes the pin:
 * the inbox item it came from is matched to this transaction (an Inkorg drop,
 * a match, an earlier attach), so the booking links it as well. Only a
 * document with no such item leaves with the pin.
 */
async function previousDocumentStays(
  supabase: OperationContext['supabase'],
  companyId: string,
  transactionId: string,
  documentId: string,
): Promise<boolean | Error> {
  const { data, error } = await supabase
    .from('invoice_inbox_items')
    .select('id')
    .eq('company_id', companyId)
    .eq('document_id', documentId)
    .eq('matched_transaction_id', transactionId)
    .is('created_supplier_invoice_id', null)
    .limit(1)
  if (error) return new Error(error.message)
  return Array.isArray(data) && data.length > 0
}

/**
 * What the DOC_ATTACH_OTHER_VERIFIKAT refusal carries (crm#1813): the
 * verifikat that holds the document (journal_entry_id, as before), the one
 * the row is booked on, and, when the row is booked, the one call that puts
 * the same underlag on it: a link with copy: true, which archives a
 * byte-identical copy there and leaves the original where it is. An agent
 * without the row's verifikat id re-uploaded the file and then altered a byte
 * to get past the content dedupe. An unbooked row has no verifikat to link
 * yet, so it gets no call, only the ids.
 */
export function otherVerifikatDetails(
  documentId: string,
  heldByJournalEntryId: string,
  transactionJournalEntryId: string | null,
): Record<string, unknown> {
  return {
    journal_entry_id: heldByJournalEntryId,
    document_id: documentId,
    transaction_journal_entry_id: transactionJournalEntryId,
    ...(transactionJournalEntryId
      ? {
          next: {
            description:
              'If this row needs the same underlag too (one statement or invoice covering several payments), link a copy to the row\'s verifikat: approval archives a byte-identical copy there and the original stays where it is. Do not re-upload or alter the file. On the v1 API: POST /documents/{document_id}/link with the same journal_entry_id and copy: true.',
            tool: 'gnubok_link_document_to_voucher',
            args: { document_id: documentId, journal_entry_id: transactionJournalEntryId, copy: true },
          },
        }
      : {}),
  }
}

/** A bank row other than the target that holds the document. */
interface OtherHolder {
  transactionId: string
  /** The row's own pin (transactions.document_id); otherwise only an inbox item matched to it. */
  pinned: boolean
  /** The live verifikat that books the row, however it is anchored; null while unbooked. */
  journalEntryId: string | null
}

/**
 * The other bank rows that hold a document no verifikat holds yet: the rows
 * it is pinned on, and the rows its unbooked inbox item is matched to. Either
 * link carries the document onto the row's verifikat when the row is booked
 * (propagateUnderlagForBookedTransaction), so both count. Whether a row is
 * booked is public.bank_row_anchors' answer. A failed read is an error, never
 * "nobody": a row is released on what was read.
 */
async function otherRowsHolding(
  supabase: OperationContext['supabase'],
  companyId: string,
  transactionId: string,
  documentId: string,
): Promise<OtherHolder[] | Error> {
  const [pins, items] = await Promise.all([
    supabase
      .from('transactions')
      .select('id')
      .eq('company_id', companyId)
      .eq('document_id', documentId)
      .neq('id', transactionId),
    supabase
      .from('invoice_inbox_items')
      .select('matched_transaction_id')
      .eq('company_id', companyId)
      .eq('document_id', documentId)
      .not('matched_transaction_id', 'is', null)
      .neq('matched_transaction_id', transactionId)
      .is('created_journal_entry_id', null)
      .is('created_supplier_invoice_id', null),
  ])
  if (pins.error) return new Error(pins.error.message)
  if (items.error) return new Error(items.error.message)
  const pinned = new Set(((pins.data ?? []) as Array<{ id: string }>).map((row) => row.id))
  const matched = ((items.data ?? []) as Array<{ matched_transaction_id: string }>).map((item) => item.matched_transaction_id)
  const ids = [...new Set([...pinned, ...matched])]
  if (ids.length === 0) return []

  const { data: anchors, error: anchorError } = await supabase
    .from('bank_row_anchors')
    .select('transaction_id, journal_entry_id')
    .eq('company_id', companyId)
    .in('transaction_id', ids)
  if (anchorError) return new Error(anchorError.message)
  const bookedOn = new Map(
    ((anchors ?? []) as Array<{ transaction_id: string; journal_entry_id: string }>).map((a) => [a.transaction_id, a.journal_entry_id]),
  )
  return ids.map((id) => ({ transactionId: id, pinned: pinned.has(id), journalEntryId: bookedOn.get(id) ?? null }))
}

/**
 * Take the document off the unbooked rows that hold it, before it is pinned
 * elsewhere: their pins are cleared and the inbox item matched to them is
 * released, as the Inkorg's "koppla bort" does for one item. Nothing here is
 * best-effort: a link left behind is what lets the old row's booking anchor
 * the document on the wrong verifikat (crm#1950). The pins go first: the
 * transactions trigger refuses when a booking made the document a verifikat's
 * underlag since the read, and then nothing has changed and the caller asks
 * again, which answers with that verifikat. Returns the refusal, or null when
 * the rows have let go.
 */
async function releaseFromOtherRows(
  ctx: OperationContext,
  documentId: string,
  holders: OtherHolder[],
): Promise<Failure | null> {
  const { supabase, companyId, log } = ctx
  const pinnedOn = holders.filter((holder) => holder.pinned).map((holder) => holder.transactionId)
  if (pinnedOn.length > 0) {
    const { error: unpinError } = await supabase
      .from('transactions')
      .update({ document_id: null })
      .eq('company_id', companyId)
      .eq('document_id', documentId)
      .in('id', pinnedOn)
    if (unpinError) {
      if (isImmutabilityError(unpinError)) return { ok: false, code: 'DOC_DETACH_CONCURRENT' }
      log.error('attach document: clearing the pin on the row the document leaves failed', { cause: errorCauseTag(unpinError) })
      return failed(unpinError)
    }
  }

  const { error: releaseError } = await supabase
    .from('invoice_inbox_items')
    .update({ matched_transaction_id: null })
    .eq('company_id', companyId)
    .eq('document_id', documentId)
    .in('matched_transaction_id', holders.map((holder) => holder.transactionId))
    .is('created_journal_entry_id', null)
    .is('created_supplier_invoice_id', null)
  if (releaseError) {
    log.error('attach document: releasing the inbox item from the row the document leaves failed', { cause: errorCauseTag(releaseError) })
    return { ok: false, code: 'DOC_DETACH_INBOX_UNLINK_FAILED' }
  }
  return null
}

/**
 * Pin document_id to the transaction. Idempotent: attaching the document
 * already pinned is a no-op success; attaching another replaces the pin
 * (logged as a rättelse) unless the current one is räkenskapsinformation.
 * A document another unbooked row holds moves here.
 */
export async function attachDocumentToTransaction(
  ctx: OperationContext,
  transactionId: string,
  documentId: string,
  options: {
    dryRun?: boolean
    /** Refuse a document that plainly belongs to another purchase (DOC_ROW_MISMATCH). */
    checkFit?: boolean
    /** Why the document belongs here anyway; lets a mismatch through. */
    mismatchReason?: string | null
    fitDeps?: DocumentFitDeps
  } = {},
): Promise<OperationOutcome<AttachDocumentResult>> {
  const { supabase, companyId, userId, log } = ctx

  // A failed read answers 404 like a missing row (a malformed id is a cast
  // error in Postgres): the same answer the dashboard route always gave.
  const { data: tx, error: txError } = await supabase
    .from('transactions')
    .select('id, document_id, journal_entry_id, description, original_description, merchant_name, amount, currency, amount_sek, exchange_rate, instructed_amount, instructed_currency, date')
    .eq('id', transactionId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (txError || !tx) return TX_NOT_FOUND

  const previousDocumentId = (tx.document_id as string | null) ?? null
  let previousFileName: string | null = null
  // The verifikat the row is booked on, when its pinned document is already
  // that verifikat's underlag: the new document joins it beside the pin.
  let besidePinOn: string | null = null

  // The pinned document is räkenskapsinformation and is never replaced (the
  // transactions trigger refuses moving it). On the row's own verifikat the
  // new document is one more underlag: the posted entry does not change and
  // nothing is removed, so no storno is needed (BFL 5 kap 6-7 §§). Staged
  // attaches met a refusal here when the row was booked with another
  // document between staging and approval. Only a pin held by another
  // verifikat than the row's booking keeps the refusal.
  if (previousDocumentId && previousDocumentId !== documentId) {
    const { data: existing, error: existingError } = await supabase
      .from('document_attachments')
      .select('journal_entry_id, file_name')
      .eq('id', previousDocumentId)
      .eq('company_id', companyId)
      .maybeSingle()
    if (existingError) return failed(existingError)
    const pinEntryId = (existing?.journal_entry_id as string | null) ?? null
    if (pinEntryId) {
      const rowEntryId =
        (tx.journal_entry_id as string | null) ??
        (await resolveVoucherLinkedEntryIds(supabase, companyId, [transactionId])).get(transactionId) ??
        null
      if (pinEntryId !== rowEntryId) {
        return { ok: false, code: 'DOC_ATTACH_REPLACES_POSTED', details: { previous_document_id: previousDocumentId } }
      }
      besidePinOn = pinEntryId
    }
    previousFileName = (existing?.file_name as string | null) ?? null
  }

  const { data: document, error: docError } = await supabase
    .from('document_attachments')
    .select('id, file_name, mime_type, journal_entry_id')
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
      return {
        ok: false,
        code: 'DOC_ATTACH_OTHER_VERIFIKAT',
        details: otherVerifikatDetails(
          documentId,
          docJournalEntryId,
          (tx.journal_entry_id as string | null) ?? voucherLinked.get(transactionId) ?? null,
        ),
      }
    }
  }

  // The two sides are compared before anything is written (crm#1479): once
  // the row is booked the document is underlag for good. Re-attaching the
  // document already pinned changes nothing and is not judged again.
  if (options.checkFit && previousDocumentId !== documentId) {
    const refusal = await documentFitGate(supabase, companyId, options.mismatchReason, options.fitDeps)(documentId, tx)
    if (refusal) return { ok: false, ...refusal }
  }

  // The document sits on one bank row at a time (crm#1950): the rows that
  // hold it now let go when it is pinned here. A document already on this
  // row's verifikat moves nowhere (the transactions trigger keeps every pin
  // on it). A row a verifikat books is never emptied this way: its document
  // is that verifikat's underlag even when the link itself never landed (a
  // locked period), so the answer is the one for a document on another
  // verifikat, with the row named.
  const holders: OtherHolder[] | Error = docJournalEntryId
    ? []
    : await otherRowsHolding(supabase, companyId, transactionId, documentId)
  if (holders instanceof Error) return failed(holders)
  const bookedHolder = holders.find((holder) => holder.journalEntryId != null)
  if (bookedHolder?.journalEntryId) {
    const rowEntryId =
      (tx.journal_entry_id as string | null) ??
      (await resolveVoucherLinkedEntryIds(supabase, companyId, [transactionId])).get(transactionId) ??
      null
    return {
      ok: false,
      code: 'DOC_ATTACH_OTHER_VERIFIKAT',
      details: {
        ...otherVerifikatDetails(documentId, bookedHolder.journalEntryId, rowEntryId),
        held_by_transaction_id: bookedHolder.transactionId,
      },
    }
  }
  const movedFrom = holders.map((holder) => holder.transactionId)
  // The verifikat the document joins on a booked row: the pin's, beside it,
  // or the row's own booking. Null while the row is unbooked.
  const joinsEntryId = besidePinOn ?? (tx.journal_entry_id as string | null) ?? null

  if (options.dryRun) {
    // A verifikat in a closed or locked period takes no new underlag, so the
    // write can only refuse: the dry run (a staged attach, a v1 dry_run) asks
    // the period first and refuses the same way, nothing written.
    if (
      joinsEntryId &&
      docJournalEntryId !== joinsEntryId &&
      (await lockedJournalEntryIds(supabase, companyId, [joinsEntryId])).has(joinsEntryId)
    ) {
      return lockedYearRefusal(joinsEntryId)
    }
    // What the document says (the hints the pairing was chosen on), and who
    // else already holds it: one document backs one purchase.
    const replacesPin = previousDocumentId != null && previousDocumentId !== documentId && besidePinOn == null
    const [{ data: inbox }, claims, previousStays] = await Promise.all([
      supabase
        .from('invoice_inbox_items')
        .select('extracted_data')
        .eq('document_id', documentId)
        .eq('company_id', companyId)
        .limit(1)
        .maybeSingle(),
      loadDocumentClaims(supabase, companyId, [documentId]).catch((error: unknown) => error as Error),
      replacesPin ? previousDocumentStays(supabase, companyId, transactionId, previousDocumentId) : Promise.resolve(false),
    ])
    if (claims instanceof Error) return failed(claims)
    if (previousStays instanceof Error) return failed(previousStays)
    const extracted = (inbox?.extracted_data ?? {}) as {
      supplier?: { name?: string }
      invoice?: { currency?: string; invoiceDate?: string }
      totals?: { total?: number }
    }
    return {
      ok: true,
      dryRun: true,
      preview: {
        transaction_id: transactionId,
        transaction_description: (tx.merchant_name as string | null) || (tx.description as string | null) || null,
        transaction_amount: (tx.amount as number | null) ?? null,
        transaction_currency: (tx.currency as string | null) ?? null,
        transaction_date: (tx.date as string | null) ?? null,
        document_id: documentId,
        document_file_name: (document.file_name as string | null) ?? null,
        document_mime_type: (document.mime_type as string | null) ?? null,
        document_vendor_name: extracted.supplier?.name || null,
        document_amount: extracted.totals?.total || null,
        document_currency: extracted.invoice?.currency || null,
        document_invoice_date: extracted.invoice?.invoiceDate || null,
        previous_document_id: previousDocumentId,
        previous_document_file_name: previousFileName,
        replaces_document: replacesPin,
        // The replaced pin still reaches the booking through its inbox item,
        // matched to this transaction: both documents become underlag, the
        // new one is added (lib/transactions/inbox-underlag.ts).
        previous_document_stays: replacesPin && previousStays === true,
        // The row is booked and its pin is the verifikat's underlag: the pin
        // stays and this document is added to that verifikat beside it.
        adds_to_verifikat: besidePinOn != null,
        transaction_booked: tx.journal_entry_id != null,
        journal_entry_id: (tx.journal_entry_id as string | null) ?? null,
        // The unbooked rows the document leaves when this is approved.
        moves_from_transaction_ids: movedFrom,
        // Those rows, and the proposals still waiting for the same document.
        shared_document_warning: sharedDocumentWarning(
          [
            ...(claims.get(documentId) ?? []).filter((claim) => claim.operation_id !== null),
            ...movedFrom.map((id) => ({ document_id: documentId, operation_id: null, transaction_id: id, journal_entry_id: null })),
          ],
          { transaction_id: transactionId },
        ),
        // The caller's reason for a document that may look like another purchase's.
        ...(options.checkFit && options.mismatchReason ? { mismatch_reason: options.mismatchReason } : {}),
      },
    }
  }

  // The rows the document leaves let go before it is pinned or linked here:
  // once it is a verifikat's underlag no pin on it can be cleared.
  if (holders.length > 0) {
    // A verifikat in a closed or locked period takes no new underlag, so the
    // period is asked before the document leaves its row: moved first, it
    // would sit on a row whose verifikat can never reference it.
    if (joinsEntryId && (await lockedJournalEntryIds(supabase, companyId, [joinsEntryId])).has(joinsEntryId)) {
      return lockedYearRefusal(joinsEntryId)
    }
    const refusal = await releaseFromOtherRows(ctx, documentId, holders)
    if (refusal) return refusal
    log.info('attach document: the document left the rows that held it', {
      document_id: documentId,
      transaction_id: transactionId,
      moved_from_transaction_ids: movedFrom,
    })
  }

  if (besidePinOn) return attachBesidePin(ctx, transactionId, documentId, docJournalEntryId, besidePinOn, movedFrom)

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
    // The caller pinned this document to the bank row its verifikat books.
    const linkErr = await linkToBookedEntry(supabase, companyId, documentId, journalEntryId, { rule_id: 'bank_row_document_pin' })
    if (linkErr) {
      if (isPeriodLockRefusal(linkErr)) {
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
      moved_from_transaction_ids: movedFrom,
    },
  }
}

/**
 * Point the document at the verifikat that books its bank row. The request
 * scope (linkBasisColumns) says who confirmed it; the audit trigger on
 * document_attachments keeps when. Returns the write error, or null.
 */
async function linkToBookedEntry(
  supabase: OperationContext['supabase'],
  companyId: string,
  documentId: string,
  journalEntryId: string,
  evidence: LinkEvidence,
): Promise<unknown> {
  const { error } = await supabase
    .from('document_attachments')
    .update({ journal_entry_id: journalEntryId, ...linkBasisColumns('user_confirmed', evidence) })
    .eq('id', documentId)
    .eq('company_id', companyId)
  return error ?? null
}

/**
 * A verifikat in a locked or closed year takes no document; nothing was
 * written. The code is the PERIOD_LOCKED this operation publishes; the
 * sentences are the ones every document door gives (DOC_UPLOAD_PERIOD_LOCKED),
 * not PERIOD_LOCKED's advice to move an entry date, and the next step is this
 * operation's own for a locked year (DOC_ATTACH_PERIOD_LOCKED): the document
 * is already stored, so no new upload.
 */
function lockedYearRefusal(journalEntryId: string): Extract<OperationOutcome<AttachDocumentResult>, { ok: false }> {
  const answer = getErrorEntry('DOC_UPLOAD_PERIOD_LOCKED')!
  return {
    ok: false,
    code: 'PERIOD_LOCKED',
    details: { journal_entry_id: journalEntryId },
    messageSv: answer.message_sv,
    messageEn: answer.message_en,
    remediation: getErrorEntry('DOC_ATTACH_PERIOD_LOCKED')!.remediation,
  }
}

/**
 * Add a document to the verifikat of a booked row whose pinned document is
 * already that verifikat's underlag: a second receipt, the invoice beside a
 * payment confirmation. The pin stays and the posted entry is untouched; the
 * verifikat gains one more underlag (BFL 5 kap 6-7 §§), linked with who
 * confirmed it. The link is written first, so a closed or locked period
 * refuses with nothing written. The inbox item the document came from then
 * reads matched and handled, as after a pin.
 */
async function attachBesidePin(
  ctx: OperationContext,
  transactionId: string,
  documentId: string,
  docJournalEntryId: string | null,
  journalEntryId: string,
  movedFrom: string[],
): Promise<OperationOutcome<AttachDocumentResult>> {
  const { supabase, companyId, log } = ctx
  if (docJournalEntryId !== journalEntryId) {
    const linkErr = await linkToBookedEntry(supabase, companyId, documentId, journalEntryId, { rule_id: 'bank_row_extra_underlag' })
    if (linkErr) {
      if (isPeriodLockRefusal(linkErr)) return lockedYearRefusal(journalEntryId)
      log.error('attach document: adding underlag to the verifikat failed', { cause: errorCauseTag(linkErr) })
      return failed(linkErr)
    }
  }

  // Best-effort, as for a pin: the link above is the legally relevant write.
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
  await completeInboxItemsForBookedTransaction(supabase, companyId, transactionId, {
    directJournalEntryId: journalEntryId,
  })

  return {
    ok: true,
    data: {
      transaction_id: transactionId,
      document_id: documentId,
      // Nothing was replaced: the pin stays beside the added document.
      previous_document_id: null,
      journal_entry_id: journalEntryId,
      moved_from_transaction_ids: movedFrom,
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
