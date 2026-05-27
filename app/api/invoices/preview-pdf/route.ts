import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { renderToBuffer } from '@react-pdf/renderer'
import { InvoicePDF } from '@/lib/invoices/pdf-template'
import { prepareInvoicePdfRender } from '@/lib/invoices/pdf-render-helpers'
import { getVatRules } from '@/lib/invoices/vat-rules'
import { requireCompanyId } from '@/lib/company/context'
import type { Invoice, InvoiceItem, Customer, CompanySettings, InvoiceDocumentType } from '@/types'

/**
 * POST /api/invoices/preview-pdf
 *
 * Generates a preview PDF from form data without creating an invoice.
 * Returns the PDF as an inline blob for display in a new browser tab.
 */
export async function POST(request: Request) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const companyId = await requireCompanyId(supabase, user.id)

  const body = await request.json()
  const { customer_id, invoice_date, due_date, delivery_date, currency, items, your_reference, our_reference, notes, document_type, invoice_number } = body

  if (!items || items.length === 0) {
    return NextResponse.json({ error: 'Rader krävs' }, { status: 400 })
  }

  // When customer_id is omitted, only allow the synthetic preview if the
  // company has no real customers — this is the settings-preview dead-end
  // case. Derived server-side so a client can't bypass the ownership check
  // by passing a flag.
  const isMockCustomer = !customer_id

  let customer: Customer
  if (isMockCustomer) {
    const { count, error: countError } = await supabase
      .from('customers')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)

    if (countError || (count ?? 0) > 0) {
      return NextResponse.json({ error: 'Kunduppgifter krävs' }, { status: 400 })
    }

    const nowIso = new Date().toISOString()
    customer = {
      id: 'preview-customer',
      user_id: 'preview-user',
      company_id: 'preview-company',
      name: 'Exempel AB',
      customer_type: 'swedish_business',
      email: 'kund@exempel.se',
      phone: null,
      address_line1: 'Storgatan 1',
      address_line2: null,
      postal_code: '111 22',
      city: 'Stockholm',
      country: 'SE',
      org_number: '556677-8899',
      vat_number: null,
      vat_number_validated: false,
      vat_number_validated_at: null,
      personal_number: null,
      language: 'sv',
      default_payment_terms: 30,
      notes: null,
      created_at: nowIso,
      updated_at: nowIso,
    }
  } else {
    const { data, error: customerError } = await supabase
      .from('customers')
      .select('*')
      .eq('id', customer_id)
      .eq('company_id', companyId)
      .single()

    if (customerError || !data) {
      return NextResponse.json({ error: 'Kunden hittades inte' }, { status: 404 })
    }
    customer = data as Customer
  }

  // Fetch company settings
  const { data: company, error: companyError } = await supabase
    .from('company_settings')
    .select('*')
    .eq('company_id', companyId)
    .single()

  if (companyError || !company) {
    return NextResponse.json({ error: 'Företagsinställningar saknas' }, { status: 404 })
  }

  // Match the creation API: a non-VAT-registered seller may not charge VAT
  // (ML 1 kap. 1§). Coerce instead of rejecting so the preview always renders
  // — the form may still be carrying a stale 25% selection while the user
  // hasn't yet noticed the rate picker locked itself. Default `true` mirrors
  // the API and getVatRules' own default — a NULL column must not silently
  // strip VAT from a preview the seller is about to send.
  const vatRegistered = (company as CompanySettings).vat_registered ?? true
  const vatRules = getVatRules(customer.customer_type, customer.vat_number_validated, vatRegistered)

  const docType: InvoiceDocumentType = document_type || 'invoice'
  const isDeliveryNote = docType === 'delivery_note'

  // Build items with line totals and per-item VAT
  const invoiceItems: InvoiceItem[] = items.map((item: { description: string; quantity: number; unit: string; unit_price: number; vat_rate?: number }, index: number) => {
    const lineTotal = Math.round(item.quantity * item.unit_price * 100) / 100
    const rate = vatRegistered ? (item.vat_rate ?? vatRules.rate) : 0
    return {
      id: `preview-${index}`,
      invoice_id: 'preview',
      sort_order: index,
      description: item.description,
      quantity: item.quantity,
      unit: item.unit,
      unit_price: item.unit_price,
      line_total: lineTotal,
      vat_rate: rate,
      vat_amount: isDeliveryNote ? 0 : Math.round(lineTotal * (rate / 100) * 100) / 100,
      created_at: new Date().toISOString(),
    }
  })

  const subtotal = invoiceItems.reduce((sum, item) => sum + item.line_total, 0)
  const vatAmount = isDeliveryNote ? 0 : invoiceItems.reduce((sum, item) => sum + item.vat_amount, 0)
  const total = isDeliveryNote ? 0 : subtotal + vatAmount

  // Derive vat_rate from items: single rate → that rate, mixed → null
  const itemRates = new Set(invoiceItems.map((item) => item.vat_rate))
  const effectiveVatRate = isDeliveryNote ? 0 : (itemRates.size === 1 ? itemRates.values().next().value! : null)

  // Construct a temporary Invoice-like object
  const previewInvoice = {
    id: 'preview',
    user_id: isMockCustomer ? 'preview-user' : user.id,
    customer_id: customer.id,
    invoice_number: typeof invoice_number === 'string' && invoice_number.trim()
      ? invoice_number
      : isMockCustomer ? '1' : null,
    invoice_date: invoice_date || new Date().toISOString().split('T')[0],
    due_date: due_date || new Date().toISOString().split('T')[0],
    delivery_date: delivery_date || null,
    status: 'draft',
    currency: currency || 'SEK',
    exchange_rate: null,
    exchange_rate_date: null,
    subtotal: isDeliveryNote ? 0 : subtotal,
    subtotal_sek: null,
    vat_amount: vatAmount,
    vat_amount_sek: null,
    total,
    total_sek: null,
    vat_treatment: vatRules.treatment,
    vat_rate: effectiveVatRate,
    moms_ruta: vatRules.momsRuta,
    your_reference: your_reference || null,
    our_reference: our_reference || null,
    notes: notes || null,
    reverse_charge_text: vatRules.reverseChargeText || null,
    credited_invoice_id: null,
    document_type: docType,
    converted_from_id: null,
    paid_at: null,
    paid_amount: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } as Invoice

  try {
    const { branding } = prepareInvoicePdfRender(company as CompanySettings)
    const pdfBuffer = await renderToBuffer(
      InvoicePDF({
        invoice: previewInvoice,
        customer,
        items: invoiceItems,
        company: company as CompanySettings,
        isPreview: true,
        branding,
      })
    )

    return new Response(new Uint8Array(pdfBuffer), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'inline; filename="forhandsvisning.pdf"',
      },
    })
  } catch (error) {
    console.error('Preview PDF generation error:', error)
    return NextResponse.json(
      { error: 'Kunde inte generera PDF-förhandsgranskning' },
      { status: 500 }
    )
  }
}
