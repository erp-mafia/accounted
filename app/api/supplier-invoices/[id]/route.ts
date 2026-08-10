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

export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'supplier_invoice.get',
  async (_request, { supabase, companyId }, { params }) => {
  const { id } = await params

  const { data: invoice, error } = await supabase
    .from('supplier_invoices')
    .select(
      '*, supplier:suppliers(*), items:supplier_invoice_items(*), payments:supplier_invoice_payments(*), credited_original:supplier_invoices!credited_invoice_id(id, supplier_invoice_number, arrival_number)'
    )
    .eq('id', id)
    .eq('company_id', companyId)
    .single()

  if (error || !invoice) {
    return NextResponse.json({ error: 'Supplier invoice not found' }, { status: 404 })
  }

  return NextResponse.json({ data: invoice })
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

export const DELETE = withRouteContext<{ params: Promise<{ id: string }> }>(
  'supplier_invoice.delete',
  async (_request, { supabase, companyId, log }, { params }) => {
  const { id } = await params

  // Only allow deleting registered invoices without journal entries
  const { data: existing } = await supabase
    .from('supplier_invoices')
    .select('status, registration_journal_entry_id, is_credit_note')
    .eq('id', id)
    .eq('company_id', companyId)
    .single()

  if (!existing) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  // Block direct deletion of credit notes: deleting just the row would orphan the
  // posted reversal JE and silently break momsdeklaration. The user must instead
  // run "Ångra kreditering" on the original, which storno-reverses the JE and
  // restores the original's status atomically.
  if (existing.is_credit_note) {
    return NextResponse.json(
      {
        error:
          'Kreditfakturor kan inte tas bort direkt. Gå till originalfakturan och välj "Ångra kreditering" för att frigöra numret och återställa bokföringen.',
      },
      { status: 400 }
    )
  }

  // 'overdue' and 'approved' are included: the daily cron flips unbooked
  // invoices past due_date from registered/approved to 'overdue', and a
  // registered-only gate made such an invoice permanently undeletable just by
  // aging (support case 2026-07-26). What actually protects the books is the
  // orphan-safety checks below (no registration verifikat, no payments, no
  // accrual schedule), not the lifecycle label.
  if (!['registered', 'approved', 'overdue'].includes(existing.status)) {
    return NextResponse.json(
      { error: 'Endast obetalda fakturor utan bokföring kan tas bort' },
      { status: 400 }
    )
  }

  // Booked invoices must go through the credit flow (mirrors the credit-note
  // guard above). Three independent blockers:
  //   (a) a posted registration verifikat: deleting the row would orphan it
  //       and silently understate 2440/2641 for the momsdeklaration;
  //   (b) a payment row: deleting the invoice would orphan the payment's
  //       journal-entry link (belt-and-braces: payments normally move the
  //       status to partially_paid/paid, which the gate above already blocks);
  //   (c) an accrual schedule: accrual_schedules.supplier_invoice_id is
  //       ON DELETE RESTRICT, so the invoice DELETE below would fail AFTER the
  //       items were already deleted, leaving a broken invoice with zero rows.
  if (existing.registration_journal_entry_id) {
    return errorResponseFromCode('SI_DELETE_HAS_BOOKING', log, {
      details: { reason: 'registration_journal_entry' },
    })
  }

  // Both orphan-safety lookups fail CLOSED: a lookup error must block the
  // delete, otherwise a transient DB/RLS failure would read as "no payment /
  // no schedule" and let the delete through unverified.
  const { data: linkedPayment, error: paymentLookupError } = await supabase
    .from('supplier_invoice_payments')
    .select('id')
    .eq('company_id', companyId)
    .eq('supplier_invoice_id', id)
    .limit(1)
    .maybeSingle()

  if (paymentLookupError) {
    return NextResponse.json({ error: getUserErrorMessage(paymentLookupError) }, { status: 500 })
  }

  if (linkedPayment) {
    return errorResponseFromCode('SI_DELETE_HAS_BOOKING', log, {
      details: { reason: 'payments', paymentId: linkedPayment.id },
    })
  }

  const { data: linkedSchedule, error: scheduleLookupError } = await supabase
    .from('accrual_schedules')
    .select('id')
    .eq('company_id', companyId)
    .eq('supplier_invoice_id', id)
    .limit(1)
    .maybeSingle()

  if (scheduleLookupError) {
    return NextResponse.json({ error: getUserErrorMessage(scheduleLookupError) }, { status: 500 })
  }

  if (linkedSchedule) {
    return errorResponseFromCode('SI_DELETE_HAS_BOOKING', log, {
      details: { reason: 'accrual_schedule', scheduleId: linkedSchedule.id },
    })
  }

  // A payment-batch item documents a payment instruction possibly already
  // handed to the bank; supplier_payment_batch_items.supplier_invoice_id is
  // ON DELETE RESTRICT, so like (c) the invoice DELETE would fail AFTER the
  // items were deleted. Same fail-closed rule as the lookups above.
  const { data: linkedBatchItem, error: batchLookupError } = await supabase
    .from('supplier_payment_batch_items')
    .select('id, batch_id')
    .eq('company_id', companyId)
    .eq('supplier_invoice_id', id)
    .limit(1)
    .maybeSingle()

  if (batchLookupError) {
    return NextResponse.json({ error: getUserErrorMessage(batchLookupError) }, { status: 500 })
  }

  if (linkedBatchItem) {
    return errorResponseFromCode('SI_DELETE_IN_PAYMENT_BATCH', log, {
      details: { batchId: linkedBatchItem.batch_id },
    })
  }

  // Delete items first, then invoice
  await supabase.from('supplier_invoice_items').delete().eq('supplier_invoice_id', id)

  const { error } = await supabase
    .from('supplier_invoices')
    .delete()
    .eq('id', id)
    .eq('company_id', companyId)

  if (error) {
    return NextResponse.json({ error: getUserErrorMessage(error) }, { status: 500 })
  }

  return NextResponse.json({ success: true })
  },
  { requireWrite: true },
)
