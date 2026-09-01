import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { AttachDocumentSchema } from '@/lib/api/schemas'
import { appendProcessingHistory } from '@/lib/processing-history/append'
import {
  completeInboxItemsForBookedTransaction,
  resolveVoucherLinkedEntryIds,
} from '@/lib/transactions/inbox-underlag'

ensureInitialized()

/**
 * POST /api/transactions/[id]/attach-document
 *
 * Pin an unmatched document_attachments row to a bank transaction. Lets users
 * (or AI agents via MCP) bind a forwarded/uploaded invoice or receipt before
 * the transaction is categorized. When the transaction is later categorized,
 * the categorize route propagates the link to document_attachments.journal_entry_id.
 * If the transaction is ALREADY booked, the propagation happens here instead
 * (mirroring commitAttachDocumentToTransaction in lib/pending-operations/commit.ts).
 *
 * Idempotent: overwrites any existing link.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'transaction.attach_document',
  async (request, { supabase, user, companyId }, { params }) => {
    const { id: transactionId } = await params

    const validation = await validateBody(request, AttachDocumentSchema)
    if (!validation.success) return validation.response
    const { document_id } = validation.data

    const { data: transaction, error: txError } = await supabase
      .from('transactions')
      .select('id, document_id, journal_entry_id')
      .eq('id', transactionId)
      .eq('company_id', companyId)
      .maybeSingle()

    if (txError || !transaction) {
      return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })
    }

    const previousDocumentId = (transaction.document_id as string | null) ?? null

    const { data: document, error: docError } = await supabase
      .from('document_attachments')
      .select('id, journal_entry_id')
      .eq('id', document_id)
      .eq('company_id', companyId)
      .maybeSingle()

    if (docError || !document) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 })
    }

    // A document that already serves as underlag for a DIFFERENT verifikation
    // cannot be pinned here: propagating would either corrupt that link or be
    // blocked by the document-metadata immutability trigger. Same verifikation
    // is fine (idempotent re-attach; propagation below becomes a no-op). A
    // bulk-booked tx keeps journal_entry_id null and is anchored through
    // transaction_voucher_links, so that anchoring counts as "same" too.
    const docJournalEntryId = (document.journal_entry_id as string | null) ?? null
    if (docJournalEntryId && docJournalEntryId !== transaction.journal_entry_id) {
      const voucherLinked = await resolveVoucherLinkedEntryIds(supabase, companyId, [
        transactionId,
      ])
      if (docJournalEntryId !== voucherLinked.get(transactionId)) {
        return NextResponse.json(
          { error: 'Underlaget är redan kopplat till en annan verifikation.' },
          { status: 409 },
        )
      }
    }

    // Race-free read of journal_entry_id: UPDATE ... RETURNING so the value we
    // propagate against reflects any concurrent categorize that committed before
    // our UPDATE acquired the row lock. Mirrors commitAttachDocumentToTransaction
    // in lib/pending-operations/commit.ts so REST and MCP attaches converge.
    const { data: postUpdate, error: updateError } = await supabase
      .from('transactions')
      .update({ document_id })
      .eq('id', transactionId)
      .eq('company_id', companyId)
      .select('journal_entry_id')
      .maybeSingle()

    if (updateError) {
      const errMsg = (updateError as { message?: string }).message ?? ''
      if (errMsg.includes('BFL_DOCUMENT_IMMUTABILITY')) {
        return NextResponse.json(
          {
            error:
              'Bilagan är kopplad till en bokförd verifikation och kan inte ersättas. Storno verifikationen först.',
          },
          { status: 409 },
        )
      }
      console.error('[attach-document] Failed to attach:', updateError)
      return NextResponse.json({ error: 'Failed to attach document' }, { status: 500 })
    }
    if (!postUpdate) {
      return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })
    }

    // If this document came from an invoice_inbox_items row, mark that row
    // as matched so the inbox UI can show it as "Kopplad" + link back to the
    // transaction. Best-effort: a failure here must not roll back the
    // (compliant) document attach.
    //
    // The Supabase client resolves with { error } rather than rejecting on
    // RLS/DB errors, so we destructure rather than try/catch.
    const { error: inboxLinkErr } = await supabase
      .from('invoice_inbox_items')
      .update({ matched_transaction_id: transactionId })
      .eq('document_id', document_id)
      .eq('company_id', companyId)
      .is('matched_transaction_id', null)
      .is('created_supplier_invoice_id', null)
    if (inboxLinkErr) {
      console.error('[attach-document] Failed to link inbox item:', inboxLinkErr)
    }

    // If the transaction is already booked, propagate the link onto the
    // verifikation immediately (BFL 5 kap 6 §: the verifikation must reference
    // its underlag). Skipped when the doc already points at this verifikation
    // (idempotent re-attach). Mirrors commitAttachDocumentToTransaction.
    const journalEntryId = (postUpdate.journal_entry_id as string | null) ?? null
    if (journalEntryId && docJournalEntryId !== journalEntryId) {
      const { error: linkErr } = await supabase
        .from('document_attachments')
        .update({ journal_entry_id: journalEntryId })
        .eq('id', document_id)
        .eq('company_id', companyId)
      if (linkErr) {
        // The enforce_period_lock trigger blocks journal_entry_id writes when
        // the target entry sits in a closed/locked period.
        const linkMsg = (linkErr as { message?: string }).message ?? ''
        if (/locked\/closed fiscal period|Bokföringen är låst/i.test(linkMsg)) {
          // Honest about the partial write: the pin on the transaction (and the
          // inbox back-link) persisted; only the verifikat link was blocked.
          return NextResponse.json(
            {
              error:
                'Bilagan kopplades till transaktionen men verifikationens period är låst: den kunde inte länkas till verifikationen.',
            },
            { status: 409 },
          )
        }
        // Surface the propagation failure rather than logging-and-continuing:
        // a "succeeded" attach that left document_attachments.journal_entry_id
        // null would be a silent compliance gap. A retry is idempotent.
        console.error('[attach-document] Failed to propagate to journal entry:', linkErr)
        return NextResponse.json(
          {
            error:
              'Bilagan kopplades till transaktionen men kunde inte länkas till verifikationen. Försök igen: operationen är idempotent.',
          },
          { status: 500 },
        )
      }
    }

    // The transaction may already be booked, directly or via a bulk-book
    // samlingsverifikat (journal_entry_id null, anchored through
    // transaction_voucher_links): complete the matched inbox items against
    // the anchoring verifikat so an after-the-fact attach resolves them
    // instead of stranding them as "linked" forever. Best-effort, logged
    // inside. Returns the anchoring verifikat (the direct id when there is
    // one), so the response and audit trail can report the voucher-linked
    // case too.
    const effectiveJournalEntryId = await completeInboxItemsForBookedTransaction(
      supabase,
      companyId,
      transactionId,
      { directJournalEntryId: journalEntryId },
    )

    // Rättelse audit trail (BFL 5 kap 5 §): record swaps where a non-null doc
    // was replaced. Best-effort: a logging failure must not roll back the
    // (compliant) attach.
    if (previousDocumentId && previousDocumentId !== document_id) {
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
            new_document_id: document_id,
            journal_entry_id: effectiveJournalEntryId,
          },
          actor: { type: 'user', id: user.id },
          occurredAt: new Date(),
        })
      } catch (logErr) {
        console.error('[attach-document] Failed to append rättelse event:', logErr)
      }
    }

    return NextResponse.json({
      data: {
        transaction_id: transactionId,
        document_id,
        previous_document_id: previousDocumentId,
        journal_entry_id: effectiveJournalEntryId,
      },
    })
  },
  { requireWrite: true },
)

/**
 * DELETE /api/transactions/[id]/attach-document
 *
 * Detach a document from a transaction.
 *
 * Also undoes the invoice_inbox_items back-link written by POST, so the next
 * booking does not re-anchor the detached doc (see propagateUnderlag...).
 *
 * Blocked once the document has propagated into a journal entry (BFL 5 kap 6 §
 * räkenskapsinformation immutability): at that point the doc is the
 * verifikation's underlag and can only be undone by reversing the entry.
 */
