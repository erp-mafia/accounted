import type { SupabaseClient } from '@supabase/supabase-js'
import type { Currency, Customer, InvoiceDocumentType } from '@/types'
import { getVatRules, getAvailableVatRates } from '@/lib/invoices/vat-rules'
import { fetchExchangeRate, convertToSEK } from '@/lib/currency/riksbanken'
import { DEFAULT_DEFERRED_REVENUE_ACCOUNT } from '@/lib/bookkeeping/accruals/account-suggestions'
import {
  computeDeduction,
  computeInvoiceDeductionTotal,
  validateInvoice as validateRotRut,
} from '@/lib/invoices/rot-rut-rules'
import {
  encryptPersonnummer,
  extractLast4,
  validatePersonnummer,
} from '@/lib/salary/personnummer'

/**
 * Shared invoice write-builder.
 *
 * Encapsulates the validation + computation that is IDENTICAL whether an
 * invoice (or proforma / delivery note) is being created (POST /api/invoices)
 * or a draft is being edited in place (PATCH /api/invoices/[id]):
 *
 *  - per-customer VAT rule gating (allowed rates) + not-VAT-registered zeroing
 *  - periodisering (accrual) guards
 *  - subtotal / per-rate VAT / total
 *  - per-line revenue-account override validation against chart_of_accounts
 *  - server-side ROT/RUT compute + personnummer encryption (never trust client)
 *  - mixed-rate detection, currency → SEK conversion
 *  - the invoice_items row mapping
 *
 * It intentionally does NOT allocate an invoice number or emit events: those
 * differ between create and update and stay in the route handlers. The returned
 * `invoiceFields` exclude `user_id`, `company_id`, `invoice_number` and `status`;
 * the caller merges those. Returned `items` carry no `invoice_id`: the caller
 * adds it once the invoice row id is known.
 */

// The validated line shape (a superset of what create/update schemas produce).
export interface InvoiceWriteItemInput {
  line_type?: 'product' | 'text'
  description: string
  quantity: number
  unit: string
  unit_price: number
  vat_rate?: number
  article_id?: string | null
  revenue_account?: string | null
  deduction_type?: 'rot' | 'rut' | null
  labor_hours?: number | null
  work_type?: string | null
  housing_designation?: string | null
  apartment_number?: string | null
  brf_org_number?: string | null
  accrual_period_start?: string | null
  accrual_period_end?: string | null
  accrual_balance_account?: string | null
  /** Dimensions PR7: per-item bag merged over the invoice default at booking. */
  dimensions?: Record<string, string>
}

export interface InvoiceWriteInput {
  customer_id: string
  invoice_date: string
  due_date: string
  delivery_date?: string | null
  currency: Currency
  your_reference?: string
  our_reference?: string
  notes?: string
  /** Per-invoice öresavrundning override (display-only). Omitted → null (inherit company setting). */
  ore_rounding?: boolean
  deduction_personnummer?: string
  deduction_housing_designation?: string
  /** ROT i bostadsrätt: lägenhetsnummer + föreningens orgnr instead of fastighetsbeteckning. */
  deduction_apartment_number?: string
  deduction_brf_org_number?: string
  /** Dimensions PR7: invoice-level bag applied to every generated journal line. */
  default_dimensions?: Record<string, string>
  items: InvoiceWriteItemInput[]
}

// The computed invoice-row fields shared by create and update. Deliberately
// untyped-strict (Record) so it slots straight into a Supabase insert/update;
// every value is computed here from validated input.
export type InvoiceWriteFields = {
  customer_id: string
  invoice_date: string
  due_date: string
  delivery_date: string | null
  currency: Currency
  exchange_rate: number | null
  exchange_rate_date: string | null
  subtotal: number
  subtotal_sek: number | null
  vat_amount: number
  vat_amount_sek: number | null
  total: number
  total_sek: number | null
  remaining_amount: number
  vat_treatment: string
  vat_rate: number | null
  moms_ruta: string | null
  reverse_charge_text: string | null
  your_reference: string | null | undefined
  our_reference: string | null | undefined
  notes: string | null | undefined
  ore_rounding: boolean | null
  document_type: InvoiceDocumentType
  deduction_total: number
  deduction_personnummer_encrypted: string | null
  deduction_personnummer_last4: string | null
  default_dimensions: Record<string, string>
}

