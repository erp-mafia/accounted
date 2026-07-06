import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { eventBus } from '@/lib/events'
import { ensureInitialized } from '@/lib/init'
import { requireCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'
import { ensureInvoiceNumber } from '@/lib/invoices/ensure-invoice-number'
import type { Invoice } from '@/types'

ensureInitialized()

/**
 * POST /api/invoices/[id]/convert
 *
 * Converts a proforma invoice to a real invoice.
 * Copies all data, generates a real invoice number, and marks the proforma as cancelled.
 *
 * Ordering note: ensureInvoiceNumber() is the LAST side effect. The F-series
 * counter only advances after items are inserted and the proforma is marked
 * cancelled, so a partial failure in any earlier step rolls back the orphan
 * row without leaking a number.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const companyId = await requireCompanyId(supabase, user.id)

  const { data: proforma, error: proformaError } = await supabase
    .from('invoices')
    .select('*, items:invoice_items(*)')
    .eq('id', id)
    .eq('company_id', companyId)
    .single()

  if (proformaError || !proforma) {
    return NextResponse.json({ error: 'Proformafakturan hittades inte' }, { status: 404 })
  }

  if (proforma.document_type !== 'proforma') {
    return NextResponse.json(
      { error: 'Endast proformafakturor kan konverteras' },
      { status: 400 }
    )
  }

  if (proforma.status === 'cancelled') {
    return NextResponse.json(
      { error: 'Denna proformafaktura har redan makuleras' },
      { status: 400 }
    )
  }

  const { data: invoice, error: invoiceError } = await supabase
    .from('invoices')
    .insert({
      user_id: user.id,
      company_id: companyId,
      customer_id: proforma.customer_id,
      invoice_number: null,
      invoice_date: new Date().toISOString().split('T')[0],
      due_date: proforma.due_date,
      currency: proforma.currency,
      exchange_rate: proforma.exchange_rate,
      exchange_rate_date: proforma.exchange_rate_date,
      subtotal: proforma.subtotal,
      subtotal_sek: proforma.subtotal_sek,
      vat_amount: proforma.vat_amount,
      vat_amount_sek: proforma.vat_amount_sek,
      total: proforma.total,
      total_sek: proforma.total_sek,
      vat_treatment: proforma.vat_treatment,
      vat_rate: proforma.vat_rate,
      moms_ruta: proforma.moms_ruta,
      reverse_charge_text: proforma.reverse_charge_text,
      your_reference: proforma.your_reference,
      our_reference: proforma.our_reference,
      notes: proforma.notes,
      document_type: 'invoice',
      converted_from_id: id,
      // Dimensions PR7: the converted invoice books with the proforma's bag.
      default_dimensions: proforma.default_dimensions ?? {},
    })
    .select()
    .single()

  if (invoiceError) {
    return NextResponse.json({ error: invoiceError.message }, { status: 500 })
  }

  const items = (proforma.items || []).map((item: { sort_order: number; line_type?: 'product' | 'text'; description: string; quantity: number; unit: string; unit_price: number; line_total: number; dimensions?: Record<string, string> }) => ({
    invoice_id: invoice.id,
    sort_order: item.sort_order,
    line_type: item.line_type ?? 'product',
    description: item.description,
    quantity: item.quantity,
    unit: item.unit,
    unit_price: item.unit_price,
    line_total: item.line_total,
    dimensions: item.dimensions ?? {},
  }))

  if (items.length > 0) {
    const { error: itemsError } = await supabase
      .from('invoice_items')
      .insert(items)

    if (itemsError) {
      await supabase.from('invoices').delete().eq('id', invoice.id)
      return NextResponse.json({ error: itemsError.message }, { status: 500 })
    }
  }

  // Cancel the proforma. If this fails, the new (still unnumbered) invoice
  // is an orphan: delete it so the user can retry without ending up with
  // two active invoices for the same proforma. invoice_items cascade.
  const previousProformaStatus = proforma.status
  const { error: cancelError } = await supabase
    .from('invoices')
    .update({ status: 'cancelled' })
    .eq('id', id)

  if (cancelError) {
    await supabase.from('invoices').delete().eq('id', invoice.id)
    return NextResponse.json({ error: cancelError.message }, { status: 500 })
  }

  // Allocate the F-series number last. If allocation fails, restore the
  // proforma's previous status and delete the orphan invoice. The F-counter
  // is unaffected because generate_invoice_number only commits on success.
  try {
    await ensureInvoiceNumber(supabase, companyId, invoice as Invoice)
  } catch (err) {
    await supabase
      .from('invoices')
      .update({ status: previousProformaStatus })
      .eq('id', id)
    await supabase.from('invoices').delete().eq('id', invoice.id)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to assign invoice number' },
      { status: 500 }
    )
  }

  const { data: completeInvoice } = await supabase
    .from('invoices')
    .select('*, customer:customers(*), items:invoice_items(*)')
    .eq('id', invoice.id)
    .single()

  if (completeInvoice) {
    await eventBus.emit({
      type: 'invoice.created',
      payload: { invoice: completeInvoice as Invoice, companyId, userId: user.id },
    })
  }

  return NextResponse.json({ data: completeInvoice })
}
