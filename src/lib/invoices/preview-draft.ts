import type { SupabaseClient } from '@supabase/supabase-js'
import type { InvoicePreviewInput } from '@/lib/api/schemas'
import type { InvoicePdfInvoice } from '@/lib/invoices/pdf-template'
import type {
  CompanySettings,
  Currency,
  Customer,
  Invoice,
  InvoiceDocumentType,
  InvoiceItem,
  InvoicePaymentAccount,
} from '@/types'
import { deriveInvoiceVatHeader, resolveInvoiceVatRules } from '@/lib/invoices/vat-rules'
import { normalizeCountryCode } from '@/lib/vat/country-codes'
import { resolveInvoicePayeeChoice } from '@/lib/invoices/invoice-payee'
import {
  companyWithInvoicePaymentAccount,
  hasRequiredInvoicePaymentAccount,
  invoiceRequiresPaymentAccount,
} from '@/lib/invoices/payment-accounts'
import { buildInvoicePaymentRows, printsPayableRow } from '@/lib/invoices/payment-rows'
import { computeDeduction, computeInvoiceDeductionTotal } from '@/lib/invoices/rot-rut-rules'
import { computeLineNet } from '@/lib/invoices/line-amounts'
import { buildCreditNoteItem } from '@/lib/invoices/build-credit-note-item'
import {
  buildCreditNoteFields,
  creditNoteNumber,
  creditNoteOriginalReference,
} from '@/lib/invoices/build-credit-note'
import { fetchExchangeRate, convertToSEK } from '@/lib/currency/riksbanken'
import { roundOre } from '@/lib/money'
import { expandPersonnummerTo12, maskPersonnummer, validatePersonnummer } from '@/lib/salary/personnummer'
import { revealStoredCustomerPersonalNumber } from '@/lib/customers/protect-personal-number'
import { createLogger } from '@/lib/logger'

/**
 * The invoice editor's draft as the customer would receive it, built from
 * the form as it is now (InvoicePreviewSchema) without writing anything.
 * The one input of the PDF preview (POST /api/invoices/preview-pdf) and the
 * email preview (POST /api/invoices/preview-email), so the two always show
 * the same document.
 *
 * Parity with the write path (lib/invoices/build-invoice-write.ts): the same
 * VAT decision (resolveInvoiceVatRules with the invoice's own treatment,
 * deriveInvoiceVatHeader), the same line, deduction and SEK arithmetic, the
 * same payee choice, and the per-invoice delivery date, öresavrundning and
 * QR choice. A credit preview is the kreditfaktura POST /api/invoices
 * creates for that invoice (lib/invoices/build-credit-note.ts).
 *
 * A live preview renders a half-filled form instead of refusing it. Each
 * gap renders with a placeholder and is reported in `missing`, so the
 * editor can name it:
 *   - customer: no customer chosen yet (a sample customer prints);
 *   - rows:     no rows yet (one placeholder row prints);
 *   - payee:    nothing the customer can pay to prints for the currency.
 */

const log = createLogger('invoice.preview')

export type InvoicePreviewMissing = 'customer' | 'rows' | 'payee'

export interface InvoicePreviewDraft {
  invoice: InvoicePdfInvoice
  items: InvoiceItem[]
  customer: Customer
  /** The company settings row as stored: the renderer applies the payee. */
  company: CompanySettings
  /** The payee the draft prints; null = the company default for the currency. */
  payee: InvoicePaymentAccount | null
  /** Credit preview: the number of the invoice it credits. */
  originalInvoiceNumber?: string
  /** The document's language (the customer's). */
  language: 'sv' | 'en'
  missing: InvoicePreviewMissing[]
  /**
   * The rate the SEK amounts use on a foreign-currency document. On a draft
   * it is preliminary: the saved invoice fetches the rate for its own
   * taxable date. On a credit preview it is the original's.
   */
  exchangeRate: { rate: number; date: string | null } | null
}

export type BuildInvoicePreviewResult =
  | { ok: true; draft: InvoicePreviewDraft }
  | { ok: false; code: string; details?: Record<string, unknown> }

type PreviewItemInput = InvoicePreviewInput['items'][number]

