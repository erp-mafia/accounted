import { NextResponse } from 'next/server'
import { renderToBuffer } from '@react-pdf/renderer'
import { withRouteContext } from '@/lib/api/with-route-context'
import { PRIVATE_NO_STORE_HEADERS, privateNoStore } from '@/lib/api/private-no-store'
import { InvoicePDF, type InvoicePdfInvoice } from '@/lib/invoices/pdf-template'
import { prepareInvoicePdfRender, buildSwishQrDataUrl, buildPaymentLinkQrDataUrl } from '@/lib/invoices/pdf-render-helpers'
import { resolveInvoicePayeeChoice } from '@/lib/invoices/invoice-payee'
import { getVatRules } from '@/lib/invoices/vat-rules'
import { invoicePdfFilename } from '@/lib/invoices/pdf-filename'
import { contentDisposition } from '@/lib/api/content-disposition'
import type { InvoiceItem, Customer, CompanySettings, Currency, InvoiceDocumentType } from '@/types'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { computeDeduction, computeInvoiceDeductionTotal, type DeductionType } from '@/lib/invoices/rot-rut-rules'
import { computeLineNet } from '@/lib/invoices/line-amounts'
import { roundOre } from '@/lib/money'
import { expandPersonnummerTo12, maskPersonnummer, validatePersonnummer } from '@/lib/salary/personnummer'
import { revealStoredCustomerPersonalNumber } from '@/lib/customers/protect-personal-number'
import {
  hasRequiredInvoicePaymentAccount,
  invoiceRequiresPaymentAccount,
} from '@/lib/invoices/payment-accounts'

/** The per-line ROT/RUT fields the editor posts alongside the amounts. */
interface PreviewItemInput {
  description: string
  quantity: number
  unit: string
  unit_price: number
  /** Line discount 0-100; amounts render net of it (line-amounts.ts). */
  discount_percent?: number | null
  vat_rate?: number
  deduction_type?: DeductionType | null
  labor_hours?: number | null
  work_type?: string | null
  housing_designation?: string | null
  apartment_number?: string | null
  brf_org_number?: string | null
}