export type InvoiceWriteItemRow = {
  sort_order: number
  line_type: 'product' | 'text'
  description: string
  quantity: number
  unit: string
  unit_price: number
  line_total: number
  vat_rate: number
  vat_amount: number
  article_id: string | null
  revenue_account: string | null
  deduction_type: 'rot' | 'rut' | null
  deduction_amount: number
  labor_hours: number | null
  work_type: string | null
  housing_designation: string | null
  apartment_number: string | null
  brf_org_number: string | null
  accrual_period_start: string | null
  accrual_period_end: string | null
  accrual_balance_account: string | null
  dimensions: Record<string, string>
}

export type BuildInvoiceWriteResult =
  | { ok: true; invoiceFields: InvoiceWriteFields; items: InvoiceWriteItemRow[] }
  // Domain validation failure: map via errorResponseFromCode(code, { details }).
  | { ok: false; code: string; details?: Record<string, unknown> }
  // Unexpected DB error from an internal lookup: map via errorResponse(dbError).
  | { ok: false; dbError: unknown }

export async function buildInvoiceWriteData(params: {
  supabase: SupabaseClient
  companyId: string
  customer: Customer
  documentType: InvoiceDocumentType
  input: InvoiceWriteInput
}): Promise<BuildInvoiceWriteResult> {
  const { supabase, companyId, customer, documentType, input } = params
  const items = input.items

  const vatRules = getVatRules(customer.customer_type, customer.vat_number_validated)
  const availableRates = getAvailableVatRates(customer.customer_type, customer.vat_number_validated)
  const allowedRates = new Set(availableRates.map((r) => r.rate))

  // VAT registration gate (defense in depth: the invoice form already hides
  // the Moms column when vat_registered is false). A non-momsregistrerad
  // company books no output VAT: zero every line rate so the sale lands as
  // momsfri (treatment 'exempt' → revenue 3004/3100, no 2611). 0% is a valid
  // rate for every customer type, so the allowedRates guard below still passes.
  const { data: vatSettings } = await supabase
    .from('company_settings')
    .select('vat_registered')
    .eq('company_id', companyId)
    .maybeSingle()
  const notVatRegistered = vatSettings?.vat_registered === false
  if (notVatRegistered && documentType !== 'delivery_note') {
    for (const item of items) item.vat_rate = 0
  }

  // Periodisering guards. The line schema already validates the period shape;
  // here we gate the flows where deferral has no meaning: cash method
  // (recognition at payment), reverse charge/export (3308/3305 must reflect the
  // full sale for ruta 39/40), and non-invoice document types.
  const hasAccrualItems = items.some(
    (item) => item.accrual_period_start && item.accrual_period_end,
  )
  if (hasAccrualItems) {
    if (documentType !== 'invoice') {
      return { ok: false, code: 'INVOICE_CREATE_ACCRUAL_INVALID', details: { reason: 'document_type', documentType } }
    }
    if (vatRules.treatment === 'reverse_charge' || vatRules.treatment === 'export') {
      return { ok: false, code: 'INVOICE_CREATE_ACCRUAL_INVALID', details: { reason: 'vat_treatment', vatTreatment: vatRules.treatment } }
    }
    const { data: methodSettings } = await supabase
      .from('company_settings')
      .select('accounting_method')
      .eq('company_id', companyId)
      .maybeSingle()
    if ((methodSettings?.accounting_method || 'accrual') !== 'accrual') {
      return { ok: false, code: 'INVOICE_CREATE_ACCRUAL_INVALID', details: { reason: 'accounting_method' } }
    }
  }

  // Free-text rows carry no amounts and are excluded from totals + VAT.
  const subtotal = items.reduce(
    (sum, item) => (item.line_type === 'text' ? sum : sum + item.quantity * item.unit_price),
    0,
  )

  let vatAmount = 0
  if (documentType !== 'delivery_note') {
    for (const item of items) {
      if (item.line_type === 'text') continue
      const itemRate = item.vat_rate !== undefined ? item.vat_rate : vatRules.rate
      if (!allowedRates.has(itemRate)) {
        return {
          ok: false,
          code: 'INVOICE_CREATE_VAT_RULE_VIOLATION',
          details: {
            attemptedRate: itemRate,
            allowedRates: Array.from(allowedRates),
            customerType: customer.customer_type,
          },
        }
      }
      const lineTotal = item.quantity * item.unit_price
      vatAmount += Math.round(lineTotal * itemRate / 100 * 100) / 100
    }
  }
  const total = documentType === 'delivery_note' ? 0 : subtotal + vatAmount

  // Validate any per-line revenue-account override against the company's chart
  // of accounts. Zod already constrains the shape to a 3xxx string; here we
  // confirm each is a real, active class-3 account so a typo or a non-revenue
  // account can never be booked. Never trust the client.
  const overrideAccounts = Array.from(
    new Set(
      items
        .map((item) => item.revenue_account)
        .filter((a): a is string => !!a),
    ),
  )
  if (overrideAccounts.length > 0) {
    const { data: validAccounts, error: accountsError } = await supabase
      .from('chart_of_accounts')
      .select('account_number')
      .eq('company_id', companyId)
      .eq('account_class', 3)
      .eq('is_active', true)
      .in('account_number', overrideAccounts)

    if (accountsError) {
      return { ok: false, dbError: accountsError }
    }
    const validSet = new Set((validAccounts ?? []).map((a) => a.account_number))
    const invalid = overrideAccounts.filter((a) => !validSet.has(a))
    if (invalid.length > 0) {
      return { ok: false, code: 'INVOICE_CREATE_REVENUE_ACCOUNT_INVALID', details: { invalidAccounts: invalid } }
    }
  }

  // ROT/RUT-avdrag: validate prerequisites and compute the per-item +
  // invoice-level deduction. Computed server-side (never trusted from the
  // client) so a tampered request can't expand the 1513 receivable. Skipped
  // entirely for proformas, delivery notes, and quotes: those documents don't
  // post journal entries and have no deduction model.
  let deductionTotal = 0
  let deductionPersonnummerEncrypted: string | null = null
  let deductionPersonnummerLast4: string | null = null
  if (documentType === 'invoice') {
    // Housing info satisfies the ROT requirement in either of two shapes
    // (Begaran.xsd V6): fastighetsbeteckning (småhus/ägarlägenhet) OR
    // lägenhetsnummer + bostadsrättsföreningens orgnr (bostadsrätt).
    const fastighetProvided = !!input.deduction_housing_designation?.trim()
    const apartmentProvided = !!input.deduction_apartment_number?.trim()
    const brfProvided = !!input.deduction_brf_org_number?.trim()
    if ((apartmentProvided || brfProvided) && !(apartmentProvided && brfProvided)) {
      return {
        ok: false,
        code: 'INVOICE_CREATE_ROT_RUT_VALIDATION',
        details: {
          errors: ['För bostadsrätt krävs både lägenhetsnummer och föreningens organisationsnummer.'],
          warnings: [],
        },
      }
    }
    const housingProvided = fastighetProvided || (apartmentProvided && brfProvided)
    const personnummerRaw = input.deduction_personnummer?.trim() || ''
    const personnummerProvided = personnummerRaw.length > 0

    const validateInput = items.map((item) => ({
      unit_price: item.unit_price,
      quantity: item.quantity,
      deduction_type: item.deduction_type ?? null,
      labor_hours: item.labor_hours ?? null,
      housing_designation: item.housing_designation ?? null,
    }))
    const validation = validateRotRut(validateInput, personnummerProvided, housingProvided)
    if (validation.errors.length > 0) {
      return {
        ok: false,
        code: 'INVOICE_CREATE_ROT_RUT_VALIDATION',
        details: { errors: validation.errors, warnings: validation.warnings },
      }
    }

    // Compute and (when present) encrypt the personnummer. The plaintext value
    // never touches the DB: only the AES-256-GCM ciphertext + the last four
    // digits go into invoices columns.
    deductionTotal = computeInvoiceDeductionTotal(validateInput)
    if (personnummerProvided) {
      const pnValid = validatePersonnummer(personnummerRaw)
      if (!pnValid.valid) {
        return { ok: false, code: 'INVOICE_CREATE_ROT_RUT_PERSONNUMMER_INVALID', details: { error: pnValid.error } }
      }
      deductionPersonnummerEncrypted = encryptPersonnummer(personnummerRaw)
      deductionPersonnummerLast4 = extractLast4(personnummerRaw)
    }
  }

  const uniqueRates = new Set(
    items
      .filter((item) => item.line_type !== 'text')
      .map((item) => item.vat_rate ?? vatRules.rate),
  )
  const isMixedRate = uniqueRates.size > 1

  let exchangeRate: number | null = null
  let exchangeRateDate: string | null = null
  let subtotalSek: number | null = null
  let vatAmountSek: number | null = null
  let totalSek: number | null = null

  if (input.currency !== 'SEK') {
    const rateData = await fetchExchangeRate(input.currency)
    if (rateData) {
      exchangeRate = rateData.rate
      exchangeRateDate = rateData.date
      subtotalSek = convertToSEK(subtotal, exchangeRate)
      vatAmountSek = convertToSEK(vatAmount, exchangeRate)
      totalSek = convertToSEK(total, exchangeRate)
    }
  }

  const invoiceFields: InvoiceWriteFields = {
    customer_id: input.customer_id,
    invoice_date: input.invoice_date,
    due_date: input.due_date,
    delivery_date: input.delivery_date ?? null,
    currency: input.currency,
    exchange_rate: exchangeRate,
    exchange_rate_date: exchangeRateDate,
    subtotal: documentType === 'delivery_note' ? 0 : subtotal,
    subtotal_sek: documentType === 'delivery_note' ? null : subtotalSek,
    vat_amount: vatAmount,
    vat_amount_sek: documentType === 'delivery_note' ? null : vatAmountSek,
    total,
    total_sek: documentType === 'delivery_note' ? null : totalSek,
    // remaining_amount = total - deduction for real invoices so open-invoice
    // queries treat them as fully unpaid for the CUSTOMER's share: the
    // Skatteverket portion is on 1513 and clears when the agency pays out.
    // Proformas / delivery notes have no payment obligation → keep 0.
    remaining_amount: documentType === 'invoice' ? total - deductionTotal : 0,
    vat_treatment: notVatRegistered ? 'exempt' : vatRules.treatment,
    vat_rate: documentType === 'delivery_note' ? 0 : (isMixedRate ? null : (uniqueRates.values().next().value ?? vatRules.rate)),
    moms_ruta: notVatRegistered ? null : vatRules.momsRuta,
    reverse_charge_text: notVatRegistered ? null : (vatRules.reverseChargeText || null),
    your_reference: input.your_reference,
    our_reference: input.our_reference,
    notes: input.notes,
    // Display-only öresavrundning override; null inherits company_settings.ore_rounding.
    ore_rounding: input.ore_rounding ?? null,
    document_type: documentType,
    deduction_total: deductionTotal,
    deduction_personnummer_encrypted: deductionPersonnummerEncrypted,
    deduction_personnummer_last4: deductionPersonnummerLast4,
    // Dimensions PR7: stored as-is; the generators coerce + merge at booking.
    default_dimensions: input.default_dimensions ?? {},
  }

  const itemRows: InvoiceWriteItemRow[] = items.map((item, index) => {
    // Free-text / blank rows carry no amounts and never book: store the
    // description only and zero everything else. Keys must match the product
    // branch exactly so a bulk insert isn't rejected for differing key sets.
    if (item.line_type === 'text') {
      return {
        sort_order: index,
        line_type: 'text',
        description: item.description ?? '',
        quantity: 0,
        unit: '',
        unit_price: 0,
        line_total: 0,
        vat_rate: 0,
        vat_amount: 0,
        article_id: null,
        revenue_account: null,
        deduction_type: null,
        deduction_amount: 0,
        labor_hours: null,
        work_type: null,
        housing_designation: null,
        apartment_number: null,
        brf_org_number: null,
        accrual_period_start: null,
        accrual_period_end: null,
        accrual_balance_account: null,
        dimensions: {},
      }
    }
    const itemRate = item.vat_rate !== undefined ? item.vat_rate : vatRules.rate
    const lineTotal = item.quantity * item.unit_price
    const itemVat = documentType === 'delivery_note' ? 0 : Math.round(lineTotal * itemRate / 100 * 100) / 100
    // ROT/RUT deduction is recomputed server-side so a tampered client can't
    // expand the 1513 receivable beyond the rules. Non-invoice document types
    // never carry deduction_type.
    const deductionType = documentType === 'invoice' ? (item.deduction_type ?? null) : null
    const deductionAmount = deductionType
      ? computeDeduction({
          unit_price: item.unit_price,
          quantity: item.quantity,
          deduction_type: deductionType,
        })
      : 0
    return {
      sort_order: index,
      line_type: 'product',
      description: item.description,
      quantity: item.quantity,
      unit: item.unit,
      unit_price: item.unit_price,
      line_total: lineTotal,
      vat_rate: itemRate,
      vat_amount: itemVat,
      // Article linkage. revenue_account is frozen-copied here so a later
      // article edit never re-books this line; null falls through to the
      // VAT-treatment-derived account in generatePerRateLines().
      article_id: item.article_id ?? null,
      revenue_account: item.revenue_account ?? null,
      deduction_type: deductionType,
      deduction_amount: deductionAmount,
      labor_hours: documentType === 'invoice' ? (item.labor_hours ?? null) : null,
      work_type: documentType === 'invoice' ? (item.work_type ?? null) : null,
      // Property info: per-line value wins, else the invoice-level claim-card
      // value is stamped onto every deduction line so the Skatteverket file
      // generator can read it off the line later. Non-deduction lines carry
      // no property data (privacy by default).
      housing_designation:
        documentType === 'invoice' && deductionType
          ? (item.housing_designation ?? input.deduction_housing_designation?.trim() ?? null) || null
          : null,
      apartment_number:
        documentType === 'invoice' && deductionType
          ? (item.apartment_number ?? input.deduction_apartment_number?.trim() ?? null) || null
          : null,
      brf_org_number:
        documentType === 'invoice' && deductionType
          ? (item.brf_org_number ?? input.deduction_brf_org_number?.trim() ?? null) || null
          : null,
      // Periodisering (förutbetald intäkt): frozen onto the line. The schedule
      // itself is created when the invoice is sent/booked. ROT/RUT lines never
      // defer (schema-enforced); the guard above restricted this to real
      // invoices under faktureringsmetoden.
      accrual_period_start:
        documentType === 'invoice' && !deductionType
          ? (item.accrual_period_start ?? null)
          : null,
      accrual_period_end:
        documentType === 'invoice' && !deductionType
          ? (item.accrual_period_end ?? null)
          : null,
      accrual_balance_account:
        documentType === 'invoice' && !deductionType && item.accrual_period_start && item.accrual_period_end
          ? (item.accrual_balance_account ?? DEFAULT_DEFERRED_REVENUE_ACCOUNT)
          : null,
      dimensions: item.dimensions ?? {},
    }
  })

  return { ok: true, invoiceFields, items: itemRows }
}
