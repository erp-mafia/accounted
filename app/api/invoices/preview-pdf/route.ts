import { NextResponse } from 'next/server'
import { renderToBuffer } from '@react-pdf/renderer'
import { withRouteContext } from '@/lib/api/with-route-context'
import { InvoicePDF } from '@/lib/invoices/pdf-template'
import { prepareInvoicePdfRender, buildSwishQrDataUrl, buildPaymentLinkQrDataUrl } from '@/lib/invoices/pdf-render-helpers'
import { getVatRules } from '@/lib/invoices/vat-rules'
import type { Invoice, InvoiceItem, Customer, CompanySettings, InvoiceDocumentType } from '@/types'

/**
 * POST /api/invoices/preview-pdf
 *
 * Generates a preview PDF from form data without creating an invoice.
 * Returns the PDF as an inline blob for display in a new browser tab.
 */
export const POST = withRouteContext('invoice.preview_pdf', async (request, { supabase, user, companyId }) => {
  const body = await request.json()
  const { customer_id, invoice_date, due_date, delivery_date, currency, items, your_reference, our_reference, notes, document_type, invoice_number, payment_link_url } = body

  // Preview-only https gate, mirroring CreateInvoiceSchema: the value is
  // rendered as a clickable link + QR in the preview PDF.
  const previewPaymentLink = (() => {
    if (typeof payment_link_url !== 'string' || !payment_link_url.trim()) return null
    try {
      return new URL(payment_link_url).protocol === 'https:' ? payment_link_url.trim() : null
    } catch {
      return null
    }
  })()

  if (!items || items.length === 0) {
    return NextResponse.json({ error: 'Rader krävs' }, { status: 400 })
  }

  // When customer_id is omitted, only allow the synthetic preview if the
  // company has no real customers: this is the settings-preview dead-end
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
      customer_number: null,
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

  // VAT rules are customer-type-driven and only know the customer side.
  const vatRules = getVatRules(customer.customer_type, customer.vat_number_validated)

  const docType: InvoiceDocumentType = document_type || 'invoice'
  const isDeliveryNote = docType === 'delivery_note'

  // VAT registration gate: mirror the server-side write gate
  // (lib/invoices/build-invoice-write.ts) so the preview never shows output VAT
  // for a non-momsregistrerad seller. Without this the per-item fallback below
  // (`?? vatRules.rate`) would render 25% for a Swedish customer even though the
  // created invoice books no VAT, misleading the user at the review step.
  const notVatRegistered = (company as { vat_registered?: boolean }).vat_registered === false
  const zeroVat = notVatRegistered && !isDeliveryNote

  // Build items with line totals and per-item VAT
  const invoiceItems: InvoiceItem[] = items.map((item: { description: string; quantity: number; unit: string; unit_price: number; vat_rate?: number }, index: number) => {
    const lineTotal = Math.round(item.quantity * item.unit_price * 100) / 100
    const rate = zeroVat ? 0 : (item.vat_rate ?? vatRules.rate)
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
    payment_link_url: previewPaymentLink,
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
    const { branding, company: renderCompany } = await prepareInvoicePdfRender(
      company as CompanySettings,
    )
    const swishQrDataUrl = await buildSwishQrDataUrl(company as CompanySettings, previewInvoice)
    const paymentLinkQrDataUrl = await buildPaymentLinkQrDataUrl(previewInvoice)
    const pdfBuffer = await renderToBuffer(
      InvoicePDF({
        invoice: previewInvoice,
        customer,
        items: invoiceItems,
        company: renderCompany,
        isPreview: true,
        branding,
        swishQrDataUrl,
        paymentLinkQrDataUrl,
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
})