function optionalTrimmed(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/**
 * The masked personnummer the deduction info box shows (`YYYYMMDD-XXXX`, the
 * same convention as the stored-invoice PDF and the payroll roster), resolved
 * the same way the write path does (lib/invoices/build-invoice-write.ts): the
 * value typed on the claim card wins; otherwise an individual customer's
 * kundkort personnummer, if it expands to a valid 12-digit number. Only the
 * masked form leaves this function; the plaintext is never stored or logged.
 */
function resolvePreviewPersonnummerMasked(typed: string | null, customer: Customer): string | null {
  if (typed) {
    // A 10-digit form (YYMMDD-NNNN) is expanded first so the mask shows the
    // full birth date; a half-typed value that does not expand shows nothing.
    const expanded = expandPersonnummerTo12(typed)
    return expanded ? maskPersonnummer(expanded) : null
  }
  if (customer.customer_type !== 'individual') return null
  try {
    const revealed = revealStoredCustomerPersonalNumber(customer.personal_number)
    const expanded = revealed ? expandPersonnummerTo12(revealed) : null
    if (expanded && validatePersonnummer(expanded).valid) return maskPersonnummer(expanded)
  } catch {
    // Undecryptable customer value: same as absent.
  }
  return null
}

/**
 * POST /api/invoices/preview-pdf
 *
 * Generates a preview PDF from form data without creating an invoice.
 * Returns the PDF as an inline blob for display in a new browser tab.
 */
export const POST = withRouteContext('invoice.preview_pdf', async (request, {
  supabase,
  user,
  companyId,
  log,
  requestId,
}) => {
  const body = await request.json()
  const {
    customer_id, invoice_date, due_date, delivery_date, valid_until, currency, items, your_reference, our_reference,
    invoice_marking, notes,
    document_type, invoice_number, payment_link_url, payment_cash_account_id,
    deduction_personnummer, deduction_housing_designation, deduction_apartment_number, deduction_brf_org_number,
  } = body

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
    return NextResponse.json(
      { error: 'Rader krävs' },
      { status: 400, headers: PRIVATE_NO_STORE_HEADERS },
    )
  }

  const docType: InvoiceDocumentType = document_type || 'invoice'
  const requestedCurrency = currency || 'SEK'

  // Fetch and validate company payment settings before customer data. The
  // preview performs no writes, but a request that cannot be rendered should
  // still stop before processing customer details.
  const { data: company, error: companyError } = await supabase
    .from('company_settings')
    .select('*')
    .eq('company_id', companyId)
    .single()

  if (companyError || !company) {
    return NextResponse.json(
      { error: 'Företagsinställningar saknas' },
      { status: 404, headers: PRIVATE_NO_STORE_HEADERS },
    )
  }

  // The chosen bank account (draft not yet saved): same validation as the
  // create route, so the preview shows what the saved invoice will print.
  const payeeChoice = await resolveInvoicePayeeChoice(
    supabase,
    companyId,
    requestedCurrency as Currency,
    typeof payment_cash_account_id === 'string' && payment_cash_account_id ? payment_cash_account_id : null,
  )
  if (!payeeChoice.ok) {
    return privateNoStore(errorResponseFromCode(payeeChoice.code, log, { requestId, details: payeeChoice.details }))
  }
  const previewPayee = payeeChoice.fields.payment_details

  if (!hasRequiredInvoicePaymentAccount(company as CompanySettings, {
    currency: requestedCurrency,
    document_type: docType,
    credited_invoice_id: null,
    payment_details: previewPayee,
  })) {
    return privateNoStore(errorResponseFromCode('INVOICE_SEND_PAYMENT_ACCOUNT_MISSING', log, {
      requestId,
      details: { currency: requestedCurrency },
    }))
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
      return NextResponse.json(
        { error: 'Kunduppgifter krävs' },
        { status: 400, headers: PRIVATE_NO_STORE_HEADERS },
      )
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
      contact_person: null,
      invoice_email_cc_addresses: null,
      invoice_email_bcc_addresses: null,
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
      return NextResponse.json(
        { error: 'Kunden hittades inte' },
        { status: 404, headers: PRIVATE_NO_STORE_HEADERS },
      )
    }
    customer = data as Customer
  }

  // VAT rules are customer-type-driven and only know the customer side.
  const vatRules = getVatRules(customer.customer_type, customer.vat_number_validated)

  const isDeliveryNote = docType === 'delivery_note'

  // VAT registration gate: mirror the server-side write gate
  // (lib/invoices/build-invoice-write.ts) so the preview never shows output VAT
  // for a non-momsregistrerad seller. Without this the per-item fallback below
  // (`?? vatRules.rate`) would render 25% for a Swedish customer even though the
  // created invoice books no VAT, misleading the user at the review step.
  const notVatRegistered = (company as { vat_registered?: boolean }).vat_registered === false
  const zeroVat = notVatRegistered && !isDeliveryNote

  // ROT/RUT (fakturamodellen) only exists on real invoices: the write path
  // zeroes deduction fields on proformas, delivery notes and quotes, so the
  // preview must too or it would show an avdrag the created document lacks.
  const deductionsApply = docType === 'invoice'
  const claimHousing = optionalTrimmed(deduction_housing_designation)
  const claimApartment = optionalTrimmed(deduction_apartment_number)
  const claimBrf = optionalTrimmed(deduction_brf_org_number)

  // Build items with line totals, per-item VAT and the per-line ROT/RUT
  // deduction, mirroring build-invoice-write.ts so the preview states the
  // same avdrag row, info box and "Att betala" as the invoice it becomes.
  const invoiceItems: InvoiceItem[] = items.map((item: PreviewItemInput, index: number) => {
    // Net of any per-line discount, same math as build-invoice-write.ts, so
    // the preview totals equal the invoice the form creates.
    const discountPercent = item.discount_percent ?? 0
    const lineTotal = roundOre(computeLineNet(item.quantity, item.unit_price, discountPercent))
    const rate = zeroVat ? 0 : (item.vat_rate ?? vatRules.rate)
    const deductionType = deductionsApply ? (item.deduction_type ?? null) : null
    // Same base as the write path: the NET line total inkl. moms at the rate
    // the line is rendered with (HUSFL 6-9 §§).
    const deductionAmount = deductionType
      ? computeDeduction({
          unit_price: item.unit_price,
          quantity: item.quantity,
          discount_percent: discountPercent,
          deduction_type: deductionType,
          vat_rate: rate,
        })
      : 0
    return {
      id: `preview-${index}`,
      invoice_id: 'preview',
      sort_order: index,
      description: item.description,
      quantity: item.quantity,
      unit: item.unit,
      unit_price: item.unit_price,
      discount_percent: discountPercent,
      line_total: lineTotal,
      vat_rate: rate,
      vat_amount: isDeliveryNote ? 0 : Math.round(lineTotal * (rate / 100) * 100) / 100,
      deduction_type: deductionType,
      deduction_amount: deductionAmount,
      labor_hours: deductionType ? (item.labor_hours ?? null) : null,
      work_type: deductionType ? (item.work_type ?? null) : null,
      // Property info: per-line value wins, else the invoice-level claim-card
      // value is stamped onto every deduction line (same as the write path).
      housing_designation: deductionType ? (optionalTrimmed(item.housing_designation) ?? claimHousing) : null,
      apartment_number: deductionType ? (optionalTrimmed(item.apartment_number) ?? claimApartment) : null,
      brf_org_number: deductionType ? (optionalTrimmed(item.brf_org_number) ?? claimBrf) : null,
      created_at: new Date().toISOString(),
    }
  })

  const subtotal = invoiceItems.reduce((sum, item) => sum + item.line_total, 0)
  const vatAmount = isDeliveryNote ? 0 : invoiceItems.reduce((sum, item) => sum + item.vat_amount, 0)
  const total = isDeliveryNote ? 0 : subtotal + vatAmount

  // Invoice-level deduction: the sum of the per-line amounts, computed with
  // the same helper the write path stores on invoices.deduction_total.
  const deductionTotal = deductionsApply
    ? computeInvoiceDeductionTotal(
        invoiceItems.map((item) => ({
          unit_price: item.unit_price,
          quantity: item.quantity,
          discount_percent: item.discount_percent ?? 0,
          deduction_type: item.deduction_type ?? null,
          vat_rate: item.vat_rate,
        })),
      )
    : 0
  const deductionPersonnummerMasked = deductionTotal > 0
    ? resolvePreviewPersonnummerMasked(optionalTrimmed(deduction_personnummer), customer)
    : null

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
    // Quotes (offert): the expiry the PDF prints as "Giltig till". The write
    // path mirrors it into due_date, so fall back to that for the preview.
    valid_until: docType === 'quote'
      ? ((typeof valid_until === 'string' && valid_until.trim()) || due_date || null)
      : null,
    status: 'draft',
    currency: requestedCurrency,
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
    invoice_marking: (typeof invoice_marking === 'string' && invoice_marking.trim()) || null,
    notes: notes || null,
    payment_link_url: previewPaymentLink,
    reverse_charge_text: vatRules.reverseChargeText || null,
    credited_invoice_id: null,
    document_type: docType,
    converted_from_id: null,
    paid_at: null,
    paid_amount: null,
    deduction_total: deductionTotal,
    // Preview invoices have no stored ciphertext: the template renders the
    // masked value passed here instead of deriving one.
    deduction_personnummer_masked: deductionPersonnummerMasked,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } as InvoicePdfInvoice

  try {
    const { branding, company: renderCompany } = await prepareInvoicePdfRender(
      company as CompanySettings,
      previewInvoice.currency,
      { paymentAccountRequired: invoiceRequiresPaymentAccount(previewInvoice), payee: previewPayee },
    )
    const swishQrDataUrl = await buildSwishQrDataUrl(renderCompany, previewInvoice)
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
    const filename = invoicePdfFilename({
      companyName: (company as CompanySettings).company_name,
      customerName: customer.name,
      invoiceNumber: previewInvoice.invoice_number,
      invoiceId: previewInvoice.id,
      invoiceDate: previewInvoice.invoice_date,
      documentType: previewInvoice.document_type,
    })

    return new Response(new Uint8Array(pdfBuffer), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': contentDisposition('inline', filename),
        'Cache-Control': 'private, no-store',
      },
    })
  } catch (error) {
    log.error('invoice preview PDF generation failed', error, { requestId })
    return NextResponse.json(
      { error: 'Kunde inte generera PDF-förhandsgranskning' },
      { status: 500, headers: PRIVATE_NO_STORE_HEADERS }
    )
  }
})
