import type { SupabaseClient } from '@supabase/supabase-js'
import type { Currency, Customer, InvoiceDocumentType } from '@/types'
import { getVatRules, getPermittedVatRates } from '@/lib/invoices/vat-rules'
import { isBalanceSheetAccount } from '@/lib/invoices/posting-account'
import { computeLineNet } from '@/lib/invoices/line-amounts'
import { fetchExchangeRate, convertToSEK } from '@/lib/currency/riksbanken'
import { DEFAULT_DEFERRED_REVENUE_ACCOUNT } from '@/lib/bookkeeping/accruals/account-suggestions'
import {
  computeDeduction,
  computeInvoiceDeductionTotal,
  validateInvoice as validateRotRut,
} from '@/lib/invoices/rot-rut-rules'
import {
  encryptPersonnummer,
  expandPersonnummerTo12,
  extractLast4,
  validatePersonnummer,
} from '@/lib/salary/personnummer'
import { revealStoredCustomerPersonalNumber } from '@/lib/customers/protect-personal-number'

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
  /** Percentage discount on the line (0-100). Omitted/null = 0; line_total
   *  and vat_amount are computed NET of it (lib/invoices/line-amounts.ts). */
  discount_percent?: number | null
  vat_rate?: number
  article_id?: string | null
  revenue_account?: string | null
  /** Kundorder line this invoice line was created from; round-tripped on
   *  edit so the order's derived invoiced quantity never loses a link. */
  sales_order_item_id?: string | null
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
  /** Fakturamärkning: buyer-required marking, separate from your_reference. */
  invoice_marking?: string
  notes?: string
  /** Optional https payment link (schema-validated). Omitted/empty → null. */
  payment_link_url?: string
  /** Per-invoice opt-out for the automatic Stripe payment link. Omitted → true. */
  payment_link_auto?: boolean
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
  invoice_marking: string | null
  notes: string | null | undefined
  payment_link_url: string | null
  payment_link_auto: boolean
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
  discount_percent: number
  line_total: number
  vat_rate: number
  vat_amount: number
  article_id: string | null
  revenue_account: string | null
  sales_order_item_id: string | null
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
  /**
   * Update path only: the stored encrypted personnummer of the draft being
   * edited. The plaintext is never rehydratable client-side (only _last4 is),
   * so an edit that leaves the field empty keeps these stored values instead
   * of failing ROT/RUT validation or wiping the ciphertext.
   */
  existingPersonnummer?: { encrypted: string; last4: string | null } | null
}): Promise<BuildInvoiceWriteResult> {
  const { supabase, companyId, customer, documentType, input, existingPersonnummer } = params
  const items = input.items

  const vatRules = getVatRules(customer.customer_type, customer.vat_number_validated)
  // Gate on the PERMITTED set, not the picker default. Under huvudregeln
  // (ML 6 kap. 34 §) a service to a foreign business is taxed where the buyer
  // is established, so 0% is the default; but the ML 6 kap. exceptions taxed
  // where the supply is performed (fastighetstjänster, persontransporter,
  // korttidsuthyrning of vehicles, restaurang/catering, admission to cultural
  // and sports events) carry Swedish VAT even to a German or a US company.
  // Refusing every non-zero rate made a Stockholm hotel night or a conference
  // ticket impossible to invoice. The default is still 0% (vatRules.rate is
  // the fallback below), so a Swedish rate only lands here when set explicitly.
  const permittedRates = getPermittedVatRates(customer.customer_type, customer.vat_number_validated)
  const allowedRates = new Set(permittedRates.map((r) => r.rate))

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
  // Line totals are net of any per-line discount (rabatt i procent).
  const subtotal = items.reduce(
    (sum, item) =>
      item.line_type === 'text'
        ? sum
        : sum + computeLineNet(item.quantity, item.unit_price, item.discount_percent),
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
      // A class 1-2 (balance-sheet) posting override is only valid on
      // zero-VAT lines (deposits, advances, outlays). On a VAT-bearing line
      // it would divert the tax base away from a 3xxx account and understate
      // ruta 05 of the momsdeklaration (ML 17 kap 24§).
      if (
        item.revenue_account &&
        isBalanceSheetAccount(item.revenue_account) &&
        itemRate > 0
      ) {
        return {
          ok: false,
          code: 'INVOICE_CREATE_POSTING_ACCOUNT_VAT_CONFLICT',
          details: { account: item.revenue_account, vatRate: itemRate },
        }
      }
      const lineTotal = computeLineNet(item.quantity, item.unit_price, item.discount_percent)
      vatAmount += Math.round(lineTotal * itemRate / 100 * 100) / 100
    }
  }
  const total = documentType === 'delivery_note' ? 0 : subtotal + vatAmount

  // Validate any per-line posting-account override against the company's chart
  // of accounts. The legacy field name is revenue_account, but balance-sheet
  // accounts are valid for deposits, customer advances, and genuine outlays.
  // Zod already constrains the shape to classes 1-3; here we
  // confirm each is a real, active account so a typo or unsuitable account
  // can never be booked. Never trust the client.
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
      .gte('account_class', 1)
      .lte('account_class', 3)
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

    const validateInput = items.map((item) => ({
      unit_price: item.unit_price,
      quantity: item.quantity,
      discount_percent: item.discount_percent ?? 0,
      deduction_type: item.deduction_type ?? null,
      // The deduction base is arbetskostnaden inkl. moms (HUSFL 6-9 §§), so
      // the validator and total need the same per-line rate the item rows
      // below are stored with.
      vat_rate: item.vat_rate !== undefined ? item.vat_rate : vatRules.rate,
      labor_hours: item.labor_hours ?? null,
      work_type: item.work_type ?? null,
      housing_designation: item.housing_designation ?? null,
    }))

    // Editing a draft: the stored personnummer only exists as ciphertext, so
    // the client cannot resend it. An empty field on an invoice that still has
    // deduction lines means "keep the stored one", not "remove it".
    const hasDeductionItems = validateInput.some((item) => item.deduction_type != null)
    const keepStoredPersonnummer =
      personnummerRaw.length === 0 && hasDeductionItems && !!existingPersonnummer
    // Neither typed nor stored on the draft: fall back to the personnummer on
    // the customer card (kundkortet). It lives on customers.personal_number as
    // ciphertext (or a legacy plaintext row) in 10- or 12-digit form; the
    // Skatteverket claim needs 12 digits, so expand and Luhn-validate before
    // counting it as provided. Anything unreadable, inexpandable or invalid is
    // treated as absent: the validator below then asks the user to type one,
    // which beats surfacing an "invalid personnummer" error for a value they
    // never entered.
    // Individual-only: ROT/RUT is a privatperson deduction (HUSFL), and
    // customers.personal_number is individual-only in the Zod schemas but not
    // in the DB, so a stray value on a business row (legacy import, direct
    // write) must never be claimed on implicitly. A typed personnummer is
    // unaffected: the user is stating it explicitly.
    let customerCardPersonnummer: string | null = null
    if (
      personnummerRaw.length === 0 &&
      hasDeductionItems &&
      !keepStoredPersonnummer &&
      customer.customer_type === 'individual'
    ) {
      try {
        const revealed = revealStoredCustomerPersonalNumber(customer.personal_number)
        const expanded = revealed ? expandPersonnummerTo12(revealed) : null
        if (expanded && validatePersonnummer(expanded).valid) {
          customerCardPersonnummer = expanded
        }
      } catch {
        // Undecryptable customer value: same as absent.
      }
    }
    const personnummerProvided =
      personnummerRaw.length > 0 || keepStoredPersonnummer || customerCardPersonnummer !== null
    // The invoice currency decides whether the item amounts can be compared
    // against the kronor ceilings at all. The booking rate is fetched further
    // down (the write needs the invoice totals first), so a foreign-currency
    // invoice reports "cap could not be checked" instead of measuring a
    // foreign figure against 50 000 kr.
    const validation = validateRotRut(validateInput, personnummerProvided, housingProvided, {
      currency: input.currency,
    })
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
    if (keepStoredPersonnummer && existingPersonnummer) {
      deductionPersonnummerEncrypted = existingPersonnummer.encrypted
      deductionPersonnummerLast4 = existingPersonnummer.last4
    } else if (personnummerRaw.length > 0) {
      const pnValid = validatePersonnummer(personnummerRaw)
      if (!pnValid.valid) {
        return { ok: false, code: 'INVOICE_CREATE_ROT_RUT_PERSONNUMMER_INVALID', details: { error: pnValid.error } }
      }
      deductionPersonnummerEncrypted = encryptPersonnummer(personnummerRaw)
      deductionPersonnummerLast4 = extractLast4(personnummerRaw)
    } else if (customerCardPersonnummer) {
      // Already expanded to 12 digits and Luhn-validated above.
      deductionPersonnummerEncrypted = encryptPersonnummer(customerCardPersonnummer)
      deductionPersonnummerLast4 = extractLast4(customerCardPersonnummer)
    }
  }

  const uniqueRates = new Set(
    items
      .filter((item) => item.line_type !== 'text')
      .map((item) => item.vat_rate ?? vatRules.rate),
  )
  const isMixedRate = uniqueRates.size > 1

  // Reverse-charge / export notation must describe what the invoice actually
  // does. With a taxed-where-performed line now permitted (see the gate above),
  // an invoice to a foreign business can carry only Swedish VAT: that supply is
  // neither reverse-charged nor exported, so the header must not claim it is.
  // "Omvänd betalningsskyldighet" (ML 17 kap 24 § p.11) next to charged Swedish
  // VAT is a false statement: it tells the buyer to self-assess tax the seller
  // already collected, and the buyer then cannot deduct it either.
  //
  // A mixed invoice (0% consulting + 12% hotel) keeps the notation: its
  // zero-rated lines genuinely ARE reverse-charged, and the notation is
  // required whenever the buyer is liable for any part. The per-rate booking
  // splits them correctly on its own (generatePerRateLines only applies the
  // invoice-level treatment to rate-0 lines), so 3308 and 3002/2621 both land
  // in the right ruta.
  const isSpecialTreatment =
    vatRules.treatment === 'reverse_charge' || vatRules.treatment === 'export'
  // No priced lines at all (text-only document) charges nothing either way:
  // keep the customer's treatment rather than restamping it as domestic.
  const hasZeroRatedLine = uniqueRates.size === 0 || uniqueRates.has(0)
  const headerRules =
    !isSpecialTreatment || hasZeroRatedLine ? vatRules : getVatRules('swedish_business')

  let exchangeRate: number | null = null
  let exchangeRateDate: string | null = null
  let subtotalSek: number | null = null
  let vatAmountSek: number | null = null
  let totalSek: number | null = null

  if (input.currency !== 'SEK') {
    // Rate date = the taxable event, not "today". ML 8 kap 21-23 §: the rate
    // to use is the one "at time of taxable event (delivery/supply date or
    // advance payment date, not invoice date unless same)". delivery_date is
    // exactly that date when it is set (ML 17 kap 24 § p.7 requires it on the
    // invoice whenever it differs from the invoice date); otherwise the two
    // coincide and invoice_date is the taxable event. Stamping today's rate on
    // a back-dated invoice booked the receivable (1510) and the output VAT
    // (2611) at the wrong SEK value.
    //
    // `supabase` is passed so the shared exchange_rates cache is consulted on
    // BOTH legs: the read-through before calling Riksbanken, and the
    // last-cached-observation fallback when Riksbanken 429s. Without it a
    // single transient rate limit left the invoice with a permanently NULL
    // exchange_rate, which resolveSekAmount() then books 1:1 as if the foreign
    // amount were kronor. The transaction ingest path has always passed it.
    const rateDate = input.delivery_date || input.invoice_date
    const rateData = await fetchExchangeRate(input.currency, new Date(rateDate), supabase)
    if (rateData) {
      exchangeRate = rateData.rate
      exchangeRateDate = rateData.date
      subtotalSek = convertToSEK(subtotal, exchangeRate)
      vatAmountSek = convertToSEK(vatAmount, exchangeRate)
      totalSek = convertToSEK(total, exchangeRate)
    }
  } else {
    // SEK invoice: the *_sek twins equal their invoice-currency counterparts
    // (rate 1) instead of staying NULL. The staged-operations commit path
    // (lib/pending-operations/commit.ts, sekRate = 1) already writes them this
    // way, and leaving them NULL here made the same invoice row differ by
    // creation path, blanking SEK-reporting readers (KPI, AR ledger, full
    // archive export). A failed Riksbanken fetch on a foreign-currency
    // invoice still stores NULL above: that is a genuinely unknown value.
    subtotalSek = Math.round(subtotal * 100) / 100
    vatAmountSek = Math.round(vatAmount * 100) / 100
    totalSek = Math.round(total * 100) / 100
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
    vat_treatment: notVatRegistered ? 'exempt' : headerRules.treatment,
    vat_rate: documentType === 'delivery_note' ? 0 : (isMixedRate ? null : (uniqueRates.values().next().value ?? vatRules.rate)),
    moms_ruta: notVatRegistered ? null : headerRules.momsRuta,
    reverse_charge_text: notVatRegistered ? null : (headerRules.reverseChargeText || null),
    your_reference: input.your_reference,
    our_reference: input.our_reference,
    // Always a concrete value so a draft edit that cleared the field NULLs
    // the column (supabase-js drops undefined keys).
    invoice_marking: input.invoice_marking?.trim() || null,
    notes: input.notes,
    // Always a concrete value (never undefined) so a draft edit that cleared
    // the field actually NULLs the column: supabase-js drops undefined keys.
    payment_link_url: input.payment_link_url?.trim() || null,
    // Automation opt-out for the Stripe payment link; default on. The form
    // always sends the field, so a draft edit that unticked it persists false.
    payment_link_auto: input.payment_link_auto ?? true,
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
        discount_percent: 0,
        line_total: 0,
        vat_rate: 0,
        vat_amount: 0,
        article_id: null,
        revenue_account: null,
        sales_order_item_id: null,
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
    const discountPercent = item.discount_percent ?? 0
    const lineTotal = computeLineNet(item.quantity, item.unit_price, discountPercent)
    const itemVat = documentType === 'delivery_note' ? 0 : Math.round(lineTotal * itemRate / 100 * 100) / 100
    // ROT/RUT deduction is recomputed server-side so a tampered client can't
    // expand the 1513 receivable beyond the rules. Non-invoice document types
    // never carry deduction_type.
    const deductionType = documentType === 'invoice' ? (item.deduction_type ?? null) : null
    const deductionAmount = deductionType
      ? computeDeduction({
          unit_price: item.unit_price,
          quantity: item.quantity,
          discount_percent: discountPercent,
          deduction_type: deductionType,
          vat_rate: itemRate,
        })
      : 0
    return {
      sort_order: index,
      line_type: 'product',
      description: item.description,
      quantity: item.quantity,
      unit: item.unit,
      unit_price: item.unit_price,
      discount_percent: discountPercent,
      line_total: lineTotal,
      vat_rate: itemRate,
      vat_amount: itemVat,
      // Article linkage. revenue_account is frozen-copied here so a later
      // article edit never re-books this line; null falls through to the
      // VAT-treatment-derived account in generatePerRateLines().
      article_id: item.article_id ?? null,
      revenue_account: item.revenue_account ?? null,
      sales_order_item_id: item.sales_order_item_id ?? null,
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