/** The one row a draft without rows prints, in the document's language. */
export const PREVIEW_PLACEHOLDER_ROW_TEXT = {
  sv: 'Inga rader ännu',
  en: 'No rows yet',
} as const

/** The sample customer a draft without a customer prints. */
export function previewPlaceholderCustomer(nowIso: string = new Date().toISOString()): Customer {
  return {
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
}

/** Whether a draft customer is the sample one (no customer chosen yet). */
export function isPreviewPlaceholderCustomer(customer: Pick<Customer, 'id'>): boolean {
  return customer.id === 'preview-customer'
}

function optionalTrimmed(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/**
 * The masked personnummer the deduction box prints (`YYYYMMDD-XXXX`),
 * resolved like the write path: the value typed on the claim card wins,
 * else an individual customer's kundkort personnummer if it expands to a
 * valid 12-digit number. Only the masked form leaves this function.
 */
function resolvePreviewPersonnummerMasked(typed: string | null, customer: Customer): string | null {
  if (typed) {
    // A 10-digit form is expanded first so the mask shows the full birth
    // date; a half-typed value that does not expand shows nothing.
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

/** The link the write path would store: https only, else none. */
function previewPaymentLink(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  try {
    return new URL(trimmed).protocol === 'https:' ? trimmed : null
  } catch {
    return null
  }
}

async function loadPreviewCustomer(
  supabase: SupabaseClient,
  companyId: string,
  customerId: string | null,
): Promise<{ ok: true; customer: Customer } | { ok: false; code: string }> {
  if (!customerId) return { ok: true, customer: previewPlaceholderCustomer() }
  const { data, error } = await supabase
    .from('customers')
    .select('*')
    .eq('id', customerId)
    .eq('company_id', companyId)
    .single()
  if (error || !data) return { ok: false, code: 'INVOICE_CUSTOMER_NOT_FOUND' }
  return { ok: true, customer: data as Customer }
}

function documentLanguage(customer: Customer): 'sv' | 'en' {
  return customer.language === 'en' ? 'en' : 'sv'
}

/**
 * Whether the customer can pay this document from what prints: the payee
 * the send check requires, and at least one payable row on the page
 * (printsPayableRow: a stored but hidden Swish number prints nothing, and a
 * BIC alone is nothing to pay to). The editor's Betalning section asks the
 * same (lib/invoices/editor/payment-summary.ts).
 */
function printsPayableMethod(
  company: CompanySettings,
  invoice: InvoicePdfInvoice,
  payee: InvoicePaymentAccount | null,
  lang: 'sv' | 'en',
): boolean {
  if (!invoiceRequiresPaymentAccount(invoice)) return true
  if (!hasRequiredInvoicePaymentAccount(company, invoice)) return false
  return printsPayableRow(buildInvoicePaymentRows({
    company: companyWithInvoicePaymentAccount(company, invoice.currency, payee),
    invoice,
    lang,
  }))
}

export async function buildInvoicePreviewDraft(params: {
  supabase: SupabaseClient
  companyId: string
  userId: string
  input: InvoicePreviewInput
  /** The date a credit note and an undated draft get. Default: today (UTC), as the write path. */
  today?: string
}): Promise<BuildInvoicePreviewResult> {
  const { supabase, companyId } = params
  const today = params.today ?? new Date().toISOString().split('T')[0]

  const { data: companyRow, error: companyError } = await supabase
    .from('company_settings')
    .select('*')
    .eq('company_id', companyId)
    .single()
  if (companyError || !companyRow) return { ok: false, code: 'INVOICE_SEND_COMPANY_SETTINGS_MISSING' }
  const company = companyRow as CompanySettings

  return params.input.credited_invoice_id
    ? buildCreditNotePreview({ ...params, company, today, creditedInvoiceId: params.input.credited_invoice_id })
    : buildDraftPreview({ ...params, company, today })
}

async function buildCreditNotePreview(params: {
  supabase: SupabaseClient
  companyId: string
  userId: string
  input: InvoicePreviewInput
  company: CompanySettings
  today: string
  creditedInvoiceId: string
}): Promise<BuildInvoicePreviewResult> {
  const { supabase, companyId, company, input } = params
  const { data, error } = await supabase
    .from('invoices')
    .select('*, items:invoice_items(*)')
    .eq('id', params.creditedInvoiceId)
    .eq('company_id', companyId)
    .single()
  if (error || !data) return { ok: false, code: 'INVOICE_CREDIT_ORIGINAL_NOT_FOUND' }
  const original = data as Invoice & { items?: InvoiceItem[] | null }

  // The same refusals as creating it: only a real faktura with a number can
  // be credited (ML 17 kap 22-23 §§ refer to its number).
  if (original.document_type && original.document_type !== 'invoice') {
    return { ok: false, code: 'INVOICE_CREDIT_NOT_INVOICE', details: { documentType: original.document_type } }
  }
  const originalReference = creditNoteOriginalReference(original)
  if (!originalReference) return { ok: false, code: 'INVOICE_CREDIT_NO_NUMBER' }

  const customerResult = await loadPreviewCustomer(supabase, companyId, original.customer_id ?? null)
  if (!customerResult.ok) return customerResult
  const { customer } = customerResult

  const nowIso = new Date().toISOString()
  const fields = buildCreditNoteFields(original, {
    originalReference,
    // The credit page sends its reason as the note.
    reason: optionalTrimmed(input.notes),
    today: params.today,
  })
  const items = [...(original.items ?? [])]
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((item, index) => ({
      ...buildCreditNoteItem('preview', item),
      id: `preview-${index}`,
      created_at: nowIso,
    })) as InvoiceItem[]

  const invoice = {
    ...fields,
    id: 'preview',
    user_id: params.userId,
    invoice_number: creditNoteNumber(originalReference),
    status: 'draft',
    document_type: 'invoice',
    converted_from_id: null,
    paid_at: null,
    paid_amount: null,
    qr_mode: null,
    ore_rounding: null,
    payment_link_url: null,
    valid_until: null,
    created_at: nowIso,
    updated_at: nowIso,
  } as unknown as InvoicePdfInvoice

  return {
    ok: true,
    draft: {
      invoice,
      items,
      customer,
      company,
      payee: fields.payment_details,
      originalInvoiceNumber: originalReference,
      language: documentLanguage(customer),
      missing: isPreviewPlaceholderCustomer(customer) ? ['customer'] : [],
      exchangeRate:
        original.currency !== 'SEK' && original.exchange_rate
          ? { rate: original.exchange_rate, date: original.exchange_rate_date ?? null }
          : null,
    },
  }
}

async function buildDraftPreview(params: {
  supabase: SupabaseClient
  companyId: string
  userId: string
  input: InvoicePreviewInput
  company: CompanySettings
  today: string
}): Promise<BuildInvoicePreviewResult> {
  const { supabase, companyId, company, input } = params
  const docType: InvoiceDocumentType = input.document_type ?? 'invoice'
  const currency: Currency = input.currency ?? 'SEK'

  // The chosen bank account, validated as the create route does.
  const payeeChoice = await resolveInvoicePayeeChoice(supabase, companyId, currency, input.payment_cash_account_id)
  if (!payeeChoice.ok) return { ok: false, code: payeeChoice.code, details: payeeChoice.details }
  const payee = payeeChoice.fields.payment_details

  const customerResult = await loadPreviewCustomer(supabase, companyId, input.customer_id)
  if (!customerResult.ok) return customerResult
  const { customer } = customerResult
  const language = documentLanguage(customer)

  const isDeliveryNote = docType === 'delivery_note'
  // A seller outside the VAT register charges no VAT: every line is momsfri,
  // as the write path stores it.
  const notVatRegistered = company.vat_registered === false
  const zeroVat = notVatRegistered && !isDeliveryNote

  // What the invoice states about its own supply (#2906), decided by the
  // same rule the write path applies, refusals included.
  const vatOverride = {
    vat_treatment: input.vat_treatment ?? null,
    delivery_country: normalizeCountryCode(input.delivery_country),
  }
  const hasVatOverride = vatOverride.vat_treatment !== null || vatOverride.delivery_country !== null
  if (hasVatOverride && notVatRegistered) {
    return { ok: false, code: 'INVOICE_VAT_TREATMENT_NOT_VAT_REGISTERED', details: { ...vatOverride } }
  }
  const resolved = resolveInvoiceVatRules(customer, vatOverride)
  if (!resolved.ok) return { ok: false, code: resolved.code, details: resolved.details }
  const vatRules = resolved.rules

  // Skattereduktion only exists on a real faktura: the write path zeroes it
  // on proformas, delivery notes and quotes.
  const deductionsApply = docType === 'invoice'
  const claimHousing = optionalTrimmed(input.deduction_housing_designation)
  const claimApartment = optionalTrimmed(input.deduction_apartment_number)
  const claimBrf = optionalTrimmed(input.deduction_brf_org_number)

  const rows: PreviewItemInput[] = input.items.length > 0
    ? input.items
    : [{ line_type: 'text', description: PREVIEW_PLACEHOLDER_ROW_TEXT[language], quantity: 0, unit: '', unit_price: 0 }]

  const nowIso = new Date().toISOString()
  const items = rows.map((item, index): InvoiceItem => {
    const base = { id: `preview-${index}`, invoice_id: 'preview', sort_order: index, created_at: nowIso }
    if (item.line_type === 'text') {
      // Free-text rows carry no amounts, as the write path stores them.
      return {
        ...base,
        line_type: 'text',
        description: item.description,
        quantity: 0,
        unit: '',
        unit_price: 0,
        discount_percent: 0,
        line_total: 0,
        vat_rate: 0,
        vat_amount: 0,
        deduction_type: null,
        deduction_amount: 0,
        labor_hours: null,
        work_type: null,
        housing_designation: null,
        apartment_number: null,
        brf_org_number: null,
      }
    }
    const discountPercent = item.discount_percent ?? 0
    const lineNet = computeLineNet(item.quantity, item.unit_price, discountPercent)
    const rate = zeroVat ? 0 : (item.vat_rate ?? vatRules.rate)
    const deductionType = deductionsApply ? (item.deduction_type ?? null) : null
    const workType = deductionType ? (item.work_type?.trim() || null) : null
    // The base is the NET line total inkl. moms at the line's rate (HUSFL 6-9 §§).
    const deductionAmount = deductionType
      ? computeDeduction({
          unit_price: item.unit_price,
          quantity: item.quantity,
          discount_percent: discountPercent,
          deduction_type: deductionType,
          work_type: workType,
          vat_rate: rate,
        })
      : 0
    return {
      ...base,
      line_type: 'product',
      description: item.description,
      quantity: item.quantity,
      unit: item.unit,
      unit_price: item.unit_price,
      discount_percent: discountPercent,
      line_total: roundOre(lineNet),
      vat_rate: rate,
      // The write path's per-line VAT, from the unrounded net.
      vat_amount: isDeliveryNote ? 0 : Math.round(lineNet * rate / 100 * 100) / 100,
      deduction_type: deductionType,
      deduction_amount: deductionAmount,
      labor_hours: deductionType ? (item.labor_hours ?? null) : null,
      work_type: workType,
      // Per-line property info wins, else the claim card's is stamped onto
      // every deduction line (same as the write path).
      housing_designation: deductionType ? (optionalTrimmed(item.housing_designation) ?? claimHousing) : null,
      apartment_number: deductionType ? (optionalTrimmed(item.apartment_number) ?? claimApartment) : null,
      brf_org_number: deductionType ? (optionalTrimmed(item.brf_org_number) ?? claimBrf) : null,
    }
  })

  const billable = items.filter((item) => item.line_type !== 'text')
  const subtotal = isDeliveryNote ? 0 : roundOre(billable.reduce((sum, item) => sum + item.line_total, 0))
  const vatAmount = isDeliveryNote ? 0 : roundOre(billable.reduce((sum, item) => sum + item.vat_amount, 0))
  const total = isDeliveryNote ? 0 : roundOre(subtotal + vatAmount)

  const deductionTotal = deductionsApply
    ? computeInvoiceDeductionTotal(
        billable.map((item) => ({
          unit_price: item.unit_price,
          quantity: item.quantity,
          discount_percent: item.discount_percent ?? 0,
          deduction_type: item.deduction_type ?? null,
          work_type: item.work_type ?? null,
          vat_rate: item.vat_rate,
        })),
      )
    : 0

  // Header treatment, ruta and statutory notice from the rates the lines
  // carry, as the write path derives them.
  const lineRates = [...new Set(billable.map((item) => item.vat_rate))]
  const vatHeader = deriveInvoiceVatHeader(vatRules, lineRates, { vatRegistered: !notVatRegistered })
  const vatRate = isDeliveryNote ? 0 : lineRates.length > 1 ? null : (lineRates[0] ?? vatRules.rate)

  const invoiceDate = input.invoice_date ?? params.today
  // A quote has an expiry, not a due date; the write path mirrors it into due_date.
  const validUntil = docType === 'quote' ? (input.valid_until ?? input.due_date ?? null) : null
  const dueDate = validUntil ?? input.due_date ?? invoiceDate

  // SEK amounts of a foreign-currency draft (ML 17 kap 29 §), at the rate of
  // the taxable event as the write path fetches it. Preliminary: the saved
  // invoice fetches its own. A failed fetch prints no SEK rows, as a write
  // whose fetch fails stores none.
  let exchangeRate: { rate: number; date: string } | null = null
  if (currency !== 'SEK') {
    try {
      const rateData = await fetchExchangeRate(currency, new Date(input.delivery_date ?? invoiceDate), supabase)
      if (rateData) exchangeRate = { rate: rateData.rate, date: rateData.date }
    } catch (err) {
      log.warn('preview exchange rate unavailable; rendering without SEK amounts', {
        currency,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  const toSek = (amount: number): number | null => {
    if (isDeliveryNote) return null
    if (currency === 'SEK') return amount
    return exchangeRate ? roundOre(convertToSEK(amount, exchangeRate.rate)) : null
  }

  const invoice = {
    id: 'preview',
    user_id: params.userId,
    customer_id: customer.id,
    invoice_number: optionalTrimmed(input.invoice_number),
    invoice_date: invoiceDate,
    due_date: dueDate,
    delivery_date: input.delivery_date ?? null,
    valid_until: validUntil,
    status: 'draft',
    currency,
    exchange_rate: exchangeRate?.rate ?? null,
    exchange_rate_date: exchangeRate?.date ?? null,
    subtotal,
    subtotal_sek: toSek(subtotal),
    vat_amount: vatAmount,
    vat_amount_sek: toSek(vatAmount),
    total,
    total_sek: toSek(total),
    vat_treatment: vatHeader.vat_treatment,
    vat_rate: vatRate,
    moms_ruta: vatHeader.moms_ruta,
    reverse_charge_text: vatHeader.reverse_charge_text,
    vat_treatment_override: vatOverride.vat_treatment,
    delivery_country: vatOverride.delivery_country,
    your_reference: optionalTrimmed(input.your_reference),
    our_reference: optionalTrimmed(input.our_reference),
    invoice_marking: optionalTrimmed(input.invoice_marking),
    notes: input.notes || null,
    payment_link_url: previewPaymentLink(input.payment_link_url),
    payment_cash_account_id: payeeChoice.fields.payment_cash_account_id,
    payment_details: payee,
    qr_mode: input.qr_mode,
    // Per-invoice öresavrundning; null inherits the company setting.
    ore_rounding: input.ore_rounding ?? null,
    credited_invoice_id: null,
    document_type: docType,
    converted_from_id: null,
    paid_at: null,
    paid_amount: null,
    deduction_total: deductionTotal,
    // A preview has no stored ciphertext: the template prints this instead.
    deduction_personnummer_masked: deductionTotal > 0
      ? resolvePreviewPersonnummerMasked(optionalTrimmed(input.deduction_personnummer), customer)
      : null,
    created_at: nowIso,
    updated_at: nowIso,
  } as InvoicePdfInvoice

  const missing: InvoicePreviewMissing[] = []
  if (isPreviewPlaceholderCustomer(customer)) missing.push('customer')
  if (input.items.length === 0) missing.push('rows')
  if (!printsPayableMethod(company, invoice, payee, language)) missing.push('payee')

  return {
    ok: true,
    draft: { invoice, items, customer, company, payee, language, missing, exchangeRate },
  }
}
