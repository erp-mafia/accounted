import type { SupabaseClient } from '@supabase/supabase-js'
import type { ArticleType, Currency, Customer, DeductionType, InvoiceDocumentType, InvoiceQrMode } from '@/types'
import {
  deriveInvoiceVatHeader,
  explainVatTreatment,
  outsideScopeLineRefusal,
  resolveInvoiceVatRules,
  type InvoiceVatOverride,
  type InvoiceVatTreatmentOverride,
  type InvoiceVatWarning,
} from '@/lib/invoices/vat-rules'
import { isOutsideScopeInvoiceTreatment, isZeroRatedInvoiceTreatment } from '@/lib/bookkeeping/invoice-line-vat-treatment'
import { isInvoiceLinePostingAccount, isZeroVatOnlyPostingAccount } from '@/lib/invoices/posting-account'
import { normalizeCountryCode } from '@/lib/vat/country-codes'
import { normalizeDeliveryAddress, type InvoiceDeliveryAddress } from '@/lib/invoices/delivery-address'
import { computeLineNet, computeLineVat } from '@/lib/bookkeeping/invoice-line-amounts'
import { roundOre } from '@/lib/money'
import { sekOfForeign } from '@/lib/bookkeeping/currency-utils'
import { fetchExchangeRate } from '@/lib/currency/riksbanken'
import {
  isAccruedIncomeAccount,
  pastPeriodDeferralSuggestion,
  periodEndsBeforeInvoiceMonth,
  suggestRevenueBalanceAccount,
} from '@/lib/bookkeeping/accruals/account-suggestions'
import { invoiceMonthOnlyAccrualRows } from '@/lib/bookkeeping/accruals/compute'
import {
  computeInvoiceDeductionTotal,
  computeLineDeductions,
  DEDUCTION_INVOICE_ONLY_ERROR,
  validateInvoice as validateRotRut,
} from '@/lib/bookkeeping/rot-rut-rules'
import {
  encryptPersonnummer,
  expandPersonnummerTo12,
  extractLast4,
  validatePersonnummer,
} from '@/lib/salary/personnummer'
import { revealStoredCustomerPersonalNumber } from '@/lib/customers/protect-personal-number'
import { checkAccountingMethod } from '@/lib/company/accounting-method'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { resolveLineVatTreatment } from '@/lib/bookkeeping/invoice-line-vat-treatment'
import { consumerCreditRefusal } from '@/lib/invoices/consumer-credit'
import {
  accountsWithBookedSales,
  articleTypeCandidateAccount,
  articleTypeHistoryWindow,
  deriveArticleTypeRevenueAccount,
  usableArticleTypeAccounts,
} from '@/lib/invoices/article-type-revenue-account'

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

/**
 * The customer fields the builder reads, every one a REQUIRED key.
 *
 * This used to be the full `Customer` row. No narrow projection can satisfy
 * that, so a door that selected only the columns it thought were needed had to
 * write `customer as unknown as Customer`, and the cast erased the one check
 * that would have caught a missing column. The v1 create and update routes
 * omitted `country` that way (#2783): `undefined` reads as "no country, the
 * rule does not apply" (countryPermitsReverseCharge), so an eu_business
 * established in Sweden got 0 % reverse charge on the public API and 25 %
 * everywhere else.
 *
 * Declaring exactly what is read turns an omitted input into a compile error
 * instead of a silent `undefined`: supabase-js types a literal select() string
 * into a row with those keys, so a narrow projection that drops a column no
 * longer type-checks against this parameter. A full `select('*')` row is still
 * assignable, so those doors are unchanged. A door that deliberately withholds
 * a field says so with an explicit `null`.
 *
 * Keep a narrow door's select() a LITERAL string, not a shared constant: the
 * type already stops an omission, and a literal stays visible to the
 * phantom-column scanner (tests/schema/no-phantom-columns.test.ts), which
 * cannot resolve a select built at runtime.
 *
 *  - customer_type, vat_number_validated, country: decide the VAT treatment
 *  - id, vat_number: explainVatTreatment (which condition failed, remediation)
 *  - personal_number: ROT/RUT fallback to the customer card (individual only)
 *
 * `country` is `string | null` rather than Customer's `string`: legacy rows
 * can carry null, which does not block reverse charge (see
 * countryPermitsReverseCharge). Null is a value; a missing key is a bug.
 */
