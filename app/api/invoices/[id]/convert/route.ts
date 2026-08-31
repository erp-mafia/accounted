import { NextResponse } from 'next/server'
import { eventBus } from '@/lib/events'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { ensureInvoiceNumber } from '@/lib/invoices/ensure-invoice-number'
import type { Invoice } from '@/types'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

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
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'invoice.convert',
  async (request, { supabase, user, companyId }, { params }) => {
  const { id } = await params

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
      // The converted invoice is a fresh unpaid receivable: proformas carry no
      // ROT/RUT deduction, so the customer owes the full total. Omitting this
      // left the NOT NULL DEFAULT 0, which every payment surface reads as
      // "nothing open" (dialog overpayment rejection, bank match sees 0).
      remaining_amount: proforma.total,
      paid_amount: 0,
      vat_treatment: proforma.vat_treatment,
      vat_rate: proforma.vat_rate,
      moms_ruta: proforma.moms_ruta,
      reverse_charge_text: proforma.reverse_charge_text,
      your_reference: proforma.your_reference,
      our_reference: proforma.our_reference,
      // Buyer routing survives conversion (Peppol BT-10 may rely on it alone).
      invoice_marking: proforma.invoice_marking ?? null,
      notes: proforma.notes,
      document_type: 'invoice',
      converted_from_id: id,
      // Dimensions PR7: the converted invoice books with the proforma's bag.
      default_dimensions: proforma.default_dimensions ?? {},
    })
    .select()
    .single()

  if (invoiceError) {
    return NextResponse.json({ error: getUserErrorMessage(invoiceError) }, { status: 500 })
  }

  const items = (proforma.items || []).map((item: { sort_order: number; line_type?: 'product' | 'text'; description: string; quantity: number; unit: string; unit_price: number; discount_percent?: number | null; line_total: number; dimensions?: Record<string, string> }) => ({
    invoice_id: invoice.id,
    sort_order: item.sort_order,
    line_type: item.line_type ?? 'product',
    description: item.description,
    quantity: item.quantity,
    unit: item.unit,
    unit_price: item.unit_price,
    // The stored line_total is net of this; dropping it would make the
    // converted invoice fail the Peppol line check and lose the rebate on
    // the next builder pass.
    discount_percent: item.discount_percent ?? 0,
    line_total: item.line_total,
    dimensions: item.dimensions ?? {},
  }))

  if (items.length > 0) {
    const { error: itemsError } = await supabase
      .from('invoice_items')
      .insert(items)

    if (itemsError) {
      await supabase.from('invoices').delete().eq('id', invoice.id)
      return NextResponse.json({ error: getUserErrorMessage(itemsError) }, { status: 500 })
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
    return NextResponse.json({ error: getUserErrorMessage(cancelError) }, { status: 500 })
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
      { error: err instanceof Error ? getUserErrorMessage(err) : 'Failed to assign invoice number' },
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
  },
  { requireWrite: true },
)