export const DELETE = withRouteContext<{ params: Promise<{ id: string }> }>(
  'transaction.detach_document',
  async (_request, { supabase, companyId }, { params }) => {
    const { id: transactionId } = await params

    const { data: tx, error: fetchError } = await supabase
      .from('transactions')
      .select('id, document_id')
      .eq('id', transactionId)
      .eq('company_id', companyId)
      .maybeSingle()

    if (fetchError || !tx) {
      return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })
    }

    if (tx.document_id) {
      const { data: doc } = await supabase
        .from('document_attachments')
        .select('journal_entry_id')
        .eq('id', tx.document_id)
        .eq('company_id', companyId)
        .maybeSingle()
      if (doc?.journal_entry_id) {
        return NextResponse.json(
          {
            error:
              'Bilagan är kopplad till en bokförd verifikation och kan inte tas bort. Storno verifikationen först.',
          },
          { status: 409 },
        )
      }
    }

    const { error: updateError } = await supabase
      .from('transactions')
      .update({ document_id: null })
      .eq('id', transactionId)
      .eq('company_id', companyId)

    if (updateError) {
      // The enforce_transactions_document_immutability trigger raises a
      // P0001 exception with a stable BFL_DOCUMENT_IMMUTABILITY: prefix when the
      // previously-attached doc has already become räkenskapsinformation.
      // Match on the prefix (not on the generic SQLSTATE) so unrelated future
      // exceptions don't get translated into the Swedish underlag message.
      const errMsg = (updateError as { message?: string }).message ?? ''
      if (errMsg.includes('BFL_DOCUMENT_IMMUTABILITY')) {
        return NextResponse.json(
          {
            error:
              'Bilagan är kopplad till en bokförd verifikation och kan inte tas bort. Storno verifikationen först.',
          },
          { status: 409 },
        )
      }
      console.error('[attach-document] Failed to detach:', updateError)
      return NextResponse.json({ error: 'Failed to detach document' }, { status: 500 })
    }

    // Undo the inbox back-link the POST path wrote. Without this the item
    // still says matched_transaction_id = this tx, and the next categorize /
    // book / bulk-book runs propagateUnderlagForBookedTransaction, which
    // anchors the DETACHED document onto the new verifikation as immutable
    // underlag (BFL 5 kap 7 §: the verifikat would cite a receipt the user
    // rejected). Scoped by transaction, not by the pinned doc: the unique
    // index on matched_transaction_id means at most one item points here, and
    // a stale item whose doc differs from the pin (replace path) would
    // re-anchor just the same. Runs even when nothing was pinned, so a retry
    // after a partial failure below still clears the link. Items already
    // consumed by a verifikat are left alone.
    const { error: inboxUnlinkErr } = await supabase
      .from('invoice_inbox_items')
      .update({ matched_transaction_id: null })
      .eq('company_id', companyId)
      .eq('matched_transaction_id', transactionId)
      .is('created_journal_entry_id', null)
    if (inboxUnlinkErr) {
      // Not best-effort: a stale back-link is the exact defect this detach
      // exists to prevent, so a "succeeded" response here would hide a
      // compliance hazard. The pin removal above is committed and stays;
      // say so, and that a retry is idempotent (mirrors the POST side's
      // propagation failure).
      console.error('[attach-document] Failed to unlink inbox item:', inboxUnlinkErr)
      return NextResponse.json(
        {
          error:
            'Underlaget kopplades loss från transaktionen men inkorgsposten kunde inte släppas. Försök igen: operationen är idempotent.',
        },
        { status: 500 },
      )
    }

    return NextResponse.json({ data: { transaction_id: transactionId, document_id: null } })
  },
  { requireWrite: true },
)