export type InvoiceBuilderCustomer = Pick<
  Customer,
  'id' | 'customer_type' | 'vat_number' | 'vat_number_validated' | 'personal_number'
> & { country: string | null }

// The validated line shape (a superset of what create/update schemas produce).
export interface InvoiceWriteItemInput {
  line_type?: 'product' | 'text'
  description: string
  quantity: number
  unit: string
  unit_price: number
  /** Percentage discount on the line (0-100). Omitted/null = 0; line_total
   *  and vat_amount are computed NET of it (lib/bookkeeping/invoice-line-amounts.ts). */
  discount_percent?: number | null
  vat_rate?: number
  article_id?: string | null
  revenue_account?: string | null
  /** Kundorder line this invoice line was created from; round-tripped on
   *  edit so the order's derived invoiced quantity never loses a link. */
  sales_order_item_id?: string | null
  deduction_type?: DeductionType | null
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
  /** Quotes only: expiry date. Mirrored into due_date (NOT NULL) for quotes. */
  valid_until?: string | null
  currency: Currency
  your_reference?: string
  our_reference?: string
  /** Fakturamärkning: buyer-required marking, separate from your_reference. */
  invoice_marking?: string
  /**
   * Leveransadress (crm#1547). Omitted leaves the column alone (absent on
   * create, unchanged on a draft edit, and no write before the migration
   * applies); null clears it.
   */
  delivery_address?: InvoiceDeliveryAddress | null
  notes?: string
  /** Optional https payment link (schema-validated). Omitted/empty → null. */
  payment_link_url?: string
  /** Per-invoice opt-out for the automatic Stripe payment link. Omitted → true. */
  payment_link_auto?: boolean
  /** Per-invoice öresavrundning override (display-only). Omitted → null (inherit company setting). */
  ore_rounding?: boolean
  /**
   * Per-invoice QR code choice (lib/invoices/payment-qr.ts). Omitted leaves
   * the column alone (null on create, unchanged on a draft edit); null
   * clears it back to the company's invoice_qr_mode.
   */
  qr_mode?: InvoiceQrMode | null
  deduction_personnummer?: string
  deduction_housing_designation?: string
  /** ROT i bostadsrätt: lägenhetsnummer + föreningens orgnr instead of fastighetsbeteckning. */
  deduction_apartment_number?: string
  deduction_brf_org_number?: string
  /** Dimensions PR7: invoice-level bag applied to every generated journal line. */
  default_dimensions?: Record<string, string>
  /**
   * Per-invoice VAT treatment (#2906), a pair with delivery_country: either
   * key present replaces both (the absent one reads as null); neither
   * present keeps `existingVatOverride` (a draft edit that does not mention
   * them). Validated by resolveInvoiceVatRules.
   */
  vat_treatment?: InvoiceVatTreatmentOverride | null
  /** ISO alpha-2 country the goods are transported to (#2906). */
  delivery_country?: string | null
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
  valid_until: string | null
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
  /** What the invoice stated about its own supply (#2906); null = the customer decided. */
  vat_treatment_override: InvoiceVatTreatmentOverride | null
  delivery_country: string | null
  your_reference: string | null | undefined
  our_reference: string | null | undefined
  invoice_marking: string | null
  /** Present only when the input carried delivery_address (see InvoiceWriteInput.delivery_address). */
  delivery_address?: InvoiceDeliveryAddress | null
  notes: string | null | undefined
  payment_link_url: string | null
  payment_link_auto: boolean
  ore_rounding: boolean | null
  /** Present only when the input carried qr_mode (see InvoiceWriteInput.qr_mode). */
  qr_mode?: InvoiceQrMode | null
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
  /** Copied from the article on every write (crm#1084); null without one. */
  article_number: string | null
  revenue_account: string | null
  sales_order_item_id: string | null
  deduction_type: DeductionType | null
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
  | {
      ok: true
      invoiceFields: InvoiceWriteFields
      items: InvoiceWriteItemRow[]
      /**
       * Non-blocking, structured: why the VAT treatment is what it is when
       * that is not what the customer type suggests (explainVatTreatment).
       * Empty when there is nothing to say. Every write surface forwards
       * these unchanged (dashboard `warnings`, v1 `meta.warnings`, staged
       * `vat_warnings`) instead of composing its own sentence.
       */
      warnings: InvoiceVatWarning[]
    }
  // Domain validation failure: map via errorResponseFromCode(code, { details }).
  | { ok: false; code: string; details?: Record<string, unknown> }
  // Unexpected DB error from an internal lookup: map via errorResponse(dbError).
  | { ok: false; dbError: unknown }

export async function buildInvoiceWriteData(params: {
  supabase: SupabaseClient
  companyId: string
  customer: InvoiceBuilderCustomer
  documentType: InvoiceDocumentType
  input: InvoiceWriteInput
  /**
   * Update path only: the stored encrypted personnummer of the draft being
   * edited. The plaintext is never rehydratable client-side (only _last4 is),
   * so an edit that leaves the field empty keeps these stored values instead
   * of failing ROT/RUT validation or wiping the ciphertext.
   */
  existingPersonnummer?: { encrypted: string; last4: string | null } | null
  /**
   * Update paths only: the draft's stored per-invoice VAT treatment (#2906).
   * An edit that sends neither vat_treatment nor delivery_country keeps it,
   * and it is validated again against the customer as it is now.
   */
  existingVatOverride?: InvoiceVatOverride | null
}): Promise<BuildInvoiceWriteResult> {
  const { supabase, companyId, customer, documentType, input, existingPersonnummer } = params
  const items = input.items

  // VAT registration gate (defense in depth: the invoice form already hides
  // the Moms column when vat_registered is false). A non-momsregistrerad
  // company books no output VAT: zero every line rate so the sale lands as
  // momsfri (treatment 'exempt' → revenue 3004/3100, no 2611). 0% is a valid
  // rate for every customer type, so the allowedRates guard below still passes.
  const { data: vatSettings } = await supabase
    .from('company_settings')
    .select('vat_registered, fiscal_year_start_month')
    .eq('company_id', companyId)
    .maybeSingle()
  const notVatRegistered = vatSettings?.vat_registered === false
  if (notVatRegistered && documentType !== 'delivery_note') {
    for (const item of items) item.vat_rate = 0
  }

  // What the invoice says about its own supply (#2906): a pair, replaced
  // together, kept from the draft when the edit does not mention it.
  // The country is stored as the ISO code the rules read (the request schema
  // already normalises; this covers the doors that feed stored values back).
  const overrideSent = input.vat_treatment !== undefined || input.delivery_country !== undefined
  const statedOverride = overrideSent
    ? { vat_treatment: input.vat_treatment ?? null, delivery_country: input.delivery_country ?? null }
    : params.existingVatOverride
  const vatOverride: InvoiceVatOverride = {
    vat_treatment: statedOverride?.vat_treatment ?? null,
    delivery_country: normalizeCountryCode(statedOverride?.delivery_country),
  }
  const hasVatOverride = vatOverride.vat_treatment !== null || vatOverride.delivery_country !== null
  // A seller outside the VAT register charges no VAT and files no
  // momsdeklaration: export, intra-EU supply and "Swedish VAT" are all
  // statements it cannot make, and every line is momsfri regardless.
  if (hasVatOverride && notVatRegistered) {
    return { ok: false, code: 'INVOICE_VAT_TREATMENT_NOT_VAT_REGISTERED', details: { ...vatOverride } }
  }

  // The one rule decision: the customer's treatment, or the invoice's own
  // when it states one, refused when the stated facts do not support it.
  // Gate on the PERMITTED set, not the picker default. Under huvudregeln
  // (ML 6 kap. 34 §) a service to a foreign business is taxed where the buyer
  // is established, so 0% is the default; but the ML 6 kap. exceptions taxed
  // where the supply is performed (fastighetstjänster, persontransporter,
  // korttidsuthyrning of vehicles, restaurang/catering, admission to cultural
  // and sports events) carry Swedish VAT even to a German or a US company.
  // Refusing every non-zero rate made a Stockholm hotel night or a conference
  // ticket impossible to invoice. The default is still 0% (vatRules.rate is
  // the fallback below), so a Swedish rate only lands here when set explicitly.
  // A goods export or intra-EU supply the invoice states permits 0 % only.
  const resolved = resolveInvoiceVatRules(customer, vatOverride)
  if (!resolved.ok) {
    return { ok: false, code: resolved.code, details: resolved.details }
  }
  const vatRules = resolved.rules
  const allowedRates = new Set(resolved.permittedRates.map((r) => r.rate))
  // No Swedish VAT and no ruta (outside_scope) only for lines that are not a
  // supply: today dröjsmålsränta, so each priced line names its
  // interest-income account.
  if (isOutsideScopeInvoiceTreatment(vatRules.treatment)) {
    const lineRefusal = outsideScopeLineRefusal(items)
    if (lineRefusal) return { ok: false, code: 'INVOICE_VAT_TREATMENT_OUTSIDE_SCOPE_LINE', details: lineRefusal }
  }

  // Periodisering guards. The line schema already validates the period shape;
  // here we gate the flows where deferral has no meaning: cash method
  // (recognition at payment), reverse charge/export (3308/3231/3305 must
  // reflect the full sale for ruta 39/41/40), and non-invoice document types.
  const hasAccrualItems = items.some(
    (item) => item.accrual_period_start && item.accrual_period_end,
  )
  // A skattereduktion exists on a faktura only: a quote, a proforma and a
  // delivery note have no deduction model and store none of its fields.
  // Refused like a periodisering on them, never saved without the claim
  // (#3030): the caller was told nothing and the document had no avdrag.
  // Text rows carry no amounts and drop the flag on every document type.
  if (documentType !== 'invoice' && items.some((item) => item.line_type !== 'text' && item.deduction_type)) {
    return {
      ok: false,
      code: 'INVOICE_CREATE_ROT_RUT_VALIDATION',
      details: { reason: 'document_type', documentType, errors: [DEDUCTION_INVOICE_ONLY_ERROR], warnings: [] },
    }
  }
  if (hasAccrualItems) {
    if (documentType !== 'invoice') {
      return { ok: false, code: 'INVOICE_CREATE_ACCRUAL_INVALID', details: { reason: 'document_type', documentType } }
    }
    if (isZeroRatedInvoiceTreatment(vatRules.treatment) || isOutsideScopeInvoiceTreatment(vatRules.treatment)) {
      return { ok: false, code: 'INVOICE_CREATE_ACCRUAL_INVALID', details: { reason: 'vat_treatment', vatTreatment: vatRules.treatment } }
    }
    // Fail closed (accounted#58): an unreadable method must not let a
    // kontantmetod company defer revenue it books only at payment.
    const method = checkAccountingMethod(
      await supabase
        .from('company_settings')
        .select('accounting_method')
        .eq('company_id', companyId)
        .maybeSingle(),
    )
    if (!method.ok) return { ok: false, code: method.code, details: method.details }
    if (method.accountingMethod !== 'accrual') {
      return { ok: false, code: 'INVOICE_CREATE_ACCRUAL_INVALID', details: { reason: 'accounting_method' } }
    }
    // A period lying only in the invoice month credits 29xx and debits it
    // back in that same month: two verifikat that cancel out. Checked here,
    // where every door's effective invoice date and rows meet (an edit that
    // only moves the date reaches this with the stored rows).
    const invoiceMonthRows = invoiceMonthOnlyAccrualRows(input.invoice_date, items)
    if (invoiceMonthRows.length > 0) {
      return {
        ok: false,
        code: 'INVOICE_CREATE_ACCRUAL_INVOICE_MONTH',
        details: { rows: invoiceMonthRows.map((index) => index + 1), invoiceDate: input.invoice_date },
      }
    }
    // An upplupen intäkt (17xx, #62) is revenue of months before the invoice
    // month. A period that reaches the invoice month is refused, not split:
    // the user splits the line (the invoice month's own revenue is no
    // accrual). Booking checks it again with the date the invoice then has
    // (assertAccruedIncomeLinesBookable).
    const accruedIncomeRows = items.flatMap((item, index) =>
      item.accrual_period_end &&
      isAccruedIncomeAccount(item.accrual_balance_account) &&
      !periodEndsBeforeInvoiceMonth(item.accrual_period_end, input.invoice_date)
        ? [index + 1]
        : [],
    )
    if (accruedIncomeRows.length > 0) {
      return {
        ok: false,
        code: 'INVOICE_ACCRUED_INCOME_PERIOD_INVALID',
        details: { rows: accruedIncomeRows, invoiceDate: input.invoice_date },
      }
    }
    // The opposite (accounted#113): a förutbetald intäkt (29xx) of months
    // that ended before the invoice month would book all of them on the
    // invoice date, so it is refused naming the upplupen account. An omitted
    // account gets that account below instead. Booking checks it again
    // (assertAccruedIncomeLinesBookable).
    const pastDeferrals = items.flatMap((item, index) => {
      if (!item.accrual_period_start || !item.accrual_balance_account) return []
      const suggested = pastPeriodDeferralSuggestion(
        { direction: 'revenue' },
        item.accrual_balance_account,
        item.accrual_period_end,
        input.invoice_date,
      )
      return suggested ? [{ row: index + 1, suggested }] : []
    })
    if (pastDeferrals.length > 0) {
      return {
        ok: false,
        code: 'INVOICE_DEFERRED_INCOME_PERIOD_PAST',
        details: {
          rows: pastDeferrals.map((entry) => entry.row),
          invoiceDate: input.invoice_date,
          suggestedAccount: pastDeferrals[0].suggested,
        },
      }
    }
  }

  // Free-text rows carry no amounts and are excluded from totals + VAT.
  // Line totals are net of any per-line discount (rabatt i procent).
  // Öre-exact header: each line net is already in öre (computeLineNet), and
  // the sums are rounded so float addition cannot leave a total like 999.9999999.
  const subtotal = roundOre(items.reduce(
    (sum, item) =>
      item.line_type === 'text'
        ? sum
        : sum + computeLineNet(item.quantity, item.unit_price, item.discount_percent),
    0,
  ))

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
      // A class 1-2 (balance-sheet) or interest-income (PH 246) posting
      // override is only valid on zero-VAT lines (deposits, advances,
      // outlays, loan amortization, interest). On a VAT-bearing line it
      // would divert the tax base away from a 3xxx account and understate
      // ruta 05 of the momsdeklaration (ML 17 kap 24§).
      if (
        item.revenue_account &&
        isZeroVatOnlyPostingAccount(item.revenue_account) &&
        itemRate > 0
      ) {
        return {
          ok: false,
          code: 'INVOICE_CREATE_POSTING_ACCOUNT_VAT_CONFLICT',
          details: { account: item.revenue_account, vatRate: itemRate },
        }
      }
      const lineTotal = computeLineNet(item.quantity, item.unit_price, item.discount_percent)
      // Same per-line rule as the item rows below (vat_amount), so the
      // header always equals the sum of its lines.
      vatAmount = roundOre(vatAmount + computeLineVat(lineTotal, itemRate))
    }
  }
  const total = documentType === 'delivery_note' ? 0 : roundOre(subtotal + vatAmount)

  // Konsumentkreditlag (2026:1011): an invoice to a consumer stays a särskild
  // fakturakredit only without an invoice fee and due within 50 days of
  // delivery. Checked here so every door that writes an invoice answers alike.
  const creditRefusal = consumerCreditRefusal({
    customerType: customer.customer_type,
    documentType,
    invoiceDate: input.invoice_date,
    dueDate: input.due_date,
    deliveryDate: input.delivery_date,
    total,
    items,
  })
  if (creditRefusal) return { ok: false, code: creditRefusal.code, details: creditRefusal.details }

  // Validate any per-line posting-account override against the company's chart
  // of accounts. The legacy field name is revenue_account, but balance-sheet
  // accounts are valid for deposits, customer advances, and genuine outlays.
  // Zod already constrains the shape to classes 1-3 plus interest income
  // (PH 246); here we confirm each is a real, active account so a typo or unsuitable account
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
      .eq('is_active', true)
      .in('account_number', overrideAccounts)

    if (accountsError) {
      return { ok: false, dbError: accountsError }
    }
    // Class 1-3 or interest income (isInvoiceLinePostingAccount): the line
    // rule, checked here too for the doors that skip the item Zod schema.
    const validSet = new Set(
      (validAccounts ?? [])
        .map((a) => a.account_number as string)
        .filter(isInvoiceLinePostingAccount),
    )
    const invalid = overrideAccounts.filter((a) => !validSet.has(a))
    if (invalid.length > 0) {
      return { ok: false, code: 'INVOICE_CREATE_REVENUE_ACCOUNT_INVALID', details: { invalidAccounts: invalid } }
    }
  }

  // Article linkage is a tenancy invariant: the FK on invoice_items.article_id
  // proves the article EXISTS, not that it belongs to THIS company. FK
  // validation is internal to Postgres and ignores RLS, and the v1 routes run
  // on the service-role client with no RLS at all, so a body carrying another
  // company's article UUID would otherwise persist a cross-tenant reference.
  // Every invoice write path converges here (cookie POST/PATCH, v1 POST/PATCH,
  // webshop, sales-order conversion, MCP create and update), so one scoped
  // select covers them all. The MCP update executor keeps its own pre-check
  // as well. Text rows never persist an article (mapped to null below).
  // The same read gives each line its article number, copied onto the line
  // (crm#1084) so the invoice prints the number it was written with.
  const articleNumbers = new Map<string, string | null>()
  // The article's type and whether it still derives its account ("Härleds
  // automatiskt"), for the tjänst/vara account below (crm#1661).
  const articleDerivation = new Map<string, { type: ArticleType | null; derives: boolean }>()
  const articleIds = Array.from(
    new Set(
      items
        .filter((item) => item.line_type !== 'text')
        .map((item) => item.article_id)
        .filter((a): a is string => !!a),
    ),
  )
  if (articleIds.length > 0) {
    const { data: articleRows, error: articlesError } = await supabase
      .from('articles')
      .select('id, article_number, type, revenue_account')
      .eq('company_id', companyId)
      .in('id', articleIds)

    if (articlesError) {
      return { ok: false, dbError: articlesError }
    }
    for (const row of (articleRows ?? []) as Array<{
      id: string
      article_number: string | null
      type?: ArticleType | null
      revenue_account?: string | null
    }>) {
      articleNumbers.set(row.id, row.article_number?.trim() || null)
      articleDerivation.set(row.id, { type: row.type ?? null, derives: !row.revenue_account })
    }
    const foundArticleIds = new Set((articleRows ?? []).map((a) => a.id))
    const invalidArticleIds = articleIds.filter((a) => !foundArticleIds.has(a))
    if (invalidArticleIds.length > 0) {
      return { ok: false, code: 'INVOICE_CREATE_ARTICLE_INVALID', details: { invalidArticleIds } }
    }
  }

  // ROT/RUT-avdrag: validate prerequisites and compute the per-item +
  // invoice-level deduction. Computed server-side (never trusted from the
  // client) so a tampered request can't expand the 1513 receivable. Only on
  // an invoice: proformas, delivery notes and quotes don't post journal
  // entries and have no deduction model (a claim on them is refused above).
  let deductionTotal = 0
  // Per line, aligned with `items`: what each deduction row stores and books.
  let lineDeductions: number[] = []
  let deductionPersonnummerEncrypted: string | null = null
  let deductionPersonnummerLast4: string | null = null
  if (documentType === 'invoice') {
    // Housing info satisfies the ROT and grön teknik requirement in either of
    // two shapes (Begaran.xsd V6 and V1): fastighetsbeteckning
    // (småhus/ägarlägenhet) OR lägenhetsnummer + bostadsrättsföreningens
    // orgnr (bostadsrätt).
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
    // SEK: whole kronor per claim, the amount Skatteverket pays (see
    // computeLineDeductions), so "Att betala" and the 1510 share agree.
    deductionTotal = computeInvoiceDeductionTotal(validateInput, { currency: input.currency })
    lineDeductions = computeLineDeductions(validateInput, { currency: input.currency })
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

  // Header treatment, ruta and statutory notice: the same derivation that
  // re-derives an open draft when its customer changes (see
  // deriveInvoiceVatHeader for the mixed-rate and Swedish-rate rules).
  const vatHeader = deriveInvoiceVatHeader(vatRules, [...uniqueRates], {
    vatRegistered: !notVatRegistered,
  })

  // "Härleds automatiskt" by article type (crm#1661), following the
  // company's own practice: a line takes its tjänst/vara account (3041-3053)
  // only when the account is active, the momsdeklaration counts it at the
  // line's rate, and the company credited it in this or the previous
  // räkenskapsår. At most two reads per invoice (the chart, then the
  // history), for exactly the accounts its lines ask for, and none when no
  // line's article derives a type account; see
  // article-type-revenue-account.ts for the rule.
  const lineTreatment = (item: (typeof items)[number]) =>
    resolveLineVatTreatment(item.vat_rate !== undefined ? item.vat_rate : vatRules.rate, vatHeader.vat_treatment)
  const lineArticle = (item: (typeof items)[number]) =>
    item.article_id ? (articleDerivation.get(item.article_id) ?? null) : null
  const typeAccountCandidates = new Set<string>()
  for (const item of items) {
    if (item.line_type === 'text') continue
    const candidate = articleTypeCandidateAccount({
      requested: item.revenue_account ?? null,
      treatment: lineTreatment(item),
      article: lineArticle(item),
    })
    if (candidate) typeAccountCandidates.add(candidate)
  }
  let usableTypeAccounts: Set<string> = new Set()
  const historyWindow = articleTypeHistoryWindow(input.invoice_date, vatSettings?.fiscal_year_start_month)
  if (typeAccountCandidates.size > 0 && historyWindow) {
    const { data: typeAccountRows, error: typeAccountsError } = await supabase
      .from('chart_of_accounts')
      .select('account_number, account_name, account_class, default_vat_rate, default_vat_treatment')
      .eq('company_id', companyId)
      .eq('is_active', true)
      .in('account_number', [...typeAccountCandidates])

    if (typeAccountsError) {
      return { ok: false, dbError: typeAccountsError }
    }
    const inChart = [...usableArticleTypeAccounts(typeAccountRows ?? [])]
    if (inChart.length > 0) {
      // The posted ledger's per-day sums (ledger_account_days, complete for
      // every company: a company not built yet reads as no history and keeps
      // the default). A few rows per account and day, never journal lines.
      let historyRows: Array<{ account_number: string; credit: number | string | null }>
      try {
        historyRows = await fetchAllRows<{ account_number: string; credit: number | string | null }>(({ from, to }) =>
          supabase
            .from('ledger_account_days')
            .select('account_number, credit')
            .eq('company_id', companyId)
            .in('account_number', inChart)
            .gte('entry_date', historyWindow.from)
            .lte('entry_date', historyWindow.to)
            .gt('credit', 0)
            .order('account_number', { ascending: true })
            .order('fiscal_period_id', { ascending: true })
            .order('entry_date', { ascending: true })
            .order('slot', { ascending: true })
            .range(from, to),
        )
      } catch (historyError) {
        return { ok: false, dbError: historyError }
      }
      usableTypeAccounts = accountsWithBookedSales(historyRows)
    }
  }

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
      subtotalSek = sekOfForeign(subtotal, exchangeRate)
      vatAmountSek = sekOfForeign(vatAmount, exchangeRate)
      totalSek = sekOfForeign(total, exchangeRate)
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

  // A quote has no due date, only an expiry. due_date is NOT NULL on the
  // table and every date-ordered reader sorts on it, so it mirrors
  // valid_until; valid_until stays the authoritative column.
  const validUntil = documentType === 'quote' ? (input.valid_until ?? input.due_date) : null

  const invoiceFields: InvoiceWriteFields = {
    customer_id: input.customer_id,
    invoice_date: input.invoice_date,
    due_date: validUntil ?? input.due_date,
    delivery_date: input.delivery_date ?? null,
    valid_until: validUntil,
    // quote_status is deliberately NOT a builder output: this object is
    // spread into both inserts and draft updates, and a recorded accept or
    // decline must never be overwritten by an edit. New quotes start open via
    // the invoices_quote_defaults trigger (20260902221000); decisions are
    // written only by the quote-status routes and the converter.
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
    // Proformas / delivery notes / quotes have no payment obligation → keep 0.
    remaining_amount: documentType === 'invoice' ? roundOre(total - deductionTotal) : 0,
    vat_treatment: vatHeader.vat_treatment,
    vat_rate: documentType === 'delivery_note' ? 0 : (isMixedRate ? null : (uniqueRates.values().next().value ?? vatRules.rate)),
    moms_ruta: vatHeader.moms_ruta,
    reverse_charge_text: vatHeader.reverse_charge_text,
    // Stored so a draft edit and a customer change re-decide the header from
    // the same statement (sync-draft-vat-headers), and so booking knows the
    // goods went abroad (3105 / 3108, not 3305 / 3308).
    vat_treatment_override: vatOverride.vat_treatment,
    delivery_country: vatOverride.delivery_country,
    your_reference: input.your_reference,
    our_reference: input.our_reference,
    // Always a concrete value so a draft edit that cleared the field NULLs
    // the column (supabase-js drops undefined keys).
    invoice_marking: input.invoice_marking?.trim() || null,
    // Only when sent, like qr_mode: a rebuild that does not mention it keeps
    // the stored address, and the column is never named before it exists.
    ...(input.delivery_address !== undefined ? { delivery_address: normalizeDeliveryAddress(input.delivery_address) } : {}),
    notes: input.notes,
    // Always a concrete value (never undefined) so a draft edit that cleared
    // the field actually NULLs the column: supabase-js drops undefined keys.
    payment_link_url: input.payment_link_url?.trim() || null,
    // Automation opt-out for the Stripe payment link; default on. The form
    // always sends the field, so a draft edit that unticked it persists false.
    payment_link_auto: input.payment_link_auto ?? true,
    // Display-only öresavrundning override; null inherits company_settings.ore_rounding.
    ore_rounding: input.ore_rounding ?? null,
    // Only when sent: every rebuild path (v1 PATCH, the update_invoice
    // executor) feeds the stored header back field by field, and an absent
    // key must not clear a draft's QR choice.
    ...(input.qr_mode !== undefined ? { qr_mode: input.qr_mode } : {}),
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
        article_number: null,
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
    const itemVat = documentType === 'delivery_note' ? 0 : computeLineVat(lineTotal, itemRate)
    // ROT/RUT deduction is recomputed server-side so a tampered client can't
    // expand the 1513 receivable beyond the rules. Non-invoice document types
    // never carry deduction_type. The amounts come from the same
    // computeLineDeductions call as deduction_total, so the header and the
    // rows (and the 1513 lines booked from them) can never disagree.
    const deductionType = documentType === 'invoice' ? (item.deduction_type ?? null) : null
    const deductionAmount = deductionType ? (lineDeductions[index] ?? 0) : 0
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
      // Frozen like revenue_account: renumbering or deleting the article
      // later never changes what this line prints.
      article_number: item.article_id ? (articleNumbers.get(item.article_id) ?? null) : null,
      // An article that derives its account books the company's tjänst/vara
      // account for this rate when it keeps and uses one (crm#1661), else null.
      revenue_account: deriveArticleTypeRevenueAccount({
        requested: item.revenue_account ?? null,
        treatment: lineTreatment(item),
        article: lineArticle(item),
        usable: usableTypeAccounts,
      }),
      // Only a faktura consumes kundorder quantity: a quote or proforma line
      // linked to an order item would mark the order invoiced without any
      // invoice existing (sales_order_invoiced_quantities counts by status).
      sales_order_item_id: documentType === 'invoice' ? (item.sales_order_item_id ?? null) : null,
      deduction_type: deductionType,
      deduction_amount: deductionAmount,
      labor_hours: documentType === 'invoice' ? (item.labor_hours ?? null) : null,
      // Trimmed: the rate and the claim read the code trimmed, so the stored
      // code (printed on the PDF, sent to Skatteverket) must be the same.
      work_type: documentType === 'invoice' ? (item.work_type?.trim() || null) : null,
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
      // Periodisering (förutbetald intäkt 29xx, upplupen intäkt 17xx): frozen
      // onto the line; an omitted account takes the form's suggestion (1790
      // for months before the invoice month, else 2970). The schedule itself
      // is created when the invoice is sent/booked. ROT/RUT lines never defer (schema-enforced); the guard
      // above restricted this to real invoices under faktureringsmetoden.
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
          ? (item.accrual_balance_account ??
            suggestRevenueBalanceAccount(item.accrual_period_end, input.invoice_date))
          : null,
      dimensions: item.dimensions ?? {},
    }
  })

  // Why the treatment is what it is (#2749, #2558). Read off the stored item
  // rows so the rates the warning names are the rates the invoice carries.
  // A non-momsregistrerad seller charges no VAT (every rate was zeroed above)
  // and a delivery note carries none, so neither has anything to explain.
  // An invoice that states its own treatment (Swedish VAT, or goods with a
  // destination) is not described by the customer-based sentence.
  const warnings =
    notVatRegistered || documentType === 'delivery_note' || !resolved.explainFromCustomer
      ? []
      : explainVatTreatment(
          customer,
          itemRows.filter((row) => row.line_type !== 'text').map((row) => row.vat_rate),
        )

  return { ok: true, invoiceFields, items: itemRows, warnings }
}
