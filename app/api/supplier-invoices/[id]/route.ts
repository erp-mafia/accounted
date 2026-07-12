import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { UpdateSupplierInvoiceSchema } from '@/lib/api/schemas'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'

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
  async (request, { supabase, companyId }, { params }) => {
  const { id } = await params

  // Only allow editing registered invoices
  const { data: existing } = await supabase
    .from('supplier_invoices')
    .select('status')
    .eq('id', id)
    .eq('company_id', companyId)
    .single()

  if (!existing) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  if (existing.status !== 'registered') {
    return NextResponse.json(
      { error: 'Kan bara redigera registrerade fakturor' },
      { status: 400 }
    )
  }

  const validation = await validateBody(request, UpdateSupplierInvoiceSchema)
  if (!validation.success) return validation.response
  const body = validation.data

  const { data, error } = await supabase
    .from('supplier_invoices')
    .update(body)
    .eq('id', id)
    .eq('company_id', companyId)
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
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

  if (existing.status !== 'registered') {
    return NextResponse.json(
      { error: 'Kan bara ta bort registrerade fakturor' },
      { status: 400 }
    )
  }

  // Booked invoices must go through the credit flow (mirrors the credit-note
  // guard above). Two independent blockers:
  //   (a) a posted registration verifikat: deleting the row would orphan it
  //       and silently understate 2440/2641 for the momsdeklaration;
  //   (b) an accrual schedule: accrual_schedules.supplier_invoice_id is
  //       ON DELETE RESTRICT, so the invoice DELETE below would fail AFTER the
  //       items were already deleted, leaving a broken invoice with zero rows.
  if (existing.registration_journal_entry_id) {
    return errorResponseFromCode('SI_DELETE_HAS_BOOKING', log, {
      details: { reason: 'registration_journal_entry' },
    })
  }

  const { data: linkedSchedule } = await supabase
    .from('accrual_schedules')
    .select('id')
    .eq('company_id', companyId)
    .eq('supplier_invoice_id', id)
    .limit(1)
    .maybeSingle()

  if (linkedSchedule) {
    return errorResponseFromCode('SI_DELETE_HAS_BOOKING', log, {
      details: { reason: 'accrual_schedule', scheduleId: linkedSchedule.id },
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
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
  },
  { requireWrite: true },
)
