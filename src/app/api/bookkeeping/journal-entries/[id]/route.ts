import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { eventBus } from '@/lib/events/bus'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { createLogger } from '@/lib/logger'
import {
  isCustomerPaymentSourceType,
  loadPaymentEntryLinks,
  syncInvoiceStatusFromPaymentEntry,
} from '@/lib/bookkeeping/payment-sync'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { CreateJournalEntrySchema } from '@/lib/api/schemas'
import { updateDraftJournalEntry } from '@/lib/core/bookkeeping/journal-entry-edits'
import { sessionFailureResponse } from '@/lib/operations/session'
import { bookkeepingErrorResponse } from '@/lib/bookkeeping/errors'
import { reanchorOrphanedSupplierInvoiceDocuments } from '@/lib/core/documents/supplier-invoice-underlag'

const logger = createLogger('journal-entries')

ensureInitialized()

export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'bookkeeping.journal_entry.get',
  async (_request, { supabase, companyId }, { params }) => {
    const { id } = await params

    const { data, error } = await supabase
      .from('journal_entries')
      .select('*, lines:journal_entry_lines(*)')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (error) {
      // PostgREST's "no rows" message is raw English; the user just needs to
      // know the verifikat is gone (matches JOURNAL_ENTRY_NOT_FOUND registry).
      return NextResponse.json(
        { error: 'Verifikationen kunde inte hittas.' },
        { status: 404 }
      )
    }

    return NextResponse.json({ data })
  },
)

export const DELETE = withRouteContext<{ params: Promise<{ id: string }> }>(
  'bookkeeping.journal_entry.delete',
  async (_request, { supabase, companyId, user }, { params }) => {
    const { id } = await params

  // Registers that hang on a verifikat live outside the GL, and their FKs are
  // ON DELETE SET NULL: without a revert they keep asserting a verifikat that
  // is gone. Who reverts what:
  //   - utlägg, supplier payment rows and the supplier invoice's paid state:
  //     delete_last_voucher itself (migration 20260920190000), in the same
  //     transaction as the delete, found by FK. It REFUSES the delete while an
  //     utlägg carries payout state, which a step running after the RPC never
  //     could. Nothing in this route may touch those registers afterwards: a
  //     second revert of a part payment wipes the payment that should stand.
  //   - customer invoice payments: the TS sync below. Their remaining_amount
  //     is the ROT/RUT customer share defined once in
  //     lib/invoices/customer-share.ts, which is not duplicated into SQL.
  const { data: entryBefore } = await supabase
    .from('journal_entries')
    .select('id, source_type, source_id')
    .eq('id', id)
    .eq('company_id', companyId)
    .single()

  const customerPaymentEntry =
    entryBefore && isCustomerPaymentSourceType(entryBefore.source_type) ? entryBefore : null

  // The payment rows and bank rows are read now, while the entry exists: their
  // journal_entry_id FKs are ON DELETE SET NULL, so after the RPC they can no
  // longer be found by entry id, and the sync would leave the payment row in
  // the invoice's history and revert the whole paid_amount instead of this
  // payment's share.
  const paymentLinks = customerPaymentEntry
    ? await loadPaymentEntryLinks(supabase, companyId, customerPaymentEntry)
    : null

  // delete_last_voucher clears journal_entry_id on every document hanging on
  // the voucher (the FK is ON DELETE RESTRICT, so it has no choice). Capture
  // them first: a document that is a supplier invoice's retained source
  // document must be re-anchored to another posted verifikat of that invoice
  // afterwards, or the invoice's remaining verifikat is left showing the PDF
  // while every missing-underlag surface (which requires an anchored doc)
  // keeps warning "Underlag saknas" with no way for the user to resolve it.
  const { data: linkedDocs } = await supabase
    .from('document_attachments')
    .select('id')
    .eq('company_id', companyId)
    .eq('journal_entry_id', id)

  const { data, error } = await supabase.rpc('delete_last_voucher', {
    p_company_id: companyId,
    p_entry_id: id,
  })

  if (error) {
    logger.error('delete_last_voucher failed', { entryId: id, error })
    return NextResponse.json(
      { error: getErrorMessage(error, { context: 'journal_entry', statusCode: 400 }) },
      { status: 400 }
    )
  }

  if (customerPaymentEntry) {
    try {
      await syncInvoiceStatusFromPaymentEntry(supabase, companyId, customerPaymentEntry, paymentLinks)
    } catch (syncError) {
      logger.warn('payment status sync failed after delete', { entryId: id, error: syncError })
    }
  }

  const orphanedDocIds = ((linkedDocs ?? []) as { id: string }[]).map((doc) => doc.id)
  const reanchored = await reanchorOrphanedSupplierInvoiceDocuments(
    supabase,
    companyId,
    orphanedDocIds,
  )
  if (reanchored > 0) {
    logger.info('re-anchored supplier invoice documents after voucher delete', {
      entryId: id,
      count: reanchored,
    })
  }

  await eventBus.emit({
    type: 'journal_entry.deleted',
    payload: {
      entryId: id,
      voucherSeries: data.voucher_series,
      voucherNumber: data.voucher_number,
      userId: user.id,
      companyId,
    },
  })

  return NextResponse.json({ data })
  },
  { requireWrite: true },
)

/**
 * PATCH: edit a DRAFT verifikat in place (header + lines). Only drafts are
 * editable; updateDraftEntry rejects committed entries with a 409, and the DB
 * immutability trigger is the backstop. Rules in
 * lib/core/bookkeeping/journal-entry-edits.ts, shared with the v1 operation
 * journal-entries.update-draft.
 */
export const PATCH = withRouteContext<{ params: Promise<{ id: string }> }>(
  'bookkeeping.journal_entry.update',
  async (request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params
    const validation = await validateBody(request, CreateJournalEntrySchema)
    if (!validation.success) return validation.response

    const outcome = await updateDraftJournalEntry(
      { supabase, companyId, userId: user.id, log },
      id,
      validation.data,
    )
    if (!outcome.ok) {
      // Typed bookkeeping errors keep the envelope this route has always
      // answered (the entry form reads its details).
      const typed = outcome.error ? bookkeepingErrorResponse(outcome.error) : null
      return typed ?? sessionFailureResponse(outcome, log, requestId)
    }
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
