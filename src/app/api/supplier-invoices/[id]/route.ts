import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { UpdateSupplierInvoiceSchema } from '@/lib/api/schemas'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { getSwedishLocalDate } from '@/lib/bookkeeping/engine'
import {
  findChangedVerifikatFields,
  findLockedVerifikatFields,
  isUnsettledSupplierInvoiceStatus,
  resolveUnsettledStatus,
} from '@/lib/supplier-invoices/lifecycle'
import { deleteSupplierInvoice } from '@/lib/supplier-invoices/manage'
import { sessionFailureResponse } from '@/lib/operations/session'

export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'supplier_invoice.get',
  async (_request, { supabase, companyId }, { params }) => {
  const { id } = await params

  const { data: invoice, error } = await supabase
    .from('supplier_invoices')
    .select('*, supplier:suppliers(*), items:supplier_invoice_items(*), payments:supplier_invoice_payments(*)')
    .eq('id', id)
    .eq('company_id', companyId)
    .single()

  if (error || !invoice) {
    return NextResponse.json({ error: 'Supplier invoice not found' }, { status: 404 })
  }

  // The invoice a credit note reverses, fetched separately. credited_invoice_id
  // is a self-reference, and PostgREST cannot pick a direction for a
  // self-referencing embed from the column hint: the old
  // `credited_original:supplier_invoices!credited_invoice_id(...)` resolved to
  // the one-to-many side and came back as an empty array, which the detail
  // page rendered as "Krediterar: Ankomst #" with no number.
  let creditedOriginal: { id: string; supplier_invoice_number: string; arrival_number: number } | null = null
  if (invoice.credited_invoice_id) {
    const { data: original } = await supabase
      .from('supplier_invoices')
      .select('id, supplier_invoice_number, arrival_number')
      .eq('id', invoice.credited_invoice_id)
      .eq('company_id', companyId)
      .maybeSingle()
    creditedOriginal = original ?? null
  }

  return NextResponse.json({ data: { ...invoice, credited_original: creditedOriginal } })
  },
)

export const PUT = withRouteContext<{ params: Promise<{ id: string }> }>(
  'supplier_invoice.update',
  async (request, { supabase, companyId, log, requestId }, { params }) => {
  const { id } = await params

  // Editing is allowed while the invoice is unsettled. 'overdue' is included
  // because the daily cron flips unbooked invoices there just by aging, and a
  // registered-only gate then made them permanently read-only: you could not
  // even extend the due date to un-overdue them (#1206). The update body only
  // carries metadata (numbers, dates, reference, notes), never amounts or
  // accounts, so a posted registration verifikat cannot be desynced by money.
  // The two fields that DO reach the verifikat are gated separately below.
  const { data: existing } = await supabase
    .from('supplier_invoices')
    .select(
      'status, due_date, remaining_amount, is_credit_note, approved_at, invoice_date, supplier_invoice_number, registration_journal_entry_id',
    )
    .eq('id', id)
    .eq('company_id', companyId)
    .single()

  if (!existing) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  if (!isUnsettledSupplierInvoiceStatus(existing.status)) {
    return errorResponseFromCode('SI_EDIT_INVALID_STATUS', log, {
      requestId,
      details: { currentStatus: existing.status },
    })
  }

  const validation = await validateBody(request, UpdateSupplierInvoiceSchema)
  if (!validation.success) return validation.response
  const body = validation.data

  // A posted registration verifikat carries the invoice date (as entry_date)
  // and the invoice number (in the description). Rewriting either here would
  // desync the two silently and outside both sanctioned rättelse paths, so it
  // is refused with a pointer at the right route (#1230).
  const lockedFields = findLockedVerifikatFields(body, existing)
  if (lockedFields.length > 0) {
    return errorResponseFromCode('SI_EDIT_VERIFIKAT_LOCKED', log, {
      requestId,
      details: {
        fields: lockedFields,
        journalEntryId: existing.registration_journal_entry_id,
      },
    })
  }

  // Unbooked, but the update does move a verifikat-critical field: the write
  // below has to stay conditional on the invoice still being unbooked.
  const movesVerifikatFields = findChangedVerifikatFields(body, existing).length > 0

  // Keep the overdue label in step with the due date this update lands on
  // instead of waiting for the next cron run: extending the due date should
  // clear "Förfallen" immediately, and moving it into the past should set it.
  const restingStatus = resolveUnsettledStatus(
    {
      due_date: body.due_date ?? existing.due_date,
      remaining_amount: existing.remaining_amount,
      is_credit_note: existing.is_credit_note,
      approved_at: existing.approved_at,
    },
    getSwedishLocalDate(),
  )

  const rewritesStatus = restingStatus !== existing.status

  let update = supabase
    .from('supplier_invoices')
    .update(rewritesStatus ? { ...body, status: restingStatus } : body)
    .eq('id', id)
    .eq('company_id', companyId)

  if (movesVerifikatFields) {
    // The lock check above read a row that was still unbooked. A registration
    // entry posted between that read and this write would let exactly the
    // drift this guards against slip through, so pin the column: a concurrent
    // posting then matches zero rows and the caller is told to reload (the
    // retry hits the lock with the right message).
    update = update.is('registration_journal_entry_id', null)
  }

  if (rewritesStatus) {
    // Compare-and-swap, but only when this write derives a new status. The
    // label is computed from facts read a moment ago, so writing it back
    // unconditionally would let this request overwrite a concurrent cron flip
    // or approval with a status derived from what those changed. Pinning the
    // three inputs turns that into zero matched rows, i.e. a conflict the
    // caller can retry, instead of a silently stale label. Metadata-only
    // updates need no pin: they never touch status.
    update = update
      .eq('status', existing.status)
      .eq('due_date', existing.due_date)
    update = existing.approved_at
      ? update.eq('approved_at', existing.approved_at)
      : update.is('approved_at', null)
  }

  const { data, error } = await update.select().maybeSingle()

  if (error) {
    return NextResponse.json({ error: getUserErrorMessage(error) }, { status: 500 })
  }

  if (!data) {
    return errorResponseFromCode('SI_EDIT_CONFLICT', log, {
      requestId,
      details: { expectedStatus: existing.status, expectedDueDate: existing.due_date },
    })
  }

  return NextResponse.json({ data })
  },
  { requireWrite: true },
)

/**
 * Delete an unbooked supplier invoice. Rules (never a credit note, only
 * unpaid states, no verifikat / payment / accrual / payment-batch row) live
 * in lib/supplier-invoices/manage.ts, shared with v1 supplier-invoices.delete.
 */
export const DELETE = withRouteContext<{ params: Promise<{ id: string }> }>(
  'supplier_invoice.delete',
  async (_request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params
    const outcome = await deleteSupplierInvoice({ supabase, companyId, userId: user.id, log }, id)
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    return NextResponse.json({ success: true })
  },
  { requireWrite: true },
)
