import { z } from 'zod'
import { normaliseSwish, isValidSwish } from '@/lib/payments/swish'
import { normalizeVatNumber } from '@/lib/vat/vat-number'
import { ACCOUNT_VAT_TREATMENTS } from '@/lib/vat/account-vat-treatment'
import {
  accountNumberSchema,
  isoDateSchema,
  saneIsoDateSchema,
  fiscalYearSchema,
} from '@/lib/invariants/zod'
import { ISO_DATE_RE, ISO_DATE_MESSAGE_SV } from '@/lib/invariants/iso-date'
import { countCalendarMonths } from '@/lib/bookkeeping/accruals/compute'
import { DimensionsBagSchema } from '@/lib/bookkeeping/dimension-resolver'
import { validateEmployeeBankAccount } from '@/lib/salary/payment/bank-account'
import { validateJamkning } from '@/lib/salary/jamkning-rules'
import { MAX_INVOICE_EMAIL_COPY_RECIPIENTS } from '@/lib/invoices/email-recipients'
import { INVOICE_POSTING_ACCOUNT_REGEX } from '@/lib/invoices/posting-account'
import { computeLineNet } from '@/lib/invoices/line-amounts'
import {
  DEDUCTION_LINE_ERRORS,
  HOUSEWORK_TYPE_VALUES,
  SCHABLON_WORK_TYPES,
  deductionTypeForWorkType,
  normalizeHouseworkType,
} from '@/lib/invoices/rot-rut-rules'
import { NON_IBAN_CURRENCIES } from '@/lib/invoices/payment-accounts'
import { PERSONAL_NUMBER_INPUT_RE } from '@/lib/customers/mask-personal-number'
import {
  COUNTRY_CONSISTENCY_MESSAGES,
  checkCountryConsistency,
  defaultCountryForParty,
  normalizeCountryCode,
} from '@/lib/vat/country-codes'
import {
  looksLikeSwedishPersonalNumber,
  normalizeReroutedPersonalNumber,
  orgNumberHoldsPersonalNumber,
  personalNumberDigits,
} from '@/lib/customers/personal-number-shape'
import type { AuditAction, Currency, InvoiceDocumentType } from '@/types'
import type { BankFileFormatId } from '@/lib/import/bank-file/types'

// ============================================================
// Shared primitives
// ============================================================

/** UUID v4 string */
const uuid = z.string().uuid()

/**
 * ISO date string (YYYY-MM-DD).
 *
 * Shape only. From `lib/invariants/iso-date.ts` so that every schema below, the
 * v1 routes, and the MCP surface reject a malformed date the same way.
 */
const isoDate = isoDateSchema

/**
 * ISO date that must also be a real, in-range calendar date: not just the
 * right shape. Backed by the shared `isSaneDateString` rule (also used by the
 * transaction form) so a 6-digit year or impossible date can't slip through
 * for user-entered dates. Use this over `isoDate` for free-text date input.
 */
const saneIsoDate = saneIsoDateSchema

/** BAS account number: always a string of 4 digits */
const accountNumber = accountNumberSchema

/** Non-negative monetary amount (>= 0) */
const nonNegativeAmount = z.number().nonnegative()

/**
 * SEK per one unit of a foreign currency.
 *
 * Mirrors the database CHECK that every table storing a rate carries:
 * `invoices_exchange_rate_check`, `supplier_invoices_exchange_rate_check`,
 * `invoice_payments_payment_exchange_rate_check` and
 * `supplier_invoice_payments_payment_exchange_rate_check` all read
 * `rate IS NULL OR (rate > 0 AND rate < 100000)`. BOTH bounds are exclusive,
 * so this mirror is `.positive()` + `.lt(100000)`; `.max(100000)` would let
 * exactly 100000 through the schema and straight into a 23514 violation.
 *
 * Without the mirror a plausible fat-fingered rate (250000, a pasted total
 * instead of a rate) passed validation, hit the constraint in Postgres, and
 * surfaced as an unexplained 500. Through this primitive it lands in
 * `validateBody`'s 400 with a message naming the field and the fix.
 *
 * The ceiling is a typo guard rather than a precise band: no currency the app
 * supports comes near it (USD ~10.5, EUR ~11.5, GBP ~13.5).
 */
const exchangeRate = z
  .number()
  .positive('Växelkursen måste vara större än 0')
  .lt(
    100000,
    'Växelkursen måste vara mindre än 100 000. Ange kursen per 1 enhet av valutan, till exempel 11,45 för EUR, inte fakturans belopp.',
  )

const invoiceEmailAddress = z
  .string()
  .trim()
  .email('Ange en giltig e-postadress')
  .max(254, 'E-postadressen får vara max 254 tecken')

const invoiceEmailAddressList = z
  .array(invoiceEmailAddress)
  .max(
    MAX_INVOICE_EMAIL_COPY_RECIPIENTS,
    `Högst ${MAX_INVOICE_EMAIL_COPY_RECIPIENTS} kopiemottagare är tillåtna`,
  )

/** Invoice-line posting account: an asset, liability/equity, or revenue account. */
const invoicePostingAccount = z
  .string()
  .regex(INVOICE_POSTING_ACCOUNT_REGEX, 'Posting account must be a 4-digit BAS class 1-3 account')

/** Swedish VAT rate as an integer percent. */
const vatRatePercent = z.union([z.literal(0), z.literal(6), z.literal(12), z.literal(25)])

/**
 * Swedish VAT rate as a decimal fraction: the supplier-invoice convention.
 * supplier_invoice_items stores 0.25 for 25 % (DB default 0.25) while
 * invoice_items stores integer percent (vatRatePercent above); issue #310.
 * Only statutory rates pass; percent-shaped input (25) is rejected with a
 * unit hint instead of silently booking 2500 % VAT.
 */
const vatRateDecimal = z.union(
  [z.literal(0), z.literal(0.06), z.literal(0.12), z.literal(0.25)],
  { error: 'vat_rate is a decimal fraction: 0, 0.06, 0.12 or 0.25 (not percent)' },
)

/** Time string (HH:MM or HH:MM:SS) */
const timeString = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Expected HH:MM or HH:MM:SS time format')

/** Periodisering: interim accounts. Förutbetalda kostnader live on 17xx. */
const prepaidExpenseAccount = z
  .string()
  .regex(/^17\d{2}$/, 'Balanskonto för periodiserad kostnad måste vara ett 17xx-konto')

/** Periodisering: förutbetalda intäkter live on 29xx. */
const deferredRevenueAccount = z
  .string()
  .regex(/^29\d{2}$/, 'Balanskonto för periodiserad intäkt måste vara ett 29xx-konto')

/**
 * Shared periodisering period rules for invoice line items: both dates or
 * neither, end after start, and a 2-120 calendar month span. The amount-side
 * rules differ per item shape and stay in each schema's superRefine.
 */
function validateAccrualPeriod(
  item: { accrual_period_start?: string | null; accrual_period_end?: string | null },
  ctx: z.RefinementCtx,
): void {
  const start = item.accrual_period_start
  const end = item.accrual_period_end
  if (!start && !end) return
  if (!start || !end) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['accrual_period_start'],
      message: 'Ange både periodens start och slut för periodisering',
    })
    return
  }
  if (end < start) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['accrual_period_end'],
      message: 'Periodens slut måste vara efter dess start',
    })
    return
  }
  const months = countCalendarMonths(start, end)
  if (months < 2) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['accrual_period_end'],
      message: 'Periodisering kräver minst 2 kalendermånader',
    })
  }
  if (months > 120) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['accrual_period_end'],
      message: 'Periodisering kan omfatta högst 120 månader',
    })
  }
}

// ============================================================
// Enum schemas (matching types/index.ts)
// ============================================================

export const EntityTypeSchema = z.enum(['enskild_firma', 'aktiebolag'])

export const AccountingFrameworkSchema = z.enum(['k2', 'k3'])

/**
 * Single K3 component (BFNAR 2012:1 ch.17.4, komponentavskrivning).
 *
 * Used inside AssetCreateSchema / AssetUpdateSchema's `k3_components` array.
 * The cross-component invariant (sum of `cost` equals asset `acquisition_cost`)
 * lives in `validateComponents` from `lib/bokslut/assets/k3-components.ts`
 * and is called by the route-layer refinement: it cannot be expressed in
 * a single-object schema. Component-level checks (cost > 0, salvage ≤ cost,
 * positive useful life) are reinforced by `validateComponents` too so any
 * future caller that uses just the validator gets the same guarantees.
 *
 * `salvage_value` is optional; the engine treats omission as 0.
 */
export const K3ComponentSchema = z.object({
  name: z.string().min(1, 'Komponentens namn krävs.'),
  cost: z.number().positive('Anskaffningsvärdet måste vara större än 0.'),
  useful_life_months: z.number().int().positive('Nyttjandeperioden måste vara ett positivt heltal månader.'),
  salvage_value: z.number().nonnegative().optional(),
})

export const CustomerTypeSchema = z.enum([
  'individual',
  'swedish_business',
  'eu_business',
  'non_eu_business',
])

export const SupplierTypeSchema = z.enum([
  'swedish_business',
  'eu_business',
  'non_eu_business',
])

export const InvoiceDocumentTypeSchema = z.enum([
  'invoice', 'proforma', 'delivery_note', 'quote',
])


export const VatTreatmentSchema = z.enum([
  'standard_25', 'reduced_12', 'reduced_6', 'reverse_charge', 'export', 'exempt',
])

export const AccountingMethodSchema = z.enum(['accrual', 'cash'])

export const CurrencySchema = z.enum(['SEK', 'EUR', 'USD', 'GBP', 'NOK', 'DKK'])

export const TransactionCategorySchema = z.enum([
  'income_services',
  'income_products',
  'income_other',
  'expense_equipment',
  'expense_software',
  'expense_travel',
  'expense_office',
  'expense_marketing',
  'expense_professional_services',
  'expense_education',
  'expense_representation',
  'expense_consumables',
  'expense_vehicle',
  'expense_telecom',
  'expense_bank_fees',
  'expense_card_fees',
  'expense_currency_exchange',
  'expense_other',
  'private',
  'uncategorized',
])

export const JournalEntrySourceTypeSchema = z.enum([
  'manual',
  'bank_transaction',
  'invoice_created',
  'invoice_paid',
  'invoice_cash_payment',
  'credit_note',
  'salary_payment',
  'opening_balance',
  'year_end',
  'storno',
  'correction',
  'import',
  'system',
  'inbox_item',
  'supplier_invoice_registered',
  'supplier_invoice_paid',
  'supplier_invoice_cash_payment',
  'supplier_invoice_privately_paid',
  'supplier_credit_note',
  'currency_revaluation',
  'reminder_fee',
  'accrual',
  'result_appropriation',
  'rot_rut_payout',
  'vat_settlement',
  'stripe_payout',
  'webshop_order',
  'expense_claim',
  'expense_payout',
])

/** Query params for GET /api/bookkeeping/voucher-sequences/next. */
export const VoucherSequenceNextQuerySchema = z.object({
  period_id: uuid.optional(),
  series: z.string().regex(/^[A-Z]$/, 'Verifikationsserie måste vara en bokstav A-Z').optional(),
  source_type: JournalEntrySourceTypeSchema.optional(),
  // Bank account the entry is booked from: its voucher_series override (when
  // set) takes precedence over the per-source-type default.
  cash_account_id: uuid.optional(),
  date: isoDate.optional(),
})

export const AccountTypeSchema = z.enum([
  'asset', 'equity', 'liability', 'revenue', 'expense',
])

export const NormalBalanceSchema = z.enum(['debit', 'credit'])

export const MappingRuleTypeSchema = z.enum([
  'mcc_code', 'merchant_name', 'description_pattern', 'amount_threshold', 'combined',
])

export const RiskLevelSchema = z.enum(['NONE', 'LOW', 'MEDIUM', 'HIGH', 'VERY_HIGH'])

export const DeadlineTypeSchema = z.enum([
  'delivery', 'invoicing', 'report', 'tax', 'other',
])

export const DeadlinePrioritySchema = z.enum(['critical', 'important', 'normal'])

export const TaxDeadlineTypeSchema = z.enum([
  'moms_monthly',
  'moms_quarterly',
  'moms_yearly',
  'f_skatt',
  'arbetsgivardeklaration',
  'skatteinbetalning',
  'inkomstdeklaration_ef',
  'inkomstdeklaration_ab',
  'arsredovisning',
  'arsstamma',
  'periodisk_sammanstallning',
  'kvarskatt',
])

export const TaxAssessmentDecisionTypeSchema = z.enum(['final', 'reassessment'])

export const CreateTaxAssessmentNoticeSchema = z
  .object({
    fiscal_period_id: uuid,
    decision_type: TaxAssessmentDecisionTypeSchema,
    decision_date: saneIsoDate,
    payment_due_date: saneIsoDate,
  })
  .refine((data) => data.payment_due_date >= data.decision_date, {
    message: 'Förfallodagen får inte vara tidigare än beslutsdagen',
    path: ['payment_due_date'],
  })

export const UpdateTaxAssessmentNoticeSchema = z
  .object({
    fiscal_period_id: uuid.optional(),
    decision_type: TaxAssessmentDecisionTypeSchema.optional(),
    decision_date: saneIsoDate.optional(),
    payment_due_date: saneIsoDate.optional(),
    archived: z.boolean().optional(),
  })
  .refine((data) => Object.values(data).some((value) => value !== undefined), {
    message: 'Minst ett fält måste anges',
  })
  .refine(
    (data) => !data.decision_date || !data.payment_due_date || data.payment_due_date >= data.decision_date,
    {
      message: 'Förfallodagen får inte vara tidigare än beslutsdagen',
      path: ['payment_due_date'],
    },
  )

export const UpdateInitialSetupStateSchema = z
  .object({
    path: z.enum(['migration', 'bank', 'fresh']).nullable().optional(),
    completed: z.boolean().optional(),
    dismissed: z.boolean().optional(),
  })
  .refine((data) => Object.values(data).some((value) => value !== undefined), {
    message: 'Minst ett fält måste anges',
  })

export const DeadlineSourceSchema = z.enum(['system', 'user'])

export const MomsPeriodSchema = z.enum(['monthly', 'quarterly', 'yearly'])

export const PsPeriodTypeSchema = z.enum(['monthly', 'quarterly'])
export const TaxFilingMethodSchema = z.enum(['electronic', 'paper'])

export const DocumentUploadSourceSchema = z.enum([
  'camera', 'file_upload', 'email', 'e_invoice', 'scan', 'api', 'system',
])

// ============================================================
// Invoice schemas
// ============================================================

export const CreateInvoiceItemSchema = z
  .object({
    // 'text' = free-text or blank spacer row: description only, amounts ignored
    // and excluded from totals/bookkeeping. Defaults to 'product'. Callers still
    // send quantity/unit/unit_price for text rows (the form sends 0/''/0), so
    // the inferred shape stays consistent for downstream code.
    line_type: z.enum(['product', 'text']).optional(),
    description: z.string().max(2000),
    quantity: z.number(),
    unit: z.string(),
    unit_price: z.number(),
    // Percentage discount on the line (rabatt i procent per artikelrad).
    // line_total and vat_amount are computed NET of this server-side
    // (lib/invoices/line-amounts.ts); the client never sends a total.
    discount_percent: z.number().min(0).max(100).nullable().optional(),
    vat_rate: z.number().min(0).max(100).optional(),
    // Article linkage. `article_id` ties the line to a catalog article (text
    // rows omit it). `revenue_account` is the legacy wire name for the optional
    // BAS class 1-3 posting-account override the engine books to; the API
    // validates it against chart_of_accounts before use, and class 1-2
    // accounts are only accepted on zero-VAT lines (build-invoice-write.ts).
    article_id: uuid.nullable().optional(),
    revenue_account: invoicePostingAccount.nullable().optional(),
    // Kundorder provenance: the order line this invoice line was created
    // from. Round-tripped on draft edits; the DB trigger refuses a quantity
    // that would over-invoice the order line.
    sales_order_item_id: uuid.nullable().optional(),
    // ROT/RUT-avdrag fields. `deduction_amount` is intentionally omitted from
    // the client schema: the API computes it from rot-rut-rules.ts so a
    // tampered client can't expand the 1513 receivable beyond the line total.
    deduction_type: z.enum(['rot', 'rut']).nullable().optional(),
    labor_hours: z.number().nonnegative().nullable().optional(),
    work_type: z.string().max(64).nullable().optional(),
    housing_designation: z.string().max(128).nullable().optional(),
    apartment_number: z.string().max(32).nullable().optional(),
    // Bostadsrättsföreningens orgnr (XSD BrfOrgNrTYPE). If present it must be
    // a real orgnr shape: 10 digits (optional dash after position 6) or the
    // 12-digit sekelsiffra form, or Skatteverkets schemavalidering rejects
    // the whole file at upload time. Empty string = cleared field → null.
    brf_org_number: z
      .union([
        z.string().regex(/^(\d{6}-?\d{4}|16\d{10})$/, 'Ogiltigt organisationsnummer (10 siffror, ev. med bindestreck)'),
        z.literal(''),
      ])
      .transform((v) => v || null)
      .nullable()
      .optional(),
    // Periodisering (förutbetald intäkt): defer the line's net revenue over
    // the service period. The revenue entry credits the 29xx interim account
    // instead of the revenue account; output VAT is never deferred.
    accrual_period_start: isoDate.nullable().optional(),
    accrual_period_end: isoDate.nullable().optional(),
    accrual_balance_account: deferredRevenueAccount.nullable().optional(),
    // Dimensions PR7: per-item bag merged over the invoice's
    // default_dimensions on the revenue line this item books to.
    dimensions: DimensionsBagSchema.optional(),
  })
  .superRefine((item, ctx) => {
    validateAccrualPeriod(item, ctx)
    const hasAccrual = Boolean(item.accrual_period_start || item.accrual_period_end)
    if (hasAccrual) {
      if (item.line_type === 'text') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['accrual_period_start'],
          message: 'Textrader kan inte periodiseras',
        })
      }
      if (item.deduction_type) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['accrual_period_start'],
          message: 'ROT/RUT-rader kan inte periodiseras',
        })
      }
      // Net of any line discount: a 100 % rebated row has nothing to defer.
      if (computeLineNet(item.quantity, item.unit_price, item.discount_percent) <= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['accrual_period_start'],
          message: 'Endast rader med positivt belopp kan periodiseras',
        })
      }
    }
    // Free-text rows skip the product-line requirements (description may be
    // empty for a spacer; quantity/unit/price are ignored).
    if (item.line_type === 'text') return
    if (item.description.trim().length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['description'], message: 'Item description is required' })
    }
    if (item.quantity <= 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['quantity'], message: 'Quantity must be positive' })
    }
    if (item.unit.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['unit'], message: 'Unit is required' })
    }
  })

const optionalIsoDate = isoDate.or(z.literal('')).transform(v => v || undefined).optional()

export const QuoteStatusSchema = z.enum(['open', 'accepted', 'declined'])

// POST /api/invoices/[id]/quote-status. Any transition between the three
// decisions is allowed until the quote has been converted to an invoice.
export const SetQuoteStatusSchema = z.object({
  status: QuoteStatusSchema,
  // Optional new expiry. This is how an expired (open, past valid_until)
  // quote is reopened: sent quotes are not draft-editable, so the date
  // travels with the decision. The DB trigger mirrors it into due_date.
  valid_until: optionalIsoDate,
})

/**
 * ROT/RUT claim completeness (HUSFL: art av arbete + antal arbetstimmar) at
 * the invoice level, where document_type is known: only real invoices book a
 * deduction (buildInvoiceWriteData nulls the fields for proformas, delivery
 * notes and quotes), and free-text rows carry no claim. Field-level paths so
 * the editor can point at the row; validateInvoice re-runs the same rules for
 * callers that bypass this schema.
 */
function refineRotRutLineCompleteness(
  data: { document_type?: string; items: Array<{ line_type?: string; deduction_type?: 'rot' | 'rut' | null; work_type?: string | null; labor_hours?: number | null }> },
  ctx: z.RefinementCtx,
): void {
  if (data.document_type && data.document_type !== 'invoice') return
  data.items.forEach((item, index) => {
    if (!item.deduction_type || item.line_type === 'text') return
    const workType = item.work_type?.trim() || null
    if (!workType) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['items', index, 'work_type'], message: DEDUCTION_LINE_ERRORS.workTypeMissing })
    } else if (deductionTypeForWorkType(workType) !== item.deduction_type) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['items', index, 'work_type'], message: DEDUCTION_LINE_ERRORS.workTypeMismatch })
    }
    const isSchablon = workType != null && SCHABLON_WORK_TYPES.includes(workType)
    if (!isSchablon && !(typeof item.labor_hours === 'number' && item.labor_hours > 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['items', index, 'labor_hours'], message: DEDUCTION_LINE_ERRORS.hoursMissing })
    }
  })
}

const CreateInvoiceBaseSchema = z.object({
  customer_id: uuid,
  invoice_date: isoDate,
  due_date: isoDate,
  delivery_date: optionalIsoDate,
  currency: CurrencySchema,
  document_type: InvoiceDocumentTypeSchema.optional(),
  // Quotes only: the date the offer expires ("Giltig till"). Required when
  // document_type is 'quote' (refineQuoteFields); ignored otherwise.
  valid_until: optionalIsoDate,
  your_reference: z.string().optional(),
  our_reference: z.string().optional(),
  // Fakturamärkning: buyer-required marking (kostnadsställe/projekt/PO),
  // separate from your_reference. Printed on the PDF and mapped to Peppol
  // BT-10 BuyerReference when set.
  invoice_marking: z.string().max(200).optional(),
  notes: z.string().optional(),
  // Optional online payment link (manual MVP): the user pastes a link created
  // in their PSP dashboard (e.g. a Stripe Payment Link). https-only because the
  // URL is rendered in customer-facing emails/PDFs under the company's name.
  // The invoice form always sends the field ('' when empty), so empty string
  // normalises to undefined like external_invoice_number above; build-invoice-
  // write maps undefined to NULL so clearing the field on a draft edit works.
  payment_link_url: z
    .union([
      z
        .string()
        .max(2048)
        .refine((v) => {
          try {
            return new URL(v).protocol === 'https:'
          } catch {
            return false
          }
        }, 'Ogiltig betalningslänk (måste vara en https-adress)'),
      z.literal(''),
    ])
    .transform((v) => v || undefined)
    .optional(),
  // Per-invoice opt-out for the automatic Stripe payment link on send.
  // Omitted → true (create) / kept as sent by the form (edit).
  payment_link_auto: z.boolean().optional(),
  // ROT/RUT claim info. The personnummer is plaintext on the wire and gets
  // encrypted server-side before it ever hits the DB (see encryptPersonnummer
  // in lib/salary/personnummer.ts). `deduction_housing_designation` is the
  // fastighetsbeteckning at invoice level: required when any ROT item is
  // present (enforced via rot-rut-rules.validateInvoice in the API).
  deduction_personnummer: z.string().max(20).optional(),
  deduction_housing_designation: z.string().max(128).optional(),
  // ROT i bostadsrätt: lägenhetsnummer + föreningens orgnr replace the
  // fastighetsbeteckning (Begaran.xsd: LagenhetsNr + BrfOrgNr). Stamped onto
  // the rot lines server-side, same as deduction_housing_designation.
  deduction_apartment_number: z.string().max(25).optional(),
  // Same orgnr shape rule as items[].brf_org_number; empty string = not set.
  deduction_brf_org_number: z
    .union([
      z.string().regex(/^(\d{6}-?\d{4}|16\d{10})$/, 'Ogiltigt organisationsnummer (10 siffror, ev. med bindestreck)'),
      z.literal(''),
    ])
    .transform((v) => v || undefined)
    .optional(),
  // When true, save as an unnumbered draft: skip F-series allocation and the
  // invoice.created event until the user finalizes via POST /invoices/{id}/finalize
  // ("Granska och skapa"). An unnumbered draft is not yet an issued faktura
  // (ML 17 kap 24§), so it can be hard-deleted with no gap in the number series.
  save_as_draft: z.boolean().optional(),
  // Per-invoice öresavrundning toggle (display-only). Omitted → stored as null,
  // which inherits company_settings.ore_rounding when rendering totals.
  ore_rounding: z.boolean().optional(),
  // Dimensions PR7: invoice-level bag applied to every generated journal line;
  // items[].dimensions merge over it per revenue line.
  default_dimensions: DimensionsBagSchema.optional(),
  // Self-billing (mottagen självfaktura, ML 17 kap 15§): optional. Set
  // is_self_billed=true to register an invoice the CUSTOMER issued on your
  // behalf. For your books it is a sale, booked immediately (Debit 1510, Credit
  // 30xx + 26xx) with the counterparty's number in external_invoice_number: no
  // number from your own series is consumed (BFL 5 kap 6§), and there is no
  // draft/send step. When is_self_billed is true, external_invoice_number and
  // received_date are required (enforced in the route). Leave off for a normal
  // invoice. A plain optional flag (no schema refine) so UpdateInvoiceSchema's
  // .omit() keeps working on this object.
  is_self_billed: z.boolean().optional(),
  // The dashboard invoice form always sends these self-billing fields (default
  // '' in create/edit mode) even for a normal invoice, so an empty string must
  // read as "not provided", not fail validation. Otherwise a plain
  // external_invoice_number: '' trips the min(1) and 400s every regular invoice
  // create. Required-when-self-billed is still enforced in the v1 route via a
  // falsy check after parse, so normalising '' -> undefined here is safe.
  external_invoice_number: z
    .union([z.string().min(1).max(64), z.literal('')])
    .transform((v) => v || undefined)
    .optional(),
  self_billing_agreement_ref: z
    .string()
    .max(128)
    .transform((v) => v || undefined)
    .optional(),
  received_date: optionalIsoDate,
  // Which of the company's bank accounts the invoice asks the customer to pay
  // to (migration 20260904011000). Omitted/null = the per-currency default.
  // The route checks the account belongs to the company, is flagged as a
  // payee and is usable for the invoice currency.
  payment_cash_account_id: z
    .union([uuid, z.literal('')])
    .transform((v) => v || null)
    .nullable()
    .optional(),
  items: z.array(CreateInvoiceItemSchema).min(1, 'At least one item is required'),
})

// A quote must say how long it is valid: valid_until is the one header
// field the document type adds, and the PDF, the list and the derived
// "expired" state all key off it.
function refineQuoteFields(
  data: { document_type?: InvoiceDocumentType; valid_until?: string },
  ctx: z.RefinementCtx,
) {
  if (data.document_type === 'quote' && !data.valid_until) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['valid_until'],
      message: 'Giltig till (valid_until) krävs för en offert.',
    })
  }
}

export const CreateInvoiceSchema = CreateInvoiceBaseSchema
  .superRefine(refineRotRutLineCompleteness)
  .superRefine(refineQuoteFields)

// Update (edit) an existing DRAFT invoice in place. Same shape as create minus
// `save_as_draft`: editing never (re)creates a draft or allocates a number, it
// only rewrites the draft's header + line items. The PATCH route guards that the
// target is still a draft (status='draft', no journal entry, not self-billed).
export const UpdateInvoiceSchema = CreateInvoiceBaseSchema
  .omit({ save_as_draft: true })
  .superRefine(refineRotRutLineCompleteness)
  .superRefine(refineQuoteFields)

export const CreateCreditNoteSchema = z.object({
  credited_invoice_id: uuid,
  reason: z.string().optional(),
})

// ============================================================
// Rot/rut begäran om utbetalning (Skatteverkets husavdragstjänst)
// ============================================================

export const RotRutPayoutFileSchema = z.object({
  deduction_type: z.enum(['rot', 'rut']),
  invoice_ids: z.array(uuid).min(1).max(500),
  // NamnPaBegaran: the XSD caps it at 16 chars; omitted → generated.
  name: z.string().min(1).max(16).optional(),
})

export const RotRutRequestPatchSchema = z.object({
  status: z.enum(['submitted', 'paid', 'partially_paid', 'rejected', 'cancelled']),
  // Godkänt belopp from Skatteverkets beslut. Only meaningful together with
  // paid/partially_paid/rejected.
  decided_total: nonNegativeAmount.optional(),
})

export const RotRutSettleSchema = z.object({
  payment_date: isoDate,
  // Defaults server-side to decided_total ?? requested_total.
  amount: z.number().positive().optional(),
  // BAS 19xx account the payout landed on (1920 Bank, 1930 Företagskonto, …).
  // Omitted → 1930. The engine validates existence against chart_of_accounts.
  bank_account: z
    .string()
    .regex(/^19\d{2}$/, 'Bankkontot måste vara ett BAS 19xx-konto')
    .optional(),
})

// The beslutsfil JSON downloaded from Skatteverkets rot/rut e-tjänst
// (dev_docs/skatteverket/husavdrag/exempel_beslut.json + ht.raml).
export const RotRutBeslutFileSchema = z.object({
  version: z.string(),
  // Utförarens orgnr, 12 digits with 16-prefix in SKV's file.
  utforare: z.string().regex(/^\d{10,12}$/),
  beslut: z
    .array(
      z.object({
        // NamnPaBegaran as submitted (1-16 chars); the primary match key
        // against rot_rut_payout_requests.name.
        namn: z.string().min(1),
        referensnummer: z.string().regex(/^\d{11}(-\d+)?$/),
        arenden: z
          .array(
            z.object({
              personnummer: z.string().regex(/^\d{12}$/),
              fakturanummer: z.string().max(20).optional(),
              // Whole kronor; 0 = avslag for the ärende.
              godkantBelopp: z.number().int().min(0),
            }),
          )
          .min(1),
      }),
    )
    .min(1),
})

// ============================================================
// Articles (artikelregister)
// ============================================================

export const ArticleTypeSchema = z.enum(['vara', 'tjanst'])

/**
 * articles.housework_type: a Skatteverket arbetstypskod (BYGG, EL, ..., STAD,
 * TRADGARD, ...) or the bare kind ROT / RUT (deduction only, no arbetstyp
 * pre-fill). Case-insensitive, stored upper-case; '' clears to null. The
 * invoice editor derives a line's skattereduktion from this value, so any
 * other string is a silently dead flag and is rejected here.
 */
export const HouseworkTypeSchema = z
  .string()
  .max(64)
  .nullable()
  .optional()
  .transform((v, ctx) => {
    if (v == null) return v
    if (v.trim() === '') return null
    const normalized = normalizeHouseworkType(v)
    if (!normalized) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Ogiltig ROT/RUT-arbetstyp. Tillåtna värden: ${HOUSEWORK_TYPE_VALUES.join(', ')}`,
      })
      return z.NEVER
    }
    return normalized
  })

export const CreateArticleSchema = z.object({
  name: z.string().min(1, 'Article name is required').max(200),
  type: ArticleTypeSchema.optional(),
  unit: z.string().min(1).max(32).optional(),
  price_excl_vat: nonNegativeAmount,
  vat_rate: vatRatePercent.optional(),
  // Default price currency; omitted = SEK. Pre-fills a new invoice's currency.
  // Constrained to the same CurrencySchema enum invoices use, which mirrors the
  // seeded currencies reference table: an unknown code is a clean 400 here
  // instead of a raw FK violation (23503) surfacing at insert time.
  currency: CurrencySchema.optional(),
  // Optional BAS class 1-3 posting-account override. Null/omitted = derive from
  // the invoice's VAT treatment (current behaviour).
  revenue_account: invoicePostingAccount.nullable().optional(),
  // Margin/display only; never posted.
  cost_price: nonNegativeAmount.nullable().optional(),
  ean: z.string().max(32).nullable().optional(),
  // ROT/RUT arbetstyp; only meaningful for type === 'tjanst'.
  housework_type: HouseworkTypeSchema,
  name_en: z.string().max(200).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  // Manual article number; omit to auto-generate via generate_article_number.
  article_number: z.string().max(64).nullable().optional(),
})

// PATCH allows every create field plus toggling the soft-delete flag.
export const UpdateArticleSchema = CreateArticleSchema.partial().extend({
  active: z.boolean().optional(),
})

// Self-billing received (mottagen självfaktura, ML 17 kap 15§). The customer
// issued the invoice on our behalf; for us it is a sale. We store the
// counterparty's number in external_invoice_number and never assign one from
// our own series. No ROT/RUT (that is a B2C, own-issued concept), so the item
// schema is the lean revenue-only shape: vat_rate is constrained to the legal
// Swedish set so the booked output VAT is always reportable.
export const SelfBillingInvoiceItemSchema = z.object({
  description: z.string().min(1, 'Item description is required'),
  quantity: z.number().positive('Quantity must be positive'),
  unit: z.string().min(1, 'Unit is required').default('st'),
  unit_price: z.number(),
  vat_rate: z
    .union([z.literal(0), z.literal(6), z.literal(12), z.literal(25)])
    .optional(),
})

export const CreateSelfBillingInvoiceSchema = z.object({
  customer_id: uuid,
  external_invoice_number: z.string().min(1, 'External invoice number is required').max(64),
  self_billing_agreement_ref: z.string().max(128).optional(),
  invoice_date: isoDate,
  received_date: isoDate,
  due_date: isoDate,
  currency: CurrencySchema,
  notes: z.string().optional(),
  items: z.array(SelfBillingInvoiceItemSchema).min(1, 'At least one item is required'),
})

// ============================================================
// Recurring invoice schedule schemas
// ============================================================

// Swedish VAT rates per ML 17 kap 24§ p.9. null means "use the customer's
// default rate" (getAvailableVatRates), which is 0% for a VAT-validated EU
// business or an export customer: huvudregeln, ML 6 kap. 34 §, taxes a B2B
// service where the buyer is established. An explicit 25/12/6 is still lawful
// for those customers when the supply is taxed where it is performed
// (fastighetstjänst, persontransport, korttidsuthyrning, restaurang/catering,
// admission to cultural and sports events), so cron-time validation in
// executeRecurringSchedule gates on getPermittedVatRates, not on the default.
// A rate outside 0/6/12/25 is rejected here: there is no such Swedish rate, and
// the buyer could not deduct ingående moms on it.
export const RecurringScheduleItemSchema = z.object({
  description: z.string().min(1, 'Item description is required'),
  quantity: z.number().positive('Quantity must be positive'),
  unit: z.string().min(1, 'Unit is required').default('st'),
  unit_price: z.number(),
  vat_rate: z
    .union([z.literal(0), z.literal(6), z.literal(12), z.literal(25)])
    .nullable()
    .optional(),
  // Copied onto the generated invoice_items.dimensions; merges over the
  // schedule's default_dimensions on that item's revenue line.
  dimensions: DimensionsBagSchema.optional(),
})

export const CreateRecurringScheduleSchema = z.object({
  customer_id: uuid,
  name: z.string().min(1, 'Schedule name is required').max(200),
  day_of_month: z.number().int().min(1).max(31),
  // Months between runs: 1 = monthly (default), 3 = quarterly, 6 = half-
  // yearly, 12 = yearly. Any 1-12 is accepted (e.g. every 2 months).
  interval_months: z.number().int().min(1).max(12).default(1),
  // Whole hour (0-23) in Europe/Stockholm at which the invoice is sent.
  send_hour: z.number().int().min(0).max(23).default(8),
  payment_terms_days: z.number().int().min(0).max(90).default(30),
  currency: CurrencySchema.default('SEK'),
  your_reference: z.string().optional(),
  our_reference: z.string().optional(),
  notes: z.string().optional(),
  auto_send: z.boolean().default(false),
  // Copied onto invoices.default_dimensions for every generated invoice.
  default_dimensions: DimensionsBagSchema.optional(),
  // Optional: when to first run. Defaults to next occurrence of day_of_month
  // (today if day_of_month === today, otherwise next month). Fixes the month
  // phase of a quarterly/yearly schedule ("bill in February"); must be on the
  // schedule grid (day = day_of_month clamped) and not in the past.
  start_date: isoDate.optional(),
  items: z.array(RecurringScheduleItemSchema).min(1, 'At least one item is required'),
})

export const UpdateRecurringScheduleSchema = z.object({
  customer_id: uuid.optional(),
  name: z.string().min(1).max(200).optional(),
  day_of_month: z.number().int().min(1).max(31).optional(),
  // Changing the interval alone leaves next_run_date untouched: the new
  // cadence applies from the next run onward.
  interval_months: z.number().int().min(1).max(12).optional(),
  send_hour: z.number().int().min(0).max(23).optional(),
  payment_terms_days: z.number().int().min(0).max(90).optional(),
  currency: CurrencySchema.optional(),
  your_reference: z.string().nullable().optional(),
  our_reference: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  auto_send: z.boolean().optional(),
  status: z.enum(['active', 'paused']).optional(),
  // Explicit next run date: re-phases the schedule (e.g. move a yearly
  // schedule from January to February). Must be on the schedule grid for
  // the effective day_of_month and strictly after today in Stockholm; wins
  // over the automatic recompute a day_of_month edit or reactivation does.
  next_run_date: isoDate.optional(),
  // Replaces the whole bag if provided ({} clears all tags). Omit to keep.
  default_dimensions: DimensionsBagSchema.optional(),
  // Replace all items if provided. Omit to keep existing items unchanged.
  items: z.array(RecurringScheduleItemSchema).min(1).optional(),
})

export const MarkInvoicePaidSchema = z.object({
  payment_date: isoDate.optional(),
  exchange_rate_difference: z.number().optional(),
  notes: z.string().optional(),
  lines: z.array(z.object({
    account_number: accountNumber,
    debit_amount: nonNegativeAmount.default(0),
    credit_amount: nonNegativeAmount.default(0),
    line_description: z.string().optional(),
    // Dimensions PR7: user-edited payment lines keep their tags (the
    // no-override path re-propagates the invoice's default_dimensions).
    dimensions: DimensionsBagSchema.optional(),
  })).min(2).optional(),
  // Bypass the duplicate-payment guard. Set after the user reviews the
  // candidate list returned by INVOICE_PAID_LIKELY_DUPLICATE and confirms
  // none of them are this payment. v1 callers must use a fresh
  // Idempotency-Key on the retry: the original is body-hash bound.
  force: z.boolean().optional(),
})

export const MarkInvoiceSentSchema = z.object({
  // Optional user-edited issuance lines ("Markera som skickad och bokför").
  // When present they replace the generated invoice entry verbatim: the route
  // validates balance and books exactly these lines, and accrual schedules
  // are NOT created (what the user reviewed is what books). Only honored on
  // the accrual book-at-issue path; ignored for credit notes, cash-method
  // and deferred-booking companies, which don't book at mark-sent.
  lines: z.array(z.object({
    account_number: accountNumber,
    debit_amount: nonNegativeAmount.default(0),
    credit_amount: nonNegativeAmount.default(0),
    line_description: z.string().optional(),
    dimensions: DimensionsBagSchema.optional(),
  })).min(2).optional(),
})

// Bulk Bokför: drafts are issued (F-number + mark-sent semantics, no email)
// and booked when the company books at issue; sent/overdue unbooked invoices
// get the deferred /book semantics. 200 caps one request at two list pages.
export const InvoicesBulkBookSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
})

export const SendInvoiceSchema = MarkInvoiceSentSchema.extend({
  additional_cc: invoiceEmailAddressList.optional(),
  additional_bcc: invoiceEmailAddressList.optional(),
}).refine(
  (data) => (
    (data.additional_cc?.length ?? 0) + (data.additional_bcc?.length ?? 0)
    <= MAX_INVOICE_EMAIL_COPY_RECIPIENTS
  ),
  {
    message: `Högst ${MAX_INVOICE_EMAIL_COPY_RECIPIENTS} extra kopiemottagare är tillåtna totalt`,
    path: ['additional_cc'],
  },
)

// ============================================================
// Customer schemas
// ============================================================

/**
 * ISO 3166-1 alpha-2 country on customers and suppliers. A code in any case
 * ("de", "DE"), Skatteverket's EL for Greece, or a Swedish/English country
 * name ("Tyskland", "Germany") is normalised to the uppercase code; anything
 * else is a 400. The column used to take free text, which put
 * GERMANY811234567 in the SKV 5740 file (#2028). Empty string reads as
 * "not supplied".
 */
const countryCode = z.string().transform((value, ctx) => {
  const code = normalizeCountryCode(value)
  if (!code) {
    ctx.addIssue({
      code: 'custom',
      message:
        `country "${value}" is not an ISO 3166-1 alpha-2 code or a known country name. `
        + 'Use a code such as SE, DE or NO.',
    })
    return z.NEVER
  }
  return code
})
export const CountryCodeSchema = emptyStringAsUndefined(countryCode)

export const CreateCustomerSchema = z.object({
  name: z.string().min(1, 'Customer name is required'),
  customer_type: CustomerTypeSchema,
  // Kundnummer shown on invoices. Free text, not unique in v1. Empty string
  // and null both clear the value (routes normalize '' to null).
  customer_number: z
    .string()
    .trim()
    .max(32, 'Customer number must be 32 characters or fewer')
    .nullable()
    .optional(),
  contact_person: z.string().trim().max(200).nullable().optional(),
  email: z.string().email('Invalid email address').optional(),
  phone: z.string().optional(),
  invoice_email_cc_addresses: invoiceEmailAddressList.nullable().optional(),
  invoice_email_bcc_addresses: invoiceEmailAddressList.nullable().optional(),
  address_line1: z.string().optional(),
  address_line2: z.string().optional(),
  postal_code: z.string().optional(),
  city: z.string().optional(),
  country: CountryCodeSchema,
  org_number: z.string().optional(),
  vat_number: z.string().optional(),
  personal_number: z
    .string()
    .regex(/^(\d{6}|\d{8})[-+]?\d{4}$/, 'Invalid personal number')
    .optional()
    .nullable(),
  language: z.enum(['sv', 'en']).optional(),
  // Whole days 0-365; 0 = betalning direkt / vid mottagande (issue #2070).
  default_payment_terms: z.number().int().min(0).max(365).optional(),
  notes: z.string().optional(),
}).superRefine((customer, ctx) => {
  if (customer.personal_number && customer.customer_type !== 'individual') {
    ctx.addIssue({
      code: 'custom',
      path: ['personal_number'],
      message: 'Personal number is only allowed for individual customers',
    })
  }
  // Country vs customer type vs VAT prefix (#2025): an EU business with
  // country SE got reverse charge and nothing objected until the periodisk
  // sammanställning, after the invoice was sent. An omitted country is SE
  // for Swedish types, derived from the VAT prefix for eu_business, and
  // required for non_eu_business (see defaultCountryForParty); the
  // transform below stores the resolved value.
  const effectiveCountry =
    customer.country ?? defaultCountryForParty(customer.customer_type, customer.vat_number)
  if (!effectiveCountry) {
    ctx.addIssue({
      code: 'custom',
      path: ['country'],
      message:
        customer.customer_type === 'eu_business'
          ? 'country is required for an EU business unless vat_number carries an EU country prefix (e.g. DE811234567)'
          : 'country is required for a non-EU business',
    })
  } else {
    const countryIssue = checkCountryConsistency({
      partyType: customer.customer_type,
      country: effectiveCountry,
      vatNumber: customer.vat_number,
    })
    if (countryIssue) {
      ctx.addIssue({
        code: 'custom',
        path: ['country'],
        message: COUNTRY_CONSISTENCY_MESSAGES[countryIssue].en,
      })
    }
  }
  // GDPR art. 5.1 c: a personnummer stored as a business org_number is shown
  // unmasked everywhere (only customer_type='individual' rows are masked), so
  // refuse to accept one silently.
  if (
    customer.org_number &&
    customer.customer_type !== 'individual' &&
    looksLikeSwedishPersonalNumber(customer.org_number)
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['org_number'],
      message:
        'org_number looks like a Swedish personal identity number (personnummer). '
        + 'Create the customer with customer_type "individual" and pass the number as personal_number '
        + 'instead, so it is stored encrypted and masked in list responses.',
    })
  }
  // An individual's personnummer submitted as org_number is moved into
  // personal_number by the transform below. Next to a DIFFERENT
  // personal_number in the same body the two conflict, and guessing which
  // one the caller meant is worse than a 400.
  if (
    customer.personal_number
    && orgNumberHoldsPersonalNumber(customer.customer_type, customer.org_number)
    && personalNumberDigits(customer.org_number!) !== personalNumberDigits(customer.personal_number)
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['org_number'],
      message:
        'org_number looks like a Swedish personal identity number (personnummer) and differs from '
        + 'personal_number. An individual customer keeps its personnummer in personal_number; leave org_number empty.',
    })
  }
  if (
    (customer.invoice_email_cc_addresses?.length ?? 0)
    + (customer.invoice_email_bcc_addresses?.length ?? 0)
    > MAX_INVOICE_EMAIL_COPY_RECIPIENTS
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['invoice_email_cc_addresses'],
      message: `At most ${MAX_INVOICE_EMAIL_COPY_RECIPIENTS} customer invoice copy recipients are allowed in total`,
    })
  }
}).transform((input) => {
  // The resolved country (see the superRefine above): always a code here,
  // the refine has already rejected the cases where none can be derived.
  const customer = {
    ...input,
    country: input.country ?? defaultCountryForParty(input.customer_type, input.vat_number) ?? 'SE',
  }
  // A personnummer-shaped org_number on customer_type='individual' IS the
  // personnummer, submitted in the wrong field (the MCP create tool had no
  // personal_number input until 2026-08-21, and the v1 docs long said
  // "org_number accepted as input" for individuals). Nothing masks
  // org_number, so it is moved into personal_number, where the routes
  // encrypt it and every read returns ********-1234, and org_number is left
  // empty. With an equal personal_number already present only the duplicate
  // is dropped; an unequal one was refused above.
  if (!orgNumberHoldsPersonalNumber(customer.customer_type, customer.org_number)) return customer
  return {
    ...customer,
    org_number: undefined,
    personal_number: customer.personal_number || normalizeReroutedPersonalNumber(customer.org_number!),
  }
})

export const UpdateCustomerSchema = z.object({
  name: z.string().min(1, 'Customer name is required').optional(),
  customer_type: CustomerTypeSchema.optional(),
  customer_number: z.string().trim().max(32).nullable().optional(),
  contact_person: z.string().trim().max(200).nullable().optional(),
  email: z.string().email('Invalid email address').optional(),
  phone: z.string().optional(),
  invoice_email_cc_addresses: invoiceEmailAddressList.nullable().optional(),
  invoice_email_bcc_addresses: invoiceEmailAddressList.nullable().optional(),
  address_line1: z.string().optional(),
  address_line2: z.string().optional(),
  postal_code: z.string().optional(),
  city: z.string().optional(),
  country: CountryCodeSchema,
  org_number: z.string().optional(),
  vat_number: z.string().optional(),
  // Plaintext personnummer (validated here, then encrypted by the route), or
  // either masked form a read path returns: '********-1234' when the stored
  // value decrypted, '********-????' when it did not. The route reads a mask
  // as "leave the stored value alone" and never stores it, so a client echoing
  // back what it read cannot wipe the personnummer.
  // Both forms must pass. Accepting only the '-1234' one made an undecryptable
  // row completely uneditable: the mask the API had just returned failed
  // validation here, so PATCHing the customer's name or address 400'd on a
  // field the user had no way to correct.
  // CreateCustomerSchema stays strict: on create there is no stored value to
  // preserve, so a mask there is a client error and earns a 400.
  personal_number: z
    .string()
    .regex(PERSONAL_NUMBER_INPUT_RE, 'Invalid personal number')
    .nullable()
    .optional(),
  language: z.enum(['sv', 'en']).optional(),
  // Whole days 0-365; 0 = betalning direkt / vid mottagande (issue #2070).
  default_payment_terms: z.number().int().min(0).max(365).optional(),
  notes: z.string().optional(),
}).superRefine((customer, ctx) => {
  if (
    (customer.invoice_email_cc_addresses?.length ?? 0)
    + (customer.invoice_email_bcc_addresses?.length ?? 0)
    > MAX_INVOICE_EMAIL_COPY_RECIPIENTS
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['invoice_email_cc_addresses'],
      message: `At most ${MAX_INVOICE_EMAIL_COPY_RECIPIENTS} customer invoice copy recipients are allowed in total`,
    })
  }
})

// ============================================================
// Supplier schemas
// ============================================================

/**
 * Optional field where an empty or whitespace-only string means "not set".
 *
 * HTML forms submit untouched inputs as '', which a format-validated
 * `.optional()` field would reject ('' is a present string, so it hits the
 * format rule). Same normalization as `optString` in
 * lib/pending-operations/schemas/create-supplier.ts.
 */
function emptyStringAsUndefined<T extends z.ZodTypeAny>(inner: T) {
  return z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    inner.optional(),
  )
}

export const CreateSupplierSchema = z.object({
  name: z.string().min(1, 'Supplier name is required'),
  supplier_type: SupplierTypeSchema,
  email: emptyStringAsUndefined(z.string().email('Invalid email address')),
  phone: z.string().optional(),
  address_line1: z.string().optional(),
  address_line2: z.string().optional(),
  postal_code: z.string().optional(),
  city: z.string().optional(),
  country: CountryCodeSchema,
  org_number: z.string().optional(),
  vat_number: z.string().optional(),
  bankgiro: z.string().optional(),
  plusgiro: z.string().optional(),
  bank_account: z.string().optional(),
  iban: z.string().optional(),
  bic: z.string().optional(),
  clearing_number: z.string().optional(),
  account_number: z.string().optional(),
  default_expense_account: emptyStringAsUndefined(accountNumber),
  // Whole days 0-365; 0 = betalning direkt / vid mottagande (issue #2070).
  default_payment_terms: z.number().int().min(0).max(365).optional(),
  default_currency: CurrencySchema.nullable().optional(),
  notes: z.string().optional(),
})

/**
 * Optional field where an empty or whitespace-only string means "clear it".
 *
 * Update routes pass validated fields straight into `.update({...})`, where
 * undefined keys are dropped by supabase-js (column left unchanged) and null
 * writes NULL. So on update an empty string from a cleared form field must
 * become null, not undefined, or clearing would silently do nothing.
 */
function emptyStringAsNull<T extends z.ZodTypeAny>(inner: T) {
  return z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
    inner.nullable().optional(),
  )
}

export const UpdateSupplierSchema = CreateSupplierSchema.partial().extend({
  email: emptyStringAsNull(z.string().email('Invalid email address')),
  default_expense_account: emptyStringAsNull(accountNumber),
})

// ============================================================
// Supplier invoice schemas
// ============================================================

export const CreateSupplierInvoiceItemSchema = z.object({
  description: z.string().min(1, 'Item description is required'),
  amount: z.number().optional(),
  account_number: accountNumber,
  vat_rate: vatRateDecimal.optional(),
  // Manual VAT override. When provided, the engine books this exact amount to
  // 2641/2645 instead of recomputing line_total × vat_rate. Use for partial-
  // deductible cases (bilförmån 50%, representation 300 kr-tak), foreign-
  // currency rounding, or POS receipts where supplier-side rounding makes the
  // VAT off by öre.
  vat_amount: z.number().min(0).optional(),
  // Self-assessed VAT rate for omvänd skattskyldighet (reverse charge). The
  // supplier charges no VAT (vat_rate stays 0); this is the Swedish statutory
  // rate the buyer self-assesses at: 25% huvudregel default, 12%/6% for
  // reduced-rated services (ML 6 kap 34 §). Must be a statutory rate.
  reverse_charge_rate: z
    .number()
    .refine((r) => r === 0.06 || r === 0.12 || r === 0.25, {
      message: 'reverse_charge_rate must be 0.06, 0.12, or 0.25',
    })
    .optional(),
  // Särskild löneskatt på pensionskostnader (SLP): when true the booking
  // engine injects a self-balancing 7533 D / 2514 K pair at 24.26 % of the
  // line total (lib/bookkeeping/slp-lines.ts). The pair never changes the
  // payable. Routes reject the flag on non-741x accounts and in combination
  // with the periodisering fields below.
  apply_slp: z.boolean().optional(),
  vat_code: z.string().optional(),
  quantity: z.number().optional(),
  unit: z.string().optional(),
  unit_price: z.number().optional(),
  // Periodisering (förutbetald kostnad): defer the line's net cost over the
  // service period. The registration entry debits the 17xx interim account
  // instead of account_number; input VAT is never deferred.
  accrual_period_start: isoDate.nullable().optional(),
  accrual_period_end: isoDate.nullable().optional(),
  accrual_balance_account: prepaidExpenseAccount.nullable().optional(),
  // Dimensions PR7: per-item bag merged over the invoice's
  // default_dimensions on the expense line this item books to.
  dimensions: DimensionsBagSchema.optional(),
}).refine(
  (item) => {
    if (item.vat_amount == null) return true
    const lineTotal = item.amount != null
      ? item.amount
      : (item.quantity ?? 1) * (item.unit_price ?? 0)
    const vatRate = item.vat_rate ?? 0.25
    const maxVat = Math.round(lineTotal * vatRate * 100) / 100
    // 1-öre tolerance covers POS rounding; anything beyond is an upstream bug
    // or a client trying to inflate 2641 debit beyond the statutory ceiling.
    return item.vat_amount <= maxVat + 0.01
  },
  {
    message: 'vat_amount cannot exceed line_total × vat_rate',
    path: ['vat_amount'],
  },
).superRefine((item, ctx) => {
  validateAccrualPeriod(item, ctx)
  if (item.accrual_period_start || item.accrual_period_end) {
    const lineTotal = item.amount != null
      ? item.amount
      : (item.quantity ?? 1) * (item.unit_price ?? 0)
    if (lineTotal <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['accrual_period_start'],
        message: 'Endast rader med positivt belopp kan periodiseras',
      })
    }
  }
})

export const CreateSupplierInvoiceSchema = z.object({
  supplier_id: uuid,
  // Optional invoice PDF/image already stored in the WORM document archive.
  // The route verifies company ownership and that the document is unused.
  document_id: uuid.optional(),
  supplier_invoice_number: z.string().min(1, 'Supplier invoice number is required'),
  invoice_date: isoDate,
  due_date: isoDate,
  delivery_date: optionalIsoDate,
  currency: CurrencySchema.optional(),
  // Bounded by the shared `exchangeRate` primitive so the value can never
  // reach `supplier_invoices_exchange_rate_check` and come back as a 500.
  exchange_rate: exchangeRate.optional(),
  vat_treatment: VatTreatmentSchema.optional(),
  reverse_charge: z.boolean().optional(),
  payment_reference: z.string().optional(),
  notes: z.string().optional(),
  // Per-invoice öresavrundning toggle (display-only). Omitted → stored as null (off).
  ore_rounding: z.boolean().optional(),
  paid_with_private_funds: z.boolean().optional(),
  // For paid_with_private_funds: who paid. An employee (2820) by id, or the
  // owner by name (2893 in an AB, 2018 in an enskild firma); an omitted name
  // falls back to the shared owner label so Hem groups the owner as one
  // person. Both are ignored unless paid_with_private_funds is true.
  employee_id: uuid.optional().nullable(),
  claimant_name: z.string().trim().max(200).optional(),
  // For paid_with_private_funds: the invoice-inbox item whose document is the
  // underlag. The route takes the document from the item and settles the item
  // itself, so a privately paid inbox document never goes through the
  // extension's convert endpoint (which registers on 2440 only).
  inbox_item_id: uuid.optional().nullable(),
  // For paid_with_private_funds: the date the owner paid out-of-pocket.
  // Defaults to invoice_date (common for kvitto where the two coincide).
  payment_date: isoDate.optional(),
  // Dimensions PR7: invoice-level bag applied to every generated journal line;
  // items[].dimensions merge over it per expense line.
  default_dimensions: DimensionsBagSchema.optional(),
  items: z.array(CreateSupplierInvoiceItemSchema).min(1, 'At least one item is required'),
})

// Pre-submit duplicate lookup for the supplier-invoice editor. Mirrors the
// partial unique index idx_supplier_invoices_company_supplier_number on
// (company_id, supplier_id, supplier_invoice_number), which excludes
// credited/reversed invoices, so the advisory never warns on the re-issue
// pattern the index was widened to allow.
export const SupplierInvoiceExistsQuerySchema = z.object({
  supplier_id: uuid,
  number: z.string().min(1, 'number is required'),
})

export const MarkSupplierInvoicePaidSchema = z.object({
  amount: z.number().positive().optional(),
  payment_date: isoDate.optional(),
  exchange_rate_difference: z.number().optional(),
  notes: z.string().optional(),
  force: z.boolean().optional(),
  // Which BAS account to credit for the payment. Defaults to 1930 to preserve
  // the historical behaviour for MCP / agent callers that don't supply it.
  payment_account: accountNumber.optional(),
  // Optional user-edited journal entry rows. When present they override the
  // default 2440-clearing / cash booking. Server validates balance and posts
  // via createJournalEntry directly. source_type still derives from the
  // routing decision so downstream payment-sync keeps working.
  lines: z.array(z.object({
    account_number: accountNumber,
    debit_amount: nonNegativeAmount.default(0),
    credit_amount: nonNegativeAmount.default(0),
    line_description: z.string().optional(),
    // Dimensions PR7: user-edited payment lines keep their tags (the
    // no-override path re-propagates the invoice's default_dimensions).
    dimensions: DimensionsBagSchema.optional(),
  })).min(2).optional(),
})

/**
 * "Inlagd i banken" (#2220): a boolean mark, not a payment. `entered: true`
 * records that the user typed the payment into the bank by hand; `false`
 * takes the mark back. No amount, no date: the payment itself is still
 * recorded by mark-paid or the bank match, which also clears the mark.
 */
export const SupplierInvoiceBankEnteredSchema = z.object({
  entered: z.boolean(),
})

export const UpdateSupplierInvoiceSchema = z.object({
  supplier_invoice_number: z.string().min(1).optional(),
  invoice_date: isoDate.optional(),
  due_date: isoDate.optional(),
  delivery_date: optionalIsoDate,
  payment_reference: z.string().optional(),
  notes: z.string().optional(),
})

// ============================================================
// Supplier payment batch (betalfil) schemas
// ============================================================

// v1 gates the API to pain001; the DB CHECK also allows 'bg_lb' so a future
// format lands without a migration.
const supplierPaymentBatchFormat = z.enum(['pain001'])

export const PreviewSupplierPaymentBatchSchema = z.object({
  format: supplierPaymentBatchFormat,
  ids: z.array(z.string().uuid()).min(1).max(100),
})

export const SupplierPaymentBatchItemInputSchema = z.object({
  supplier_invoice_id: z.string().uuid(),
  // Defaults to the invoice's remaining amount.
  amount: z.number().positive().optional(),
  // Defaults to max(due_date, today); past dates are normalized to today.
  payment_date: isoDate.optional(),
})

export const CreateSupplierPaymentBatchSchema = z.object({
  format: supplierPaymentBatchFormat,
  items: z.array(SupplierPaymentBatchItemInputSchema).min(1).max(100),
  confirm_already_batched: z.boolean().optional(),
})

export const SupplierPaymentBatchListQuerySchema = z.object({
  status: z.enum(['created', 'cancelled', 'all']).default('all'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
})

// ============================================================
// Journal entry schemas
// ============================================================

export const CreateJournalEntryLineSchema = z.object({
  account_number: accountNumber,
  debit_amount: nonNegativeAmount.default(0),
  credit_amount: nonNegativeAmount.default(0),
  line_description: z.string().optional(),
  currency: z.string().optional(),
  amount_in_currency: z.number().optional(),
  exchange_rate: z.number().positive().optional(),
  tax_code: z.string().optional(),
  // SIE dimension map {sie_dim_no: object_code}, e.g. {"1":"KS01","6":"P001"}.
  // Single source of truth for the constraints lives in dimension-resolver so
  // the staged pending-operations path validates identically. Wins per key
  // over the cost_center/project aliases.
  dimensions: DimensionsBagSchema.optional(),
  // Deprecated aliases for dimensions['1'] / dimensions['6'], kept forever
  // for API/MCP compatibility.
  cost_center: z.string().optional(),
  project: z.string().optional(),
})

export const CreateJournalEntrySchema = z.object({
  fiscal_period_id: uuid,
  entry_date: isoDate,
  description: z.string().min(1, 'Description is required'),
  source_type: JournalEntrySourceTypeSchema.default('manual'),
  source_id: z.string().optional(),
  voucher_series: z.string().regex(/^[A-Z]$/, 'Verifikationsserie måste vara en bokstav A-Z').optional(),
  notes: z.string().max(2000).optional(),
  lines: z.array(CreateJournalEntryLineSchema).min(2, 'At least two lines are required for double-entry'),
})

export const CorrectJournalEntrySchema = z.object({
  // Optional verifikationstext for the corrected entry. When omitted the
  // server falls back to "Rättelse: <original description>"; supplying it lets
  // the user replace a header that echoed the wrong account's label (#1031).
  description: z.string().trim().min(1, 'Description cannot be empty').optional(),
  lines: z.array(CreateJournalEntryLineSchema).min(2, 'At least two lines are required for double-entry'),
  // Explicit override of the correction-chain depth guard (the "Rätta ändå"
  // confirm in the UI). Without it, correcting an entry 3+ links deep in a
  // rättelse chain returns CORRECTION_CHAIN_TOO_DEEP.
  allow_deep_chain: z.boolean().optional(),
})

// ============================================================
// Inline rättelse of a posted verifikat (BFL 5 kap 5 § / 9 §)
// ============================================================
// The correct_entry_metadata / correct_entry_lines_inline RPCs enforce the
// full envelope (posted status, open period, company lock date, balance,
// who/when logging); these schemas only shape the payload.

/** POST /api/bookkeeping/journal-entries/[id]/correct-metadata */
export const CorrectEntryMetadataSchema = z
  .object({
    description: z.string().trim().min(1, 'Beskrivningen kan inte vara tom').max(500).optional(),
    entry_date: isoDate.optional(),
  })
  .refine((body) => body.description !== undefined || body.entry_date !== undefined, {
    message: 'Minst ett fält måste anges',
  })

/**
 * Replacement line for an inline strike. Deliberately narrower than
 * CreateJournalEntryLineSchema: inline additions are SEK-only and carry no
 * tax_code or currency conversion (those corrections use the storno flow).
 */
export const InlineRattelseLineSchema = z.object({
  account_number: accountNumber,
  debit_amount: nonNegativeAmount.default(0),
  credit_amount: nonNegativeAmount.default(0),
  line_description: z.string().max(500).optional(),
  dimensions: DimensionsBagSchema.optional(),
})

/** POST /api/bookkeeping/journal-entries/[id]/strike-lines */
export const StrikeLinesSchema = z
  .object({
    strike_line_ids: z.array(uuid).max(200).default([]),
    lines: z.array(InlineRattelseLineSchema).max(100).default([]),
  })
  .refine((body) => body.strike_line_ids.length > 0 || body.lines.length > 0, {
    message: 'Rättelsen måste stryka eller lägga till minst en rad',
  })

// ============================================================
// Dimension registry schemas (kostnadsställe/projekt)
// ============================================================
// dev_docs/dimensions_implementation_plan.md §6. The registry tables
// (dimensions/dimension_values) shipped in 20260702084500_dimensions_substrate.

/**
 * Object code for USER-CREATED dimension values: strict Fortnox format.
 * Deliberately tighter than both the DB CHECK (1..40 chars, no `"{}`') and
 * DimensionsBagSchema (line-level values): legacy free-text codes from the
 * backfill/SIE import must survive on lines, but new registry codes minted
 * through the API stay portable to Fortnox/Visma.
 */
const dimensionValueCode = z
  .string()
  .regex(
    /^[A-Za-z0-9ÅÄÖåäö_+\-]{1,20}$/,
    'Koden får bara innehålla bokstäver (A-Ö), siffror, _, + och - (max 20 tecken)',
  )

const dimensionValueDates = {
  start_date: isoDate.nullable().optional(),
  end_date: isoDate.nullable().optional(),
}

/** PATCH /api/dimensions/[id]: name is rejected route-side for is_system dims. */
export const UpdateDimensionSchema = z
  .object({
    name: z.string().min(1).max(80).optional(),
    is_active: z.boolean().optional(),
    sort_order: z.number().int().min(0).optional(),
  })
  .refine((body) => Object.values(body).some((v) => v !== undefined), {
    message: 'Minst ett fält måste anges',
  })

/** POST /api/dimensions/[id]/values: code is immutable after creation (v1: no rename). */
export const CreateDimensionValueSchema = z
  .object({
    code: dimensionValueCode,
    name: z.string().min(1).max(120),
    /** Omitted → true. Lets "create as archived" be a single atomic POST. */
    is_active: z.boolean().optional(),
    ...dimensionValueDates,
  })
  .refine(
    (body) => !body.start_date || !body.end_date || body.end_date >= body.start_date,
    { message: 'Slutdatum får inte vara före startdatum', path: ['end_date'] },
  )

/**
 * POST /api/bookkeeping/journal-entry-lines/[lineId]/retag: Tier-2 retro-
 * tagging (dimensions plan PR6). The RPC enforces every rule (posted only,
 * open period, lock date, active registry values); this schema only shapes
 * the request. An empty bag {} untags the line.
 */
/**
 * POST /api/dimensions — create a custom dimension (dimensions PR10).
 * sie_dim_no omitted → server picks the next free number >= 20 (SIE leaves
 * 20+ unreserved). parent_sie_dim_no declares an #UNDERDIM hierarchy.
 */
export const CreateDimensionSchema = z.object({
  name: z.string().trim().min(1).max(60),
  sie_dim_no: z.coerce.number().int().min(1).max(9999).optional(),
  resets_annually: z.boolean().optional(),
  parent_sie_dim_no: z.coerce.number().int().min(1).max(9999).nullable().optional(),
})

const AccountDimensionRuleTypeSchema = z.enum(['required', 'default', 'fixed'])

/** GET /api/dimensions/rules query — optional exact-account filter. */
export const ListDimensionRulesQuerySchema = z.object({
  account_number: accountNumber.optional(),
})

/**
 * POST /api/dimensions/rules — per-account dimension policy (dimensions
 * PR10). 'required' carries no value; 'default'/'fixed' must carry the value
 * to apply. One rule per (account, dimension) — enforced by the DB UNIQUE.
 */
export const CreateAccountDimensionRuleSchema = z
  .object({
    account_number: accountNumber,
    dimension_id: uuid,
    rule_type: AccountDimensionRuleTypeSchema,
    value_id: uuid.optional(),
    is_active: z.boolean().optional(),
  })
  .superRefine((rule, ctx) => {
    if (rule.rule_type === 'required' && rule.value_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value_id'],
        message: 'En obligatorisk regel har inget värde — värden hör till Förval/Låst.',
      })
    }
    if (rule.rule_type !== 'required' && !rule.value_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value_id'],
        message: 'Välj vilket värde regeln ska använda.',
      })
    }
  })

/** PATCH /api/dimensions/rules/[id] — the value-presence rule re-checks in the route (partial update). */
export const UpdateAccountDimensionRuleSchema = z.object({
  rule_type: AccountDimensionRuleTypeSchema.optional(),
  value_id: uuid.nullable().optional(),
  is_active: z.boolean().optional(),
})

export const RetagLineDimensionsSchema = z.object({
  // {} passes (no entries to validate) = UNTAG. Intentional divergence from
  // the MCP staged path (RetagLineDimensionsParamsSchema), which rejects an
  // empty bag: a human clearing phantom tags via the dialog/workbench is a
  // deliberate act with a logged reason; an agent bulk-clearing history is
  // not something we allow to be staged. The retag log records {} as the
  // new value either way (#867 review).
  dimensions: DimensionsBagSchema,
  reason: z.string().min(3).max(500),
})

/** PATCH /api/dimensions/[id]/values/[valueId]: no `code` field by design. */
export const UpdateDimensionValueSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    is_active: z.boolean().optional(),
    ...dimensionValueDates,
  })
  .refine((body) => Object.values(body).some((v) => v !== undefined), {
    message: 'Minst ett fält måste anges',
  })

/**
 * Move a posted verifikation to a different date (and thereby fiscal period)
 * without changing its lines: fixes a booking entered with the wrong
 * date/year. The corrected lines are copied server-side from the original.
 */
export const RecordateJournalEntrySchema = z.object({
  new_entry_date: isoDate,
  // Explicit override of the correction-chain depth guard ("Flytta ändå"):
  // a date move is another storno+rättelse layer, so it carries the guard too.
  allow_deep_chain: z.boolean().optional(),
})

// ============================================================
// Transaction schemas
// ============================================================

/**
 * Manual bank-transaction creation (the "Lägg till transaktion" form).
 *
 * The authoritative server-side boundary for that flow. Historically the form
 * inserted straight into Supabase from the browser with only
 * `z.string().min(1)` on the date, which let a corrupt 6-digit year through and
 * crashed the page on render. The form reuses `isSaneDateString` (via this
 * schema's `saneIsoDate`) so the date rule is single-sourced across layers.
 */
export const CreateTransactionSchema = z.object({
  date: saneIsoDate,
  description: z.string().min(1, 'Description is required').max(500),
  amount: z.number().refine((n) => n !== 0, 'Amount must not be zero'),
  currency: CurrencySchema,
  category: TransactionCategorySchema.optional(),
  notes: z.string().max(2000).optional(),
})

export const CategorizeTransactionSchema = z
  .object({
    is_business: z.boolean(),
    category: TransactionCategorySchema.optional(),
    template_id: z.string().optional(),
    vat_treatment: VatTreatmentSchema.optional(),
    account_override: accountNumber.optional(),
    counterparty_template_id: z.string().uuid().optional(),
    // Dimensions bag {sie_dim_no: code} applied to the business lines of the
    // generated verifikat (bank/VAT legs stay untagged). Wins over a learned
    // counterparty-template bag when both are present.
    dimensions: DimensionsBagSchema.optional(),
    user_description: z.string().max(500).optional(),
    inbox_item_id: z.string().uuid().optional(),
    confirm_no_match: z.boolean().optional(),
    // Booking-time duplicate guard (TRANSACTION_BOOK_POSSIBLE_DUPLICATE). force
    // bypasses it after the user reviews the candidate; the bypass is bound to
    // the specific already-booked candidate (re-detected server-side, so a
    // guessed id can't wave the guard away). The candidate is either a sibling
    // transaction (expected_duplicate_transaction_id) or a ledger-only voucher
    // with no transaction behind it (expected_duplicate_journal_entry_id): both
    // carry a journal_entry_id, so new callers bind on that.
    force: z.boolean().optional(),
    expected_duplicate_transaction_id: uuid.optional(),
    expected_duplicate_journal_entry_id: uuid.optional(),
  })
  .refine((v) => !v.force || !!v.expected_duplicate_transaction_id || !!v.expected_duplicate_journal_entry_id, {
    message: 'expected_duplicate_transaction_id or expected_duplicate_journal_entry_id is required when force=true',
    path: ['expected_duplicate_journal_entry_id'],
  })

export const BookTransactionSchema = z
  .object({
    fiscal_period_id: uuid,
    entry_date: isoDate,
    description: z.string().min(1, 'Description is required'),
    lines: z.array(CreateJournalEntryLineSchema).min(1, 'At least one line is required'),
    // Explicit series from the booking dialog's picker. Omitted: the route
    // resolves it from the transaction's cash account, then the per-type map.
    voucher_series: z.string().regex(/^[A-Z]$/, 'Verifikationsserie måste vara en bokstav A-Z').optional(),
    // Booking-time duplicate guard: see CategorizeTransactionSchema.
    force: z.boolean().optional(),
    expected_duplicate_transaction_id: uuid.optional(),
    expected_duplicate_journal_entry_id: uuid.optional(),
  })
  .refine((v) => !v.force || !!v.expected_duplicate_transaction_id || !!v.expected_duplicate_journal_entry_id, {
    message: 'expected_duplicate_transaction_id or expected_duplicate_journal_entry_id is required when force=true',
    path: ['expected_duplicate_journal_entry_id'],
  })

// ── Webshop orders (Orders page) ──────────────────────────────

export const WebshopPlatformSchema = z.enum(['woocommerce', 'shopify'])

export const WebshopOrdersListQuerySchema = z.object({
  platform: WebshopPlatformSchema.optional(),
  store_scope: z.string().max(255).optional(),
  status: z.string().max(64).optional(),
  row_type: z.enum(['order', 'refund']).optional(),
  paid: z.enum(['paid', 'unpaid']).optional(),
  booked: z.enum(['booked', 'unbooked']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
})

export const BookWebshopOrderSchema = z.object({
  fiscal_period_id: uuid,
  entry_date: isoDate,
  description: z.string().min(1, 'Description is required').max(500),
  lines: z.array(CreateJournalEntryLineSchema).min(2, 'At least two lines are required'),
  voucher_series: z
    .string()
    .regex(/^[A-Z]$/, 'Verifikationsserie måste vara en bokstav A-Z')
    .optional(),
  notes: z.string().max(2000).optional(),
})

/**
 * Bulk booking of webshop orders: each order books as its OWN verifikat
 * through the same server-side flow as the single-order endpoint (never one
 * combined journal write). Max 50 = one orders-page of selection.
 */
/**
 * Revenue account for the bulk revenue template: class 3 only, and never
 * 3740. The template routes the revenue side of the sweep; a non-revenue
 * account here would put sales on a balance or cost account with no
 * reviewing user per line. 3740 (öresavrundning) is excluded because the
 * bulk route bounds the rounding residual by that account: a templated
 * revenue line on 3740 would both misbook real revenue as rounding and
 * blind that guard (skeptic finding). Orders needing an off-class-3 revenue
 * leg go through the single-order dialog, which is fully line-editable.
 */
const webshopRevenueAccount = accountNumber
  .refine((n) => n.startsWith('3'), {
    message: 'Intäktskontot måste vara ett konto i klass 3 (3000-3999)',
  })
  .refine((n) => n !== '3740', {
    message: 'Öresavrundningskontot 3740 kan inte användas som intäktskonto',
  })

export const BulkBookWebshopOrdersSchema = z.object({
  order_ids: z.array(uuid).min(1).max(50),
  /**
   * Optional override: prefill every order's payment leg against this
   * account instead of the per-store payment-method mapping.
   */
  payment_account: accountNumber.optional(),
  /**
   * Optional revenue template: revenue account per Swedish VAT rate, keyed
   * by the rate as a string. A missing rate falls back to the standard
   * 3001-series map. Output VAT accounts are never overridable: they are
   * derived from the rate.
   */
  revenue_accounts: z
    .object({
      '25': webshopRevenueAccount.optional(),
      '12': webshopRevenueAccount.optional(),
      '6': webshopRevenueAccount.optional(),
      '0': webshopRevenueAccount.optional(),
    })
    .strict()
    .optional(),
})

export const CreateInvoiceFromWebshopOrderSchema = z.object({
  /** Omitted: match by email/orgnr within the company, else create. */
  customer_id: uuid.optional(),
})

/**
 * Mark a webshop order as booked/handled outside the integration, with an
 * optional reference to the existing (posted) verifikat that covers it.
 */
export const MarkWebshopOrderBookedSchema = z.object({
  journal_entry_id: uuid.optional(),
})

/** {"<payment_method>": {mode:'book', account:'1930'} | {mode:'invoice'}} */
export const WebshopStoreSettingsUpdateSchema = z.object({
  platform: WebshopPlatformSchema,
  store_scope: z.string().min(1).max(255),
  payment_method_account_map: z.record(
    z.string().min(1).max(64),
    z.discriminatedUnion('mode', [
      z.object({ mode: z.literal('book'), account: accountNumber }),
      z.object({ mode: z.literal('invoice') }),
    ]),
  ),
})

/**
 * Edit a bank transaction's title (description). Only the working label:
 * gated server-side to unbooked, unmatched rows. Trimmed; whitespace-only is
 * rejected by min(1). Passing the bank original restores the "not edited" tag.
 */
export const UpdateTransactionTitleSchema = z.object({
  description: z.string().trim().min(1, 'Title cannot be empty').max(500),
})

/**
 * Move an unbooked bank transaction to another of the company's cash accounts,
 * addressed by the target's BAS 19xx ledger account. Deliberately no null
 * variant: unassigning a row would just re-strand it under the primary
 * account's report (the exact symptom the move action exists to fix).
 */
export const MoveTransactionCashAccountSchema = z.object({
  account_number: z
    .string()
    .regex(/^19\d{2}$/, 'Expected a BAS 19xx bank account number'),
})

/**
 * Set or clear the verifikationsserie override on one of the company's cash
 * accounts. null clears the override: entries booked from the account then
 * follow the per-source-type default again.
 */
export const UpdateCashAccountVoucherSeriesSchema = z.object({
  voucher_series: z
    .string()
    .regex(/^[A-Z]$/, 'Verifikationsserie måste vara en bokstav A-Z')
    .nullable(),
})

export const BookInboxItemDirectlySchema = z.object({
  fiscal_period_id: uuid,
  entry_date: isoDate,
  description: z.string().min(1, 'Beskrivning krävs'),
  // `.optional()` here carries meaning the route depends on: ABSENT means
  // "caller has no opinion", so the route may default the notes from the
  // item's chat context, while an explicit '' means the user cleared the
  // prefilled note and nothing must be written back onto the verifikat.
  // Keep it `.optional()`, never `.default('')` or a min(1): both would
  // collapse those two cases into one.
  notes: z.string().max(2000).optional(),
  lines: z.array(CreateJournalEntryLineSchema).min(2, 'Minst två rader krävs för dubbel bokföring'),
  transaction_id: uuid.optional(),
})

/**
 * Bulk-book selected Underlag (Dokumentinkorgen) against their matched bank
 * transactions. One shared category + VAT treatment is applied to every
 * selected item; each item is booked against its own matched transaction (which
 * carries the SEK amount), so the verifikat are individual, not a
 * samlingsverifikation. Items without a matched transaction, already booked, or
 * already linked to a leverantörsfaktura are skipped server-side.
 *
 * Used both as the UI route body (POST /items/bulk-book) and as the
 * pending-operation params for `bulk_book_inbox_items` (Lena-driven flow).
 */
export const BulkBookInboxSchema = z.object({
  item_ids: z.array(uuid).min(1, 'Minst ett underlag krävs').max(200, 'Högst 200 underlag per bokföring'),
  category: TransactionCategorySchema,
  // Optional fields are `.nullish()` (not just `.optional()`) because the
  // `bulk_book_inbox_items` pending operation persists absent optionals as
  // explicit JSON `null` (stagePendingOperation in mcp-server/server.ts). When
  // the executor re-parses those params on approval, a bare `.optional()` would
  // reject the stored `null`. `.transform` normalizes `null → undefined` so the
  // executor and categorizeMatchedTransaction never receive `null`.
  vat_treatment: VatTreatmentSchema.nullish().transform((v) => v ?? undefined),
  // The underlag's actual moms when it differs from rate × belopp (e.g. dricks).
  // Only valid with a rate-based vat_treatment; rejected otherwise downstream.
  vat_amount: z.number().positive().nullish().transform((v) => v ?? undefined),
  notes: z.string().max(2000).nullish().transform((v) => v ?? undefined),
  allow_duplicate: z.boolean().nullish().transform((v) => v ?? undefined),
  // Shared dimensions bag applied to the business lines of every generated
  // verifikat (same semantics as single categorize). nullish for the same
  // staged-params reason as the fields above.
  dimensions: DimensionsBagSchema.nullish().transform((v) => v ?? undefined),
})

export const MatchInvoiceSchema = z
  .object({
    invoice_id: uuid,
    // Bypass the soft-duplicate guard (MATCH_INVOICE_POSSIBLE_DUPLICATE).
    // Set after the user reviews the candidate verifikation and confirms it
    // is not this payment. v1 callers must use a fresh Idempotency-Key on
    // the retry: the original is body-hash bound.
    force: z.boolean().optional(),
    // Required whenever force=true. Echoes the journal_entry_id of the
    // candidate the user reviewed in the duplicate-payment-check pre-flight.
    // The server re-detects the candidate and refuses force=true unless the
    // re-detected id matches this value. That binds the override to a
    // specific, user-seen duplicate so an automation can't sweep through
    // force=true to bypass the guard without ever consulting the candidate.
    expected_journal_entry_id: uuid.optional(),
    // Optional user-edited journal entry lines. When present they override
    // the default clearing/cash booking: the route validates balance and
    // posts via createJournalEntry directly. Source_type is still set from
    // the routing decision (invoice_paid vs invoice_cash_payment) so
    // downstream payment-sync continues to work.
    lines: z.array(z.object({
      account_number: accountNumber,
      debit_amount: nonNegativeAmount.default(0),
      credit_amount: nonNegativeAmount.default(0),
      line_description: z.string().optional(),
    })).min(2).optional(),
    // Optional caller-supplied SEK-per-invoice-currency rate for cross-currency
    // settlement. Used when the Riksbanken lookup returns nothing (rate not
    // published for that date): the dialog surfaces an input so the user can
    // type the rate from their bank statement. Ignored when tx.currency ===
    // invoice.currency. The ceiling is a sanity guard against pasted garbage /
    // scientific-notation input silently corrupting the FX-diff posting and
    // invoice_payments.amount: no supported currency's SEK rate approaches it
    // (USD~10.5, EUR~11.5, GBP~13.5). It is a guard rail, not a precise band;
    // the dialog's live preview (paid_in_invoice_currency + FX gain/loss) is
    // what catches a plausible-but-wrong decimal-shift typo before confirm.
    // It used to be `.max(100000)`, an inclusive ceiling against an exclusive
    // `payment_exchange_rate < 100000` CHECK: exactly 100000 passed Zod and
    // died in Postgres. The shared primitive is exclusive on both ends.
    manual_exchange_rate: exchangeRate.optional(),
  })
  .refine((v) => !v.force || !!v.expected_journal_entry_id, {
    message: 'expected_journal_entry_id is required when force=true',
    path: ['expected_journal_entry_id'],
  })

/**
 * Link an existing posted verifikat as payment for an invoice. No new
 * journal entry is created: only an invoice_payments row pointing at the
 * supplied journal_entry_id, plus the invoice's paid/remaining are advanced.
 */
export const LinkInvoiceToVoucherSchema = z.object({
  journal_entry_id: uuid,
  notes: z.string().max(2000).optional(),
})

/**
 * Supplier-invoice mirror: link an existing posted verifikat as payment for a
 * supplier invoice. No new JE: only a supplier_invoice_payments row pointing
 * at the supplied journal_entry_id, plus the invoice's paid/remaining advance.
 */
export const LinkSupplierInvoiceToVoucherSchema = z.object({
  journal_entry_id: uuid,
  notes: z.string().max(2000).optional(),
})

/**
 * Bulk-book N bank transactions on the same date into one combined verifikat
 * (samlingsverifikation per BFL 5 kap 6§). Two flows multiplexed by which
 * field is set:
 *
 *   - `existing_journal_entry_id`: link the txs to an already-posted voucher
 *     (no new JE created). The voucher's 19xx net must equal the tx sum.
 *
 *   - `template_id` + `mode` + `entry_description`: build a new verifikat
 *     by applying the booking template to each tx. The route does the ratio
 *     expansion (one_line_per_tx OR sum_per_account) and passes the final
 *     lines to the RPC.
 *
 * Exactly one of the two paths must be set: enforced by superRefine.
 */
export const BulkBookSchema = z
  .object({
    tx_ids: z
      .array(uuid)
      .min(1, 'At least one transaction is required')
      .max(200, 'At most 200 transactions per batch'),
    existing_journal_entry_id: uuid.optional(),
    template_id: uuid.optional(),
    mode: z.enum(['one_line_per_tx', 'sum_per_account']).optional(),
    entry_description: z.string().min(1).max(500).optional(),
    // PR #608: manual lines path. Mutually exclusive with template_id /
    // existing_journal_entry_id. The route passes these straight through
    // to the RPC's p_new_entry.lines.
    manual_lines: z
      .array(
        z.object({
          account_number: accountNumber,
          // Bound at 99,999,999 SEK per line (compliance-swarm V4.5).
          // Real-world max is in the millions; an 8-digit ceiling catches
          // typos (1000000 mistyped as 10000000000) before they hit the
          // RPC, without blocking legitimate large bookings.
          debit_amount: nonNegativeAmount.max(99_999_999, 'Line amount exceeds maximum'),
          credit_amount: nonNegativeAmount.max(99_999_999, 'Line amount exceeds maximum'),
          currency: z.string().min(3).max(3).default('SEK'),
          line_description: z.string().max(200).optional(),
          // Dimensions PR7: per-line bag, wins over default_dimensions.
          dimensions: DimensionsBagSchema.optional(),
        })
      )
      .min(2, 'A verifikat needs at least two lines')
      .max(200)
      .optional(),
    // Dimensions PR7: header-level bag applied to every generated line in
    // BOTH the template and manual paths (per-line bags win per key). The
    // route merges before calling the RPC.
    default_dimensions: DimensionsBagSchema.optional(),
    // Bypass the booking-time duplicate guard after the user reviewed the
    // flagged candidate (TRANSACTION_BOOK_POSSIBLE_DUPLICATE). Bulk-book has
    // no per-tx candidate binding: force skips the guard for the whole batch,
    // and the route records each dismissed candidate in behandlingshistorik.
    force: z.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    const hasExisting = !!data.existing_journal_entry_id
    const hasTemplate = !!data.template_id
    const hasManual = !!data.manual_lines
    const paths = [hasExisting, hasTemplate, hasManual].filter(Boolean).length
    if (paths !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Provide exactly one of: existing_journal_entry_id (link), template_id (template), or manual_lines (manual)',
        path: ['existing_journal_entry_id'],
      })
      return
    }
    if (hasTemplate) {
      if (!data.mode) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'mode is required when template_id is set',
          path: ['mode'],
        })
      }
      if (!data.entry_description) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'entry_description is required when template_id is set',
          path: ['entry_description'],
        })
      }
    }
    if (hasManual && !data.entry_description) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'entry_description is required when manual_lines is set',
        path: ['entry_description'],
      })
    }
  })

/**
 * Allocate one bank transaction across N customer OR N supplier invoices.
 * Backed by the match_batch_allocate PL/pgSQL RPC, which builds a single
 * combined verifikat (samlingsverifikation) and inserts N payment rows.
 */
export const MatchBatchSchema = z
  .object({
    allocations: z
      .array(
        z.discriminatedUnion('kind', [
          z.object({
            kind: z.literal('customer_invoice'),
            invoice_id: uuid,
            // Strictly positive: zero or negative is rejected at the schema
            // layer (PR #603 review) so the RPC's BATCH_INVALID_AMOUNT path
            // is only reachable from non-HTTP callers.
            amount: z.number().positive('Allocation amount must be greater than 0'),
          }),
          z.object({
            kind: z.literal('supplier_invoice'),
            supplier_invoice_id: uuid,
            amount: z.number().positive('Allocation amount must be greater than 0'),
          }),
        ]),
      )
      .min(1, 'At least one allocation is required')
      // Cap at 100 to prevent DoS via unbounded FOR UPDATE locks in the RPC
      // (PR #603 compliance review, OWASP V4.2). Domain-appropriate ceiling:
      // a real samlingsverifikat rarely covers more than a few dozen invoices.
      .max(100, 'At most 100 allocations per batch'),
    // Bypass the already-explained guard (BATCH_TX_POSSIBLE_DUPLICATE): the
    // bank row is fully covered by one or more posted, unlinked vouchers on
    // its settlement account (an invoice marked paid by hand, a salary
    // voucher per employee). Set only after the user has seen those vouchers
    // and decided the row is a separate event.
    force: z.boolean().optional(),
    // Required whenever force=true: the journal_entry_ids of the set the
    // user reviewed. The route re-detects the set and refuses force unless
    // the ids match, so an automation cannot sweep through force=true
    // without ever consulting the vouchers (same binding as
    // MatchInvoiceSchema.expected_journal_entry_id).
    expected_journal_entry_ids: z.array(uuid).max(10).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.force && !(data.expected_journal_entry_ids?.length)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expected_journal_entry_ids'],
        message: 'expected_journal_entry_ids is required when force=true',
      })
    }
    // Reject mixed customer + supplier in a single batch: semantically a
    // single bank transfer settles invoices on one side. The RPC also guards
    // this with BATCH_MIXED_KINDS_UNSUPPORTED, but rejecting at the schema
    // layer gives a cleaner 400 with a per-field path.
    const kinds = new Set(data.allocations.map((a) => a.kind))
    if (kinds.size > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['allocations'],
        message: 'Allocations cannot mix customer_invoice and supplier_invoice kinds',
      })
    }
  })

export const LinkTransactionJournalEntrySchema = z.object({
  journal_entry_id: uuid,
  // Optional invoice to settle alongside the link. When provided, the
  // server inserts an invoice_payments row pointing at the existing JE
  // and flips the invoice status with the same optimistic-lock pattern
  // as the match-invoice route. Omit to only link the bank transaction
  // (e.g. when the JE doesn't relate to a customer invoice).
  invoice_id: uuid.optional(),
})

export const CreateTransactionFromDocumentSchema = z.object({
  inbox_item_id: uuid,
  amount: z.number().refine((n) => n !== 0, 'Amount must be non-zero'),
  transaction_date: isoDate,
  description: z.string().min(1).max(500),
})

/**
 * POST /api/transactions/[id]/match-rot-rut-payout: settle a ROT/RUT begäran
 * with the bank row that carried Skatteverkets utbetalning. Amount, date and
 * bank account all come from the transaction, so the body is just the target.
 */
export const MatchRotRutPayoutSchema = z.object({
  request_id: uuid,
})

/** Bank outflow → the registered utlägg it repays (one person). */
export const MatchExpensePayoutSchema = z.object({
  claim_ids: z.array(uuid).min(1).max(200),
})

export const MatchSupplierInvoiceSchema = z.object({
  supplier_invoice_id: uuid,
  // Same purpose as MatchInvoiceSchema.lines: user-edited rows override
  // the default 2440-clearing / cash booking. Route validates balance and
  // posts via createJournalEntry; source_type still derives from routing.
  lines: z.array(z.object({
    account_number: accountNumber,
    debit_amount: nonNegativeAmount.default(0),
    credit_amount: nonNegativeAmount.default(0),
    line_description: z.string().optional(),
  })).min(2).optional(),
})


// ============================================================
// Settings schemas
// ============================================================

// Editable invoice email texts (standard invoices only). Nested JSONB:
// unknown keys inside are stripped (Zod default, consistent with this file).
// Empty strings pass validation; the template resolver treats whitespace-only
// as unset, and the UI prunes empties before saving so the stored object
// stays minimal. Subject is a mail header: CR/LF are stripped at render time
// regardless.
const InvoiceEmailTextsLangSchema = z.object({
  subject: z.string().max(200, 'Ämnesraden får vara max 200 tecken').optional(),
  greeting: z.string().max(200, 'Hälsningen får vara max 200 tecken').optional(),
  body: z.string().max(2000, 'Brödtexten får vara max 2000 tecken').optional(),
  signoff: z.string().max(200, 'Avslutningen får vara max 200 tecken').optional(),
})

export const InvoiceEmailTextsSchema = z.object({
  sv: InvoiceEmailTextsLangSchema.optional(),
  en: InvoiceEmailTextsLangSchema.optional(),
})

// Editable reminder email texts per reminder level. Same conventions as
// InvoiceEmailTextsSchema: empty strings pass and are treated as unset by
// the template resolver; the UI prunes empties and stores only diffs from
// the defaults. Subject is a mail header: CR/LF are stripped at render time.
const ReminderTextOverrideLevelSchema = z.object({
  subject: z.string().max(200, 'Ämnesraden får vara max 200 tecken').optional(),
  body: z.string().max(2000, 'Brödtexten får vara max 2000 tecken').optional(),
})

export const ReminderTextOverridesSchema = z.object({
  level_1: ReminderTextOverrideLevelSchema.optional(),
  level_2: ReminderTextOverrideLevelSchema.optional(),
  level_3: ReminderTextOverrideLevelSchema.optional(),
})

const InvoiceIbanSchema = z.string()
  .transform((value) => value.replace(/\s/g, '').toUpperCase())
  .pipe(z.string().regex(/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/, 'Ogiltigt IBAN'))
  .nullable()
  .optional()
  .or(z.literal(''))

const InvoicePaymentAccountSchema = z.object({
  bank_name: z.string().trim().max(100).nullable().optional(),
  clearing_number: z.string().regex(/^\d{4,5}$/, 'Clearingnummer måste vara 4-5 siffror').nullable().optional().or(z.literal('')),
  account_number: z.string().regex(/^\d{6,12}$/, 'Kontonummer måste vara 6-12 siffror').nullable().optional().or(z.literal('')),
  bankgiro: z.string().regex(/^(\d{3,4}-\d{4}|\d{7,8})$/, 'Ogiltigt bankgironummer').nullable().optional().or(z.literal('')),
  plusgiro: z.string().regex(/^\d{1,7}-\d$/, 'Ogiltigt plusgironummer').nullable().optional().or(z.literal('')),
  swish: z.string().transform(normaliseSwish).pipe(z.string().refine(isValidSwish, 'Ogiltigt Swish-nummer')).nullable().optional(),
  iban: InvoiceIbanSchema,
  bic: z.string()
    .transform((value) => value.replace(/\s/g, '').toUpperCase())
    .pipe(z.string().regex(/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/, 'Ogiltig BIC/SWIFT'))
    .nullable()
    .optional()
    .or(z.literal('')),
  // Foreign non-IBAN routing (USD ABA routing number, GBP sort code): digits
  // with optional dashes, 6-9 digits after stripping (ABA = 9, sort code = 6).
  bank_code: z.string()
    .transform((value) => value.replace(/\s/g, ''))
    .pipe(z.string().regex(/^\d{2,3}(-?\d{2,3}){1,2}$|^\d{6,9}$/, 'Ogiltig bankkod'))
    .nullable()
    .optional()
    .or(z.literal('')),
  // Foreign account number: alphanumeric, distinct from the Swedish
  // clearing+account pair (account_number is digits-only 6-12).
  foreign_account_number: z.string()
    .transform((value) => value.replace(/\s/g, ''))
    .pipe(z.string().regex(/^[A-Za-z0-9-]{4,34}$/, 'Ogiltigt kontonummer'))
    .nullable()
    .optional()
    .or(z.literal('')),
})

/**
 * PATCH /api/cash-accounts/[id]: the verifikationsserie override plus the
 * payee fields (migration 20260904010000). Payee keys share the field rules
 * of InvoicePaymentAccountSchema so the settings form, the legacy settings
 * writers and this route agree on what a valid bankgiro is.
 */
export const UpdateCashAccountSchema = InvoicePaymentAccountSchema.extend({
  voucher_series: UpdateCashAccountVoucherSeriesSchema.shape.voucher_series.optional(),
  name: z.string().trim().min(1).max(100).nullable().optional(),
  invoice_payee: z.boolean().optional(),
}).strict().refine((body) => Object.keys(body).length > 0, {
  message: 'Inget att uppdatera',
})

/** POST /api/cash-accounts: a bank account typed by hand (no bank connection). */
export const CreateCashAccountSchema = z.object({
  name: z.string().trim().min(1, 'Ange ett namn').max(100),
  currency: CurrencySchema,
  ledger_account: z.string().regex(/^19[2-9]\d$/, 'Bankkonton bokförs på 1920-1999').optional(),
  invoice_payee: z.boolean().optional(),
  payee: InvoicePaymentAccountSchema.optional(),
}).strict()

/** PUT /api/cash-accounts/payee-defaults: which account invoices in a currency pay to. */
export const SetInvoicePayeeDefaultSchema = z.object({
  currency: CurrencySchema,
  cash_account_id: uuid.nullable(),
}).strict()

const InvoicePaymentAccountsSchema = z
  .partialRecord(CurrencySchema, InvoicePaymentAccountSchema)
  .superRefine((accounts, ctx) => {
    for (const [currency, account] of Object.entries(accounts)) {
      if (currency === 'SEK' || !account) continue
      if (account.iban) continue
      // Non-IBAN banking systems (US, UK): bank code + account number + BIC
      // identifies the account. Requiring an IBAN there forced users to paste
      // one from another currency, which then printed on the invoice.
      const nonIban = NON_IBAN_CURRENCIES.includes(currency as Currency)
      if (nonIban && account.bank_code && account.foreign_account_number && account.bic) continue
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [currency, 'iban'],
        message: nonIban
          ? `Ange IBAN eller bankkod, kontonummer och BIC/SWIFT för betalningskontot i ${currency}`
          : `IBAN krävs för betalningskonto i ${currency}`,
      })
    }
  })

export const UpdateSettingsSchema = z.object({
  entity_type: EntityTypeSchema.optional(),
  company_name: z.string().optional(),
  org_number: z.string().optional(),
  address_line1: z.string().optional(),
  address_line2: z.string().optional(),
  postal_code: z.string().optional(),
  city: z.string().optional(),
  country: z.string().optional(),
  f_skatt: z.boolean().optional(),
  vat_registered: z.boolean().optional(),
  vat_number: z.string()
    .transform(normalizeVatNumber)
    .pipe(z.string().regex(/^SE\d{12}$/, 'Momsregistreringsnummer måste vara SE följt av 12 siffror'))
    .nullable()
    .optional(),
  moms_period: MomsPeriodSchema.nullable().optional(),
  vat_taxable_base_over_40m: z.boolean().optional(),
  vat_has_eu_trade: z.boolean().optional(),
  vat_filing_method: TaxFilingMethodSchema.optional(),
  periodisk_sammanstallning_enabled: z.boolean().optional(),
  periodisk_sammanstallning_period: PsPeriodTypeSchema.optional(),
  periodisk_sammanstallning_filing_method: TaxFilingMethodSchema.optional(),
  kontrolluppgifter_enabled: z.boolean().optional(),
  rot_rut_enabled: z.boolean().optional(),
  oss_enabled: z.boolean().optional(),
  ioss_enabled: z.boolean().optional(),
  intrastat_enabled: z.boolean().optional(),
  punktskatt_enabled: z.boolean().optional(),
  fyllnadsinbetalning_enabled: z.boolean().optional(),
  tax_contact_name: z.string().max(200).nullable().optional(),
  tax_contact_phone: z.string().max(40).nullable().optional(),
  tax_contact_email: z.string().email().nullable().optional().or(z.literal('')),
  fiscal_year_start_month: z.number().int().min(1).max(12).optional(),
  preliminary_tax_monthly: z.number().nullable().optional(),
  // Share capital per Bolagsverket (annual report aktiekapital note).
  aktiekapital: z.number().int('Aktiekapital anges i hela kronor').positive('Aktiekapital måste vara större än 0').nullable().optional(),
  antal_aktier: z.number().int('Antal aktier måste vara ett heltal').positive('Antal aktier måste vara större än 0').nullable().optional(),
  employer_registered: z.boolean().nullable().optional(),
  employer_seasonal: z.boolean().optional(),
  bank_name: z.string().max(100, 'Banknamn får vara max 100 tecken').nullable().optional(),
  clearing_number: z.string().regex(/^\d{4,5}$/, 'Clearingnummer måste vara 4-5 siffror').nullable().optional().or(z.literal('')),
  account_number: z.string().regex(/^\d{6,12}$/, 'Kontonummer måste vara 6-12 siffror').nullable().optional().or(z.literal('')),
  bankgiro: z.string().regex(/^(\d{3,4}-\d{4}|\d{7,8})$/, 'Ogiltigt bankgironummer (7-8 siffror)').nullable().optional().or(z.literal('')),
  plusgiro: z.string().regex(/^\d{1,7}-\d{1}$/, 'Ogiltigt plusgironummer').nullable().optional().or(z.literal('')),
  swish: z.string()
    .transform(normaliseSwish)
    .pipe(
      z.string().refine(
        isValidSwish,
        'Ogiltigt Swish-nummer (företagsnummer 123XXXXXXX eller mobilnummer 07XXXXXXXX)',
      ),
    )
    .nullable()
    .optional(),
  // Legacy SEK mirror of invoice_payment_accounts.SEK. Use the same general
  // IBAN validation because a SEK-denominated account need not be Swedish.
  iban: InvoiceIbanSchema,
  bic: z.string().regex(/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/, 'Ogiltig BIC/SWIFT (8 eller 11 tecken)').nullable().optional().or(z.literal('')),
  invoice_payment_accounts: InvoicePaymentAccountsSchema.optional(),
  accounting_method: AccountingMethodSchema.optional(),
  // #967: register/send invoices without booking; booking is a separate step.
  defer_invoice_booking: z.boolean().optional(),
  invoice_prefix: z.string().nullable().optional(),
  next_invoice_number: z.number().int().positive().optional(),
  next_arrival_number: z.number().int().positive().optional(),
  invoice_default_days: z.number().int().positive().optional(),
  invoice_default_notes: z.string().nullable().optional(),
  default_our_reference: z.string().max(200).nullable().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional().or(z.literal('')),
  website: z.string().optional().or(z.literal('')),
  pays_salaries: z.boolean().optional(),
  sector_slug: z.string().nullable().optional(),
  // Bookkeeping lock
  bookkeeping_locked_through: z.string().regex(ISO_DATE_RE, ISO_DATE_MESSAGE_SV).nullable().optional(),
  auto_lock_period_days: z.number().int().positive().nullable().optional(),
  // Voucher series
  default_voucher_series: z.string().regex(/^[A-Z]$/, 'Verifikationsserie måste vara en bokstav A-Z').optional(),
  // Per-source-type voucher series map. Keys are journal_entries.source_type
  // values; values are single uppercase letters A-Z. Read by the engine
  // (`createDraftEntry`) when no explicit voucher_series is passed, with a
  // fallback to 'A' for unknown keys.
  // partialRecord, not record: in Zod 4 an enum-keyed z.record is exhaustive
  // (every source_type required), so saving a map that omits a source type
  // (e.g. the newly added 'result_appropriation') fails with "expected string,
  // received undefined". The map is intentionally sparse: the settings form
  // sends only the source types the user configured, and the engine falls back
  // to 'A' for any unmapped key.
  default_voucher_series_per_source_type: z
    .partialRecord(
      JournalEntrySourceTypeSchema,
      z.string().regex(/^[A-Z]$/, 'Verifikationsserie måste vara en bokstav A-Z'),
    )
    .optional(),
  // Company-defined display names per series letter ({"L": "Lön"}). Keys are
  // single uppercase letters; values are trimmed to at most 40 characters. An
  // empty value means "clear this name": it is stripped here so the stored
  // map only ever holds real names and the resolver can treat a missing key
  // as "use the preset". Display only; the engine never reads this column.
  voucher_series_labels: z
    .record(
      z.string().regex(/^[A-Z]$/, 'Verifikationsserie måste vara en bokstav A-Z'),
      z.string().trim().max(40, 'Serienamn får vara högst 40 tecken'),
    )
    .transform((labels) =>
      Object.fromEntries(Object.entries(labels).filter(([, name]) => name.length > 0)),
    )
    .optional(),
  // Invoice PDF settings
  ore_rounding: z.boolean().optional(),
  invoice_show_ocr: z.boolean().optional(),
  invoice_show_bankgiro: z.boolean().optional(),
  invoice_show_plusgiro: z.boolean().optional(),
  invoice_show_swish: z.boolean().optional(),
  invoice_show_logo: z.boolean().optional(),
  invoice_show_company_name: z.boolean().optional(),
  invoice_company_name_position: z.enum(['header', 'footer']).optional(),
  invoice_late_fee_text: z.string().nullable().optional(),
  invoice_credit_terms_text: z.string().nullable().optional(),
  // Opt-in for the invoice payment-link feature (editor field + automatic
  // Stripe link on send). Default off at the DB level.
  invoice_payment_links_enabled: z.boolean().optional(),
  // Editable invoice email texts: { sv?: {...}, en?: {...} }; null clears
  // all overrides. Without this entry the generic PUT would silently strip
  // the field (the schema is the de-facto column whitelist).
  invoice_email_texts: InvoiceEmailTextsSchema.nullable().optional(),
  invoice_email_cc_addresses: invoiceEmailAddressList.nullable().optional(),
  invoice_email_bcc_addresses: invoiceEmailAddressList.nullable().optional(),
  // Invoice branding: colors enforced as #RRGGBB at the DB level too
  // (see migration 20260526120200_invoice_branding.sql). The dedicated
  // /api/settings/invoicing/branding route is the primary path; these
  // entries let the generic PUT /api/settings also accept the same fields.
  invoice_primary_color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, 'Ange en giltig hex-färg (#RRGGBB)')
    .optional(),
  invoice_accent_color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, 'Ange en giltig hex-färg (#RRGGBB)')
    .optional(),
  invoice_font_family: z
    .enum(['Helvetica', 'Times-Roman', 'Courier', 'Source Sans 3', 'Source Serif 4', 'Custom'])
    .optional(),
  invoice_header_text: z.string().max(200).nullable().optional(),
  invoice_footer_text: z.string().max(500).nullable().optional(),
  // Automation
  send_invoice_reminders: z.boolean().optional(),
  reminder_days_level_1: z.number().int().min(1).max(365).optional(),
  reminder_days_level_2: z.number().int().min(1).max(365).optional(),
  reminder_days_level_3: z.number().int().min(1).max(365).optional(),
  // Editable reminder email texts: { level_1?: {...}, ... }; null clears all
  // overrides. Text only: fee and interest math are computed by the reminder
  // processor and never configurable here (Lag 1981:739 caps the fee at 60 kr).
  reminder_text_overrides: ReminderTextOverridesSchema.nullable().optional(),
  // Reminder surcharges (dröjsmålsränta + lagstadgad påminnelseavgift)
  reminder_fee_enabled: z.boolean().optional(),
  reminder_fee_amount: z
    .number()
    .min(0, 'Påminnelseavgift kan inte vara negativ')
    .max(60, 'Lagstadgad maxgräns för påminnelseavgift är 60 kr (Lag 1981:739)')
    .optional(),
  reminder_interest_rate_override: z
    .number()
    .min(0, 'Räntesats kan inte vara negativ')
    .max(0.9999, 'Ange räntesatsen som en decimal mindre än 1 (t.ex. 0.115 för 11,5%)')
    .nullable()
    .optional(),
  // AI agent flow
  ai_flow_enabled: z.boolean().optional(),
  // Dimensions (kostnadsställe/projekt): UI-visibility toggle only, never
  // load-bearing for correctness (dev_docs/dimensions_implementation_plan.md §2).
  dimensions_enabled: z.boolean().optional(),
  // Körjournal (mileage log): UI-visibility toggle only, never load-bearing
  // for correctness (trips created via API/MCP work regardless).
  mileage_enabled: z.boolean().optional(),
  // Kundorder (sales orders): UI-visibility toggle only, never load-bearing
  // for correctness (the pages and APIs work regardless).
  sales_orders_enabled: z.boolean().optional(),
  // Data analysis consent (#1346): gates cross-company analysis of this
  // company's bookkeeping outcomes. Flipped by a human in the settings UI
  // only; deliberately absent from the v1 REST / MCP settings pick lists.
  data_analysis_opt_in: z.boolean().optional(),
  // Salary payment file
  preferred_payment_format: z.enum(['bg_lb', 'pain001']).optional(),
  // Salary settings (migration 20260703190000). Day of month salaries are
  // paid (1–28 so it exists in every month) and the default bank whose
  // upload instructions the payment-file panel pre-selects.
  salary_pay_day: z.number().int().min(1).max(28).optional(),
  salary_default_bank: z
    .enum(['swedbank', 'seb', 'handelsbanken', 'nordea', 'other'])
    .nullable()
    .optional(),
  // Öresavrundning: round each net payout up to whole kronor (banks that
  // reject öre in salary payment files). Diff books on 3740.
  salary_net_rounding: z.boolean().optional(),
  // Vacation year basis (payroll gap-closure 3.1): sammanfallande calendar
  // year (default) or the statutory Apr 1 - Mar 31 split. The settings route
  // blocks changing this while open vacation-ledger rows exist.
  salary_vacation_year_basis: z.enum(['calendar', 'statutory_apr_mar']).optional(),
}).refine(
  (data) => (
    (data.invoice_email_cc_addresses?.length ?? 0)
    + (data.invoice_email_bcc_addresses?.length ?? 0)
    <= MAX_INVOICE_EMAIL_COPY_RECIPIENTS
  ),
  {
    message: `Högst ${MAX_INVOICE_EMAIL_COPY_RECIPIENTS} fasta kopiemottagare är tillåtna totalt`,
    path: ['invoice_email_cc_addresses'],
  },
).refine(
  (data) => {
    // BFL 3 kap.: Enskild firma must have fiscal year starting January
    if (data.entity_type === 'enskild_firma' && data.fiscal_year_start_month !== undefined) {
      return data.fiscal_year_start_month === 1
    }
    return true
  },
  {
    message: 'Enskild firma must have fiscal year starting in January (BFL 3 kap.)',
    path: ['fiscal_year_start_month'],
  }
)

// ============================================================
// Fiscal period schemas
// ============================================================

export const CreateFiscalPeriodSchema = z.object({
  name: z.string().min(1, 'Period name is required'),
  period_start: isoDate,
  period_end: isoDate,
}).refine(
  (data) => data.period_start < data.period_end,
  {
    message: 'Period start must be before period end',
    path: ['period_end'],
  }
)

// ============================================================
// Mapping rule schemas
// ============================================================

export const CreateMappingRuleSchema = z.object({
  rule_name: z.string().min(1, 'Rule name is required'),
  rule_type: MappingRuleTypeSchema,
  priority: z.number().int().min(0).optional(),
  mcc_codes: z.array(z.string()).optional(),
  merchant_pattern: z.string().optional(),
  description_pattern: z.string().optional(),
  amount_min: z.number().optional(),
  amount_max: z.number().optional(),
  debit_account: accountNumber,
  credit_account: accountNumber,
  vat_treatment: z.string().optional(),
  risk_level: RiskLevelSchema.optional(),
  default_private: z.boolean().optional(),
  requires_review: z.boolean().optional(),
  confidence_score: z.number().min(0).max(1).optional(),
})

export const EvaluateMappingRulesSchema = z.union([
  z.object({ transaction_id: uuid }),
  z.object({
    description: z.string().optional(),
    amount: z.number(),
  }).passthrough(),
])

// ============================================================
// Deadline schemas
// ============================================================

export const CreateDeadlineSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  due_date: isoDate,
  due_time: timeString.nullish(),
  deadline_type: DeadlineTypeSchema,
  priority: DeadlinePrioritySchema.nullish(),
  customer_id: uuid.nullish(),
  notes: z.string().nullish(),
  tax_deadline_type: TaxDeadlineTypeSchema.nullish(),
  tax_period: z.string().nullish(),
  source: DeadlineSourceSchema.optional(),
  linked_report_type: z.string().nullish(),
  linked_report_period: z.record(z.string(), z.unknown()).nullish(),
})

// ============================================================
// Account schemas
// ============================================================

// Per-account default VAT rate: the sats the booking UI understands, as a
// decimal fraction. Mirrors the DB CHECK on chart_of_accounts.default_vat_rate.
const defaultVatRate = z
  .union([z.literal(0), z.literal(0.06), z.literal(0.12), z.literal(0.25)])
  .nullable()
  .optional()

// Single source of truth for treatments is lib/vat/account-vat-treatment.ts;
// the DB CHECK on chart_of_accounts.default_vat_treatment mirrors it per class.
export const AccountVatTreatmentSchema = z.enum(ACCOUNT_VAT_TREATMENTS)

const defaultVatTreatment = AccountVatTreatmentSchema.nullable().optional()

export const CreateAccountSchema = z.object({
  account_number: accountNumber,
  account_name: z.string().min(1, 'Account name is required'),
  account_type: AccountTypeSchema,
  normal_balance: NormalBalanceSchema,
  plan_type: z.enum(['k1', 'full_bas']).optional(),
  description: z.string().nullable().optional(),
  default_vat_code: z.string().nullable().optional(),
  default_vat_rate: defaultVatRate,
  default_vat_treatment: defaultVatTreatment,
  sru_code: z.string().nullable().optional(),
})

export const UpdateAccountSchema = z.object({
  account_name: z.string().min(1).optional(),
  is_active: z.boolean().optional(),
  description: z.string().nullable().optional(),
  default_vat_code: z.string().nullable().optional(),
  default_vat_rate: defaultVatRate,
  default_vat_treatment: defaultVatTreatment,
  sru_code: z.string().nullable().optional(),
})

// Looser account-number shape than the 4-digit primitive on purpose: imported
// charts can carry non-standard numbers (sub-accounts like '19301'), and those
// are exactly the rows the prune flow exists to remove.
export const PruneAccountsSchema = z
  .object({
    dry_run: z.boolean(),
    account_numbers: z.array(z.string().min(1).max(10)).max(2000).optional(),
  })
  .refine((v) => v.dry_run || (v.account_numbers?.length ?? 0) > 0, {
    message: 'account_numbers is required when dry_run is false',
    path: ['account_numbers'],
  })

// ============================================================
// Bank reconciliation schemas
// ============================================================

export const BankLinkSchema = z
  .object({
    transaction_id: uuid,
    // One verifikat (1:1, or N:1 when other transactions already point at it).
    journal_entry_id: uuid.optional(),
    // Or several verifikat settled by this one transaction (1:N, #1553): the
    // signed slice per verifikat in the transaction's sign convention. The
    // slices must sum to the transaction amount; the engine enforces it.
    allocations: z
      .array(z.object({ journal_entry_id: uuid, amount: z.number() }))
      .min(2)
      .max(50)
      .optional(),
    // Settlement account being reconciled. The voucher must have a line on this
    // account and the transaction must belong to it. Defaults to '1930' in the
    // route for back-compat.
    account_number: accountNumber.optional(),
  })
  .refine((v) => (v.journal_entry_id ? !v.allocations : Boolean(v.allocations)), {
    message: 'Ange journal_entry_id eller allocations, inte båda.',
    path: ['journal_entry_id'],
  })

export const BankUnlinkSchema = z.object({
  transaction_id: uuid,
})

/**
 * Re-tag a mis-typed bank-account opening balance (a manual/import voucher that
 * is really an ingående balans) as source_type='opening_balance' so bank
 * reconciliation excludes it from the period movement. Routed to the
 * mark_entry_as_opening_balance SECURITY DEFINER RPC, which enforces the rest.
 */
export const MarkOpeningBalanceSchema = z.object({
  journal_entry_id: uuid,
})

export const RunReconciliationSchema = z.object({
  date_from: isoDate.optional(),
  date_to: isoDate.optional(),
  // Run the per-cash-account unattended sweep over every enabled cash account
  // ("Kör matchning igen" in the review surface) instead of one account. The
  // sweep always applies at the unattended threshold and persists suggestions;
  // there is no dry-run form. The route REJECTS (400) any combination with
  // dry_run, account_number or selected_matches rather than silently ignoring
  // them: a request that asked for a preview must never apply writes.
  all_accounts: z.boolean().optional(),
  // BAS settlement account to reconcile against (e.g. '1930', '1932'). Defaults
  // to '1930' server-side so existing clients stay correct.
  account_number: accountNumber.optional(),
  dry_run: z.boolean().optional(),
  // Pairs the user ticked in the dry-run preview. When present on an apply
  // (dry_run false), only these pairs are committed: intersected server-side
  // with a fresh match run, so a stale or fabricated pair is never applied.
  selected_matches: z
    .array(
      z.object({
        transaction_id: uuid,
        journal_entry_id: uuid,
      }),
    )
    .max(500)
    .optional(),
  // Server-side confidence floor for the apply path (0..1), mirroring the v1
  // route. The UI sends 0.85 with a strong-only apply so a pair that scored
  // lower on the fresh server re-run is never committed, even if a stale
  // client still has it ticked. Omitted = legacy behavior: every selected
  // match applies, including manually ticked fuzzy ones at 0.75.
  confidence_threshold: z.number().min(0).max(1).optional(),
})

// Confirm or reject persisted journal-entry match suggestions
// (transactions.potential_journal_entry_id). Each pair is revalidated
// server-side at confirm time; stale pairs are skipped, never failing the batch.
export const ConfirmJeSuggestionsSchema = z.object({
  transaction_ids: z.array(uuid).min(1).max(500),
  action: z.enum(['confirm', 'reject']),
})

// ============================================================
// Report query schemas
// ============================================================

export const VatDeclarationQuerySchema = z.object({
  periodType: z.enum(['monthly', 'quarterly', 'yearly']),
  year: z.coerce.number().int().min(2000).max(2100),
  period: z.coerce.number().int().min(1).max(12),
})

export const AccountBalancesQuerySchema = z.object({
  accounts: z
    .string()
    .transform((s) => s.split(',').map((a) => a.trim()).filter(Boolean))
    .pipe(z.array(accountNumber).min(1).max(50)),
  // Reject future dates: a saldo "as of tomorrow" would include unposted
  // future entries (if any) and mislead the bookkeeper about the true
  // pre-entry state of the ledger. Compared in Europe/Stockholm so a Swedish
  // bookkeeper working in the 00:00-02:00 CET window (after midnight UTC has
  // not yet passed) isn't rejected for entering their local today's date.
  as_of: isoDate.refine(
    (d) => d <= new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Stockholm' }),
    { message: 'as_of cannot be in the future' },
  ),
})

// ============================================================
// VAT validation schemas
// ============================================================

export const ValidateVatNumberSchema = z.object({
  vat_number: z.string().min(4, 'VAT number must be at least 4 characters'),
  customer_id: uuid.optional(),
})

// ============================================================
// Pagination schemas
// ============================================================

export const PaginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
})

// ============================================================
// Event log schemas
// ============================================================

export const EventsQuerySchema = z.object({
  after: z.coerce.number().int().nonnegative().optional(),
  types: z.string()
    .transform(s => s.split(',').map(t => t.trim()).filter(Boolean))
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

// ============================================================
// Pending operations schemas
// ============================================================

export const PendingOperationsQuerySchema = z.object({
  // 'failed_partial' is queryable directly; the UI folds it into the
  // rejected tab (see app/api/pending-operations/route.ts).
  status: z.enum(['pending', 'committed', 'rejected', 'failed_partial']).default('pending'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
  // Newest first by default; a bokslut batch of fifty operations is worked
  // oldest first, so the queue can be flipped.
  order: z.enum(['asc', 'desc']).default('desc'),
})

export const PendingOperationsBulkSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(100),
})

// Bulk reject: same id list plus the optional category/reason pair from the
// single reject route. When provided they are applied to every rejected row.
export const PendingOperationsBulkRejectSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(100),
  rejection_category: z
    .enum(['wrong_category', 'wrong_amount', 'duplicate', 'wrong_period', 'other'])
    .optional(),
  rejection_reason: z.string().max(2000).optional(),
})

// ============================================================
// Audit trail schemas
// ============================================================

// `satisfies` keeps every filter value a member of the AuditAction union —
// adding a bogus value here fails the typecheck.
const auditActions = [
  'INSERT', 'UPDATE', 'DELETE', 'COMMIT', 'REVERSE', 'CORRECT',
  'LOCK_PERIOD', 'CLOSE_PERIOD', 'DOCUMENT_DELETE_BLOCKED',
  'RETENTION_BLOCK', 'SECURITY_EVENT', 'INTEGRITY_FAILURE',
  'COMMITTED_AT_OVERRIDE',
] as const satisfies readonly AuditAction[]

export const AuditTrailQuerySchema = z.object({
  action: z.enum(auditActions).optional(),
  table_name: z.string().min(1).optional(),
  record_id: z.string().min(1).optional(),
  from_date: isoDate.optional(),
  to_date: isoDate.optional(),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(200).default(50),
})

/**
 * GET /api/reports/behandlingshistorik (BFL 5 kap. 11 §). period_id is the
 * fiscal period; from_date/to_date narrow to a sub-range inside it (validated
 * against the period bounds by the route, like the other fiscal-range reports).
 */
export const BehandlingshistorikQuerySchema = z.object({
  period_id: z.string().min(1),
  from_date: isoDate.optional(),
  to_date: isoDate.optional(),
  category: z
    .enum(['verifikation', 'kontoplan', 'installningar', 'period', 'import', 'atkomst', 'ovrigt'])
    .optional(),
  format: z.enum(['json', 'csv', 'xlsx', 'pdf']).default('json'),
})

// ============================================================
// Voucher gap schemas
// ============================================================

export const VoucherGapQuerySchema = z.object({
  fiscal_period_id: uuid,
  voucher_series: z.string().regex(/^[A-Z]$/, 'Verifikationsserie måste vara en bokstav A-Z').optional(),
})

export const SaveGapExplanationSchema = z.object({
  fiscal_period_id: uuid,
  voucher_series: z.string().default('A'),
  gap_start: z.number().int().positive(),
  gap_end: z.number().int().positive(),
  explanation: z.string().min(1).max(500),
})

// ============================================================
// Opening balance import schemas
// ============================================================

export const OpeningBalanceExecuteSchema = z.object({
  fiscal_period_id: uuid,
  lines: z.array(z.object({
    account_number: accountNumber,
    debit_amount: nonNegativeAmount,
    credit_amount: nonNegativeAmount,
  })).min(2, 'At least two lines are required for double-entry'),
})

export const OpeningBalanceCorrectSchema = OpeningBalanceExecuteSchema.extend({
  // Also apply the correction's per-account delta to subsequent years' linked
  // IB verifikat (Fortnox/SIE migrations book one IB per imported year).
  cascade: z.boolean().optional(),
})

/**
 * Inline (no-storno) IB correction: strike changed lines and add replacements
 * inside the SAME verifikat, BFL 5 kap 5 § track 2. Only for open, unlocked
 * years; the correct_entry_lines_inline RPC enforces the full envelope.
 */
export const OpeningBalanceCorrectInlineSchema = z
  .object({
    fiscal_period_id: uuid,
    strike_line_ids: z.array(uuid).max(200).default([]),
    new_lines: z.array(InlineRattelseLineSchema).max(100).default([]),
    cascade: z.boolean().optional(),
  })
  .refine((body) => body.strike_line_ids.length > 0 || body.new_lines.length > 0, {
    message: 'Rättelsen måste stryka eller lägga till minst en rad',
  })

// ============================================================
// Register import schemas (customers, suppliers)
// ============================================================

const ImportedCustomerRowSchema = z.object({
  row_index: z.number().int(),
  name: z.string().min(1),
  customer_type: CustomerTypeSchema,
  org_number: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  address_line1: z.string().nullable(),
  address_line2: z.string().nullable(),
  postal_code: z.string().nullable(),
  city: z.string().nullable(),
  country: countryCode,
  vat_number: z.string().nullable(),
  default_payment_terms: z.number().int().min(0).max(365),
  notes: z.string().nullable(),
}).superRefine((row, ctx) => {
  // The preview flags these rows and the wizard refuses to continue with
  // them; repeated here so a hand-built request cannot import an EU
  // business with country SE (#2025).
  const countryIssue = checkCountryConsistency({
    partyType: row.customer_type,
    country: row.country,
    vatNumber: row.vat_number,
  })
  if (countryIssue) {
    ctx.addIssue({ code: 'custom', path: ['country'], message: COUNTRY_CONSISTENCY_MESSAGES[countryIssue].en })
  }
})

export const CustomerImportExecuteSchema = z.object({
  rows: z.array(ImportedCustomerRowSchema).min(1, 'At least one row is required'),
  update_duplicates: z.boolean(),
})

const ImportedSupplierRowSchema = z.object({
  row_index: z.number().int(),
  name: z.string().min(1),
  supplier_type: SupplierTypeSchema,
  org_number: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  address_line1: z.string().nullable(),
  address_line2: z.string().nullable(),
  postal_code: z.string().nullable(),
  city: z.string().nullable(),
  country: countryCode,
  vat_number: z.string().nullable(),
  bankgiro: z.string().nullable(),
  plusgiro: z.string().nullable(),
  bank_account: z.string().nullable(),
  iban: z.string().nullable(),
  bic: z.string().nullable(),
  default_payment_terms: z.number().int().min(0).max(365),
  default_currency: z.string(),
  notes: z.string().nullable(),
})

export const SupplierImportExecuteSchema = z.object({
  rows: z.array(ImportedSupplierRowSchema).min(1, 'At least one row is required'),
  update_duplicates: z.boolean(),
})

const ImportedArticleRowSchema = z.object({
  row_index: z.number().int(),
  name: z.string().min(1),
  name_en: z.string().nullable(),
  article_number: z.string().nullable(),
  type: ArticleTypeSchema,
  unit: z.string(),
  price_excl_vat: nonNegativeAmount,
  // ISO 4217 shape only; the execute route validates against the currencies
  // table and drops unknown codes (mirrors revenue_account). Optional so rows
  // parsed before this field existed still validate.
  currency: z.string().regex(/^[A-Z]{3}$/).nullable().optional(),
  vat_rate: vatRatePercent,
  // The execute route re-validates against the chart of accounts (and drops
  // unknown/inactive overrides), so a loose nullable string is enough here.
  revenue_account: z.string().nullable(),
  cost_price: nonNegativeAmount.nullable(),
  ean: z.string().nullable(),
  housework_type: z.string().nullable(),
  notes: z.string().nullable(),
})

export const ArticleImportExecuteSchema = z.object({
  rows: z.array(ImportedArticleRowSchema).min(1, 'At least one row is required'),
  update_duplicates: z.boolean(),
})

// Validates the optional column-mapping override posted to the parse route, so
// a malformed/hostile blob can't drive the parser with non-numeric or
// unexpected column indices. Mirrors DetectedArticleColumns.
const articleColumnIndex = z.number().int().min(0).nullable()
export const ArticleColumnOverridesSchema = z.object({
  name_col: z.number().int().min(0),
  article_number_col: articleColumnIndex,
  name_en_col: articleColumnIndex,
  type_col: articleColumnIndex,
  unit_col: articleColumnIndex,
  price_col: articleColumnIndex,
  // Optional + defaulted so a mapping payload from a client rendered before
  // this column existed still validates.
  currency_col: articleColumnIndex.optional().default(null),
  vat_rate_col: articleColumnIndex,
  revenue_account_col: articleColumnIndex,
  cost_price_col: articleColumnIndex,
  ean_col: articleColumnIndex,
  housework_type_col: articleColumnIndex,
  notes_col: articleColumnIndex,
  confidence: z.number(),
})

// ============================================================
// Salary schemas
// ============================================================

export const EmploymentTypeSchema = z.enum(['employee', 'company_owner', 'board_member'])
export const SalaryTypeSchema = z.enum(['monthly', 'hourly'])
export const FSkattStatusSchema = z.enum(['a_skatt', 'f_skatt', 'fa_skatt', 'not_verified'])
export const VacationRuleSchema = z.enum(['procentregeln', 'sammaloneregeln', 'none', 'semesterersattning'])

export const SalaryLineItemTypeSchema = z.enum([
  'monthly_salary', 'hourly_salary',
  'overtime', 'overtime_50', 'overtime_100',
  'ob_weekday_evening', 'ob_weekend', 'ob_night', 'ob_holiday',
  'bonus', 'commission',
  'gross_deduction_pension', 'gross_deduction_other',
  'benefit_car', 'benefit_housing', 'benefit_meals', 'benefit_wellness', 'benefit_bike', 'benefit_other',
  'sick_karens', 'sick_day2_14', 'sick_day15_plus',
  'vab', 'parental_leave', 'vacation', 'semesterersattning',
  'traktamente_taxfree', 'traktamente_taxable',
  'mileage_taxfree', 'mileage_taxable',
  'expense_reimbursement',
  'net_deduction_advance', 'net_deduction_union', 'net_deduction_benefit_payment',
  'net_deduction_other',
  'oresavrundning',
  'correction', 'other',
])

// Base employee object (no refinements, safe for .partial())
const EmployeeSchemaBase = z.object({
  first_name: z.string().min(1).max(200),
  last_name: z.string().min(1).max(200),
  personnummer: z.string().regex(/^\d{12}$/, 'Personnummer måste vara 12 siffror (ÅÅÅÅMMDDNNNN)'),
  employment_type: EmploymentTypeSchema.default('employee'),
  employment_start: isoDate,
  employment_end: isoDate.optional(),
  employment_degree: z.number().min(1).max(100).default(100),
  // Arbetsschema-lite: weekly schedule driving the hourly/daily divisors
  // (legacy 173/21 at the defaults). employment_degree keeps prorating base
  // salary; these ONLY drive divisors.
  hours_per_week: z.number().positive().max(80).default(40),
  workdays_per_week: z.number().min(1).max(7).default(5),
  salary_type: SalaryTypeSchema.default('monthly'),
  monthly_salary: z.number().nonnegative().optional(),
  hourly_rate: z.number().nonnegative().optional(),
  tax_table_number: z.number().int().min(29).max(42).optional(),
  tax_column: z.number().int().min(1).max(6).default(1),
  tax_municipality: z.string().max(100).optional(),
  is_sidoinkomst: z.boolean().default(false),
  f_skatt_status: FSkattStatusSchema.default('a_skatt'),
  clearing_number: z.string().max(10).optional(),
  bank_account_number: z.string().max(20).optional(),
  vacation_rule: VacationRuleSchema.default('procentregeln'),
  vacation_days_per_year: z.number().int().min(25).max(40).default(25),
  semestertillagg_rate: z.number().min(0).max(0.05).default(0.0043),
  email: z.string().email().optional(),
  phone: z.string().max(20).optional(),
  address_line1: z.string().max(200).optional(),
  postal_code: z.string().max(10).optional(),
  city: z.string().max(100).optional(),
  vaxa_stod_eligible: z.boolean().default(false),
  vaxa_stod_start: isoDate.optional(),
  vaxa_stod_end: isoDate.optional(),
  // Jämkning (Skatteverket beslut om ändrad beräkning av skatteavdrag):
  // overrides the tax-table lookup with a fixed percentage for a bounded
  // period. Fields have existed on the employees table since the salary
  // module shipped; this exposes the write path (payroll gap-closure 1.5).
  // Setting jamkning_percentage to null clears the beslut.
  jamkning_percentage: z.number().min(0).max(100).nullable().optional(),
  jamkning_valid_from: isoDate.nullable().optional(),
  jamkning_valid_to: isoDate.nullable().optional(),
  // Dimensions PR8: bag applied to the employee's P&L cost lines when a
  // salary run is booked. {} clears (the UI always sends the field).
  default_dimensions: DimensionsBagSchema.optional(),
})

export const CreateEmployeeSchema = EmployeeSchemaBase.superRefine((data, ctx) => {
  // Salary amount required based on salary_type
  if (data.salary_type === 'monthly' && (data.monthly_salary === undefined || data.monthly_salary === null || data.monthly_salary <= 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Månadslön krävs och måste vara större än 0 för månadslöneform',
      path: ['monthly_salary'],
    })
  }
  if (data.salary_type === 'hourly' && (data.hourly_rate === undefined || data.hourly_rate === null || data.hourly_rate <= 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Timlön krävs och måste vara större än 0 för timlöneform',
      path: ['hourly_rate'],
    })
  }

  // Tax table required for A-skatt employees (not sidoinkomst)
  if (data.f_skatt_status === 'a_skatt' && !data.is_sidoinkomst && !data.tax_table_number) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Skattetabell krävs för A-skatt anställda (baseras på folkbokföringskommun)',
      path: ['tax_table_number'],
    })
  }

  // Tax municipality recommended when tax table is set
  if (data.tax_table_number && !data.tax_municipality) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Folkbokföringskommun bör anges för att dokumentera skattetabellens underlag',
      path: ['tax_municipality'],
    })
  }

  // Phase 5 PR-1 carry-over (PR-2 enforcement): if vaxa_stod_eligible is set,
  // require vaxa_stod_start. The end date is optional (some eligibility
  // windows run open-ended until the maximum benefit period is reached).
  // Birth-year age gate (the actual eligibility rule, born 2003-2007 for
  // 2026) is checked at calculation-time by the engine, not here, because
  // it depends on the payment year of each run: a 22-year-old at hire
  // becomes 23 the next year and the rate switches without a row edit.
  if (data.vaxa_stod_eligible && !data.vaxa_stod_start) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Startdatum för Växa-stöd måste anges när Växa-stöd är aktiverat',
      path: ['vaxa_stod_start'],
    })
  }
  if (
    data.vaxa_stod_start &&
    data.vaxa_stod_end &&
    data.vaxa_stod_end < data.vaxa_stod_start
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Växa-stödets slutdatum måste vara efter startdatumet',
      path: ['vaxa_stod_end'],
    })
  }

  // Jämkning: the engine (isJamkningValid in lib/salary/calculation-engine.ts)
  // applies the beslut only when BOTH dates are set, so a percentage needs
  // both a start and an end date on every write path (#2058). The create body
  // is the whole row, so the shared validator sees the final state here.
  for (const issue of validateJamkning(data)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue.message, path: [issue.field] })
  }

  // Bank details: validate clearing/kontonummer structure at entry so a typo is
  // caught here rather than at Bankgirot LB generation. Both empty is allowed.
  // Update path is validated in the PATCH route (only when the fields actually
  // change) so legacy employees with incomplete free-text bank data can still
  // be edited in unrelated ways.
  for (const bankIssue of validateEmployeeBankAccount(data.clearing_number, data.bank_account_number)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: bankIssue.message,
      path: [bankIssue.field],
    })
  }
})

// PATCH base: the create-schema defaults are stripped first. Zod 4 applies
// .default() even through .partial() (absent key -> default value), which
// would (a) make sparse PATCH bodies fail the salary-type refinement below
// (salary_type materializes as 'monthly' without monthly_salary present) and
// (b) leak default values into routes that spread the parsed body into the
// UPDATE (silently resetting e.g. is_sidoinkomst on unrelated edits).
const EmployeeSchemaPatchBase = EmployeeSchemaBase.extend({
  employment_type: EmploymentTypeSchema,
  employment_degree: z.number().min(1).max(100),
  hours_per_week: z.number().positive().max(80),
  workdays_per_week: z.number().min(1).max(7),
  salary_type: SalaryTypeSchema,
  tax_column: z.number().int().min(1).max(6),
  is_sidoinkomst: z.boolean(),
  f_skatt_status: FSkattStatusSchema,
  vacation_rule: VacationRuleSchema,
  vacation_days_per_year: z.number().int().min(25).max(40),
  semestertillagg_rate: z.number().min(0).max(0.05),
  vaxa_stod_eligible: z.boolean(),
})

export const UpdateEmployeeSchema = EmployeeSchemaPatchBase.partial().superRefine((data, ctx) => {
  // Only validate salary when salary_type is being changed in this update
  if (data.salary_type === 'monthly' && data.monthly_salary !== undefined && data.monthly_salary <= 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Månadslön måste vara större än 0 för månadslöneform',
      path: ['monthly_salary'],
    })
  }
  if (data.salary_type === 'hourly' && data.hourly_rate !== undefined && data.hourly_rate <= 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Timlön måste vara större än 0 för timlöneform',
      path: ['hourly_rate'],
    })
  }

  // If setting salary_type, require the corresponding salary field
  if (data.salary_type === 'monthly' && !('monthly_salary' in data)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Månadslön måste anges vid byte till månadslöneform',
      path: ['monthly_salary'],
    })
  }
  if (data.salary_type === 'hourly' && !('hourly_rate' in data)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Timlön måste anges vid byte till timlöneform',
      path: ['hourly_rate'],
    })
  }

  // Växa-stöd schema-level consistency check. The schema can only see what
  // the PATCH body carries; the route layer is responsible for merged-
  // state validation (i.e. an existing employee with vaxa_stod_start
  // already set can have vaxa_stod_eligible flipped on without also
  // sending start in the body). What the schema CAN enforce:
  //   - If the body enables vaxa_stod AND clears vaxa_stod_start explicitly
  //     (sending null), reject: that would orphan the eligibility flag.
  //   - If the body sets vaxa_stod_eligible=true AND vaxa_stod_start is
  //     present in the body but invalid relative to vaxa_stod_end, reject.
  // The first case isn't currently expressible via .partial() (null != absent),
  // so the practical schema-level check is the second one. The route
  // layer will add a merged-state check when needed.
  if (
    data.vaxa_stod_eligible === true &&
    'vaxa_stod_start' in data &&
    !data.vaxa_stod_start
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Startdatum för Växa-stöd måste anges när Växa-stöd är aktiverat',
      path: ['vaxa_stod_start'],
    })
  }
  if (
    data.vaxa_stod_start &&
    data.vaxa_stod_end &&
    data.vaxa_stod_end < data.vaxa_stod_start
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Växa-stödets slutdatum måste vara efter startdatumet',
      path: ['vaxa_stod_end'],
    })
  }

  // Jämkning: same schema-visibility caveat as växa-stöd above. A non-null
  // percentage sent WITHOUT dates in the same body is only valid if the dates
  // already exist on the row, so the route layer runs validateJamkning on the
  // merged state. Within-body date ordering is checkable here: pass the
  // percentage as null so only the ordering rule fires.
  for (const issue of validateJamkning({ ...data, jamkning_percentage: null })) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue.message, path: [issue.field] })
  }
})

export const EmployeeBenefitTypeSchema = z.enum(['bike', 'car', 'meals', 'housing', 'wellness', 'other'])

/**
 * Mirrors the table-level CHECK on employee_benefits (migration
 * 20260512200100_employee_benefits.sql):
 *
 *   CHECK (valid_to IS NULL OR valid_to >= valid_from)
 *
 * The bound is INCLUSIVE (`>=`): valid_to === valid_from is a legal single-day
 * benefit, and the run-calculation window is inclusive at both ends too
 * (`valid_from <= payment_date` AND `valid_to IS NULL OR valid_to >=
 * payment_date`, lib/salary/run-calculation.ts). A NULL/omitted valid_to means
 * an open-ended benefit and stays legal. Only a strictly earlier valid_to is
 * rejected. Shared with the routes so the schema 400 and the route's
 * merged-state 400 say the same thing.
 */
export const BENEFIT_PERIOD_ORDER_MESSAGE =
  '"Gäller till" måste vara samma dag som eller efter "Gäller från". Lämna fältet tomt för en löpande förmån.'

export const CreateEmployeeBenefitSchema = z.object({
  benefit_type: EmployeeBenefitTypeSchema,
  description: z.string().min(1).max(200),
  monthly_value: z.number().nonnegative().optional(),
  /** For bike benefit: annual market value of the förmån. The server computes
   * monthly_value = max(0, annual − 3000) / 12 per Skatteverket schablon. */
  annual_market_value: z.number().nonnegative().optional(),
  valid_from: isoDate,
  valid_to: isoDate.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  is_active: z.boolean().optional(),
}).superRefine((data, ctx) => {
  if (data.benefit_type === 'bike') {
    if (data.annual_market_value === undefined && data.monthly_value === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Cykelförmån kräver årligt marknadsvärde',
        path: ['annual_market_value'],
      })
    }
  } else if (data.monthly_value === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Månatligt förmånsvärde krävs',
      path: ['monthly_value'],
    })
  }

  // Validity period: exact mirror of the DB CHECK (see
  // BENEFIT_PERIOD_ORDER_MESSAGE). Both dates are always fully visible on a
  // create, so the whole constraint is checkable here and the insert can no
  // longer trip the CHECK and surface as an opaque 500. ISO YYYY-MM-DD strings
  // order lexicographically the same as chronologically, so a plain `<` is
  // exact; `=== undefined` keeps the open-ended case legal.
  if (data.valid_to !== undefined && data.valid_to < data.valid_from) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: BENEFIT_PERIOD_ORDER_MESSAGE,
      path: ['valid_to'],
    })
  }
})

export const UpdateEmployeeBenefitSchema = z.object({
  description: z.string().min(1).max(200).optional(),
  monthly_value: z.number().nonnegative().optional(),
  annual_market_value: z.number().nonnegative().optional(),
  valid_from: isoDate.optional(),
  valid_to: isoDate.nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  is_active: z.boolean().optional(),
}).superRefine((data, ctx) => {
  // Same DB CHECK mirror as the create schema, with the .partial() caveat: an
  // all-optional body only lets the schema compare the two dates when it
  // carries BOTH. A single-date PATCH has nothing in-body to compare against
  // (the other half lives on the stored row), so the route re-checks the merged
  // stored+patched pair before it writes. `valid_to: null` clears the end date
  // and stays legal, exactly as `valid_to IS NULL` is in the CHECK.
  if (
    data.valid_from !== undefined &&
    data.valid_to !== undefined &&
    data.valid_to !== null &&
    data.valid_to < data.valid_from
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: BENEFIT_PERIOD_ORDER_MESSAGE,
      path: ['valid_to'],
    })
  }
})

export const RecurringLineItemTypeSchema = z.enum([
  'gross_deduction_pension',
  'gross_deduction_other',
  'net_deduction_union',
  'net_deduction_benefit_payment',
  'net_deduction_other',
])

/** Same inclusive-bound semantics as BENEFIT_PERIOD_ORDER_MESSAGE, for
 * employee_recurring_lines (migration 20260902140000). */
export const RECURRING_LINE_PERIOD_ORDER_MESSAGE =
  '"Gäller till" måste vara samma dag som eller efter "Gäller från". Lämna fältet tomt för en löpande rad.'

const recurringLineAmountIssue = (
  data: { item_type?: string; amount?: number },
  ctx: z.RefinementCtx,
) => {
  // Mirrors the employee_recurring_lines_amount_sign CHECK: every supported
  // type is a deduction and must be negative. Kept in the schema so the
  // violation is a field-level 400 instead of a Postgres 23514.
  if (data.amount === undefined || data.item_type === undefined) return
  const bad = data.amount >= 0
  if (bad) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Avdragsrader måste ha negativt belopp och tilläggsrader positivt belopp.',
      path: ['amount'],
    })
  }
}

export const CreateEmployeeRecurringLineSchema = z.object({
  item_type: RecurringLineItemTypeSchema,
  description: z.string().min(1).max(200),
  amount: z.number(),
  account_number: accountNumberSchema.optional(),
  valid_from: isoDate,
  valid_to: isoDate.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  is_active: z.boolean().optional(),
}).superRefine((data, ctx) => {
  recurringLineAmountIssue(data, ctx)
  if (data.valid_to !== undefined && data.valid_to < data.valid_from) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: RECURRING_LINE_PERIOD_ORDER_MESSAGE,
      path: ['valid_to'],
    })
  }
})

/** item_type is not patchable (like benefit_type): the sign rule and derived
 * flags key off it, so changing kind means delete + recreate. The route
 * re-checks the amount sign and merged date pair against the stored row. */
export const UpdateEmployeeRecurringLineSchema = z.object({
  description: z.string().min(1).max(200).optional(),
  amount: z.number().optional(),
  account_number: accountNumberSchema.nullable().optional(),
  valid_from: isoDate.optional(),
  valid_to: isoDate.nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  is_active: z.boolean().optional(),
}).superRefine((data, ctx) => {
  if (
    data.valid_from !== undefined &&
    data.valid_to !== undefined &&
    data.valid_to !== null &&
    data.valid_to < data.valid_from
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: RECURRING_LINE_PERIOD_ORDER_MESSAGE,
      path: ['valid_to'],
    })
  }
})

export const CreateSalaryRunSchema = z.object({
  period_year: z.number().int().min(2020).max(2100),
  period_month: z.number().int().min(1).max(12),
  payment_date: isoDate,
  voucher_series: z.string().regex(/^[A-Z]$/, 'Verifikationsserie måste vara en bokstav A-Z').default('A'),
  notes: z.string().max(2000).optional(),
})

// One-click variant for the dashboard route: all fields optional — the route
// resolves defaults server-side (period = month after the latest
// non-corrected run, payment date from company_settings.salary_pay_day,
// series from the per-source-type map), so "Starta lönekörning" can POST {}.
// The v1 REST surface keeps the strict CreateSalaryRunSchema above (it
// inserts the fields verbatim and must 400 on omissions, not 500).
export const CreateSalaryRunWithDefaultsSchema = z.object({
  period_year: z.number().int().min(2020).max(2100).optional(),
  period_month: z.number().int().min(1).max(12).optional(),
  payment_date: isoDate.optional(),
  voucher_series: z.string().regex(/^[A-Z]$/, 'Verifikationsserie måste vara en bokstav A–Z').optional(),
  notes: z.string().max(2000).optional(),
})

export const AddEmployeeToRunSchema = z.object({
  employee_id: uuid,
  hours_worked: z.number().nonnegative().optional(),
})

export const CreateSalaryLineItemSchema = z.object({
  salary_run_employee_id: uuid,
  // 'oresavrundning' is derived-only: the calculator writes it from the
  // engine's netRounding and the booking excludes it from the gross
  // reconciliation, so a manually created row would unbalance the salary
  // verifikat by exactly its amount (the DB balance trigger then rejects the
  // booking). Every other derived type is absorbed by the base remainder and
  // stays harmless to create by hand.
  item_type: SalaryLineItemTypeSchema.exclude(['oresavrundning']),
  description: z.string().min(1).max(500),
  quantity: z.number().optional(),
  unit_price: z.number().optional(),
  amount: z.number(),
  is_taxable: z.boolean().default(true),
  is_avgift_basis: z.boolean().default(true),
  is_vacation_basis: z.boolean().default(true),
  is_gross_deduction: z.boolean().default(false),
  is_net_deduction: z.boolean().default(false),
  account_number: accountNumber.optional(),
  sort_order: z.number().int().default(0),
})

export const UpdateSalaryLineItemSchema = CreateSalaryLineItemSchema.partial().omit({ salary_run_employee_id: true })

// ── Absence (frånvaro) per-day records ──────────────────────────────
//
// Drives sjuklönelagen calculations (karensavdrag boundary, återinsjuknande
// 5-day merge, högriskskydd 12-month cap, day 14/15 FK transition) and AGI
// 2025+ <Frånvarouppgift> per-event reporting. The salary calculator derives
// line items from these rows; users do not enter absence as line items.

export const AbsenceTypeSchema = z.enum([
  'sick',
  'vab',
  'parental',
  'pregnancy',
  'care_relative',
  'study',
  'unpaid_leave',
  'other_leave',
])

export const UpsertAbsenceDaySchema = z.object({
  absence_date: isoDate,
  absence_type: AbsenceTypeSchema,
  hours: z.number().positive().max(24).default(8),
  notes: z.string().max(2000).optional(),
  salary_run_employee_id: uuid.optional(),
})

export const AbsenceRangeQuerySchema = z.object({
  from: isoDate,
  to: isoDate,
}).refine((data) => data.from <= data.to, {
  message: '`from` måste vara före eller lika med `to`',
  path: ['from'],
})

// ── Employee opening balances (payroll cutover) ─────────────────────
//
// Per-employee state a mid-year switcher brings from the previous payroll
// system: YTD accumulators, vacation balances (incl. sparade dagar by origin
// year per the Semesterlagen 5-year rule), the opening semesterlöneskuld SEK
// (feeds vacation-liability report only; the 2920/2940 balance arrived via
// SIE), and the högriskskydd karens-count adjustment. See migration
// 20260713101000.

const openingBalancesShape = {
  cutover_date: isoDate,
  ytd_gross: z.number().min(0).default(0),
  ytd_tax: z.number().min(0).default(0),
  ytd_net: z.number().min(0).default(0),
  vacation_paid_days_remaining: z.number().min(0).max(40).default(0),
  // Paid days already taken in the CURRENT vacation year under the previous
  // system. The ledger's cutover-year row derives entitled = remaining +
  // taken_this_year and folds this into taken_days; remaining keeps meaning
  // "remaining at cutover".
  vacation_days_taken_this_year: z.number().min(0).max(40).default(0),
  vacation_saved_days_by_year: z
    .record(fiscalYearSchema, z.number().min(0).max(40))
    .default({}),
  opening_semester_liability: z.number().min(0).default(0),
  opening_semester_liability_avgifter: z.number().min(0).default(0),
  karens_periods_adjustment: z.number().int().min(0).max(10).default(0),
}

const openingBalancesRefine = (
  data: {
    cutover_date: string
    ytd_gross: number
    ytd_tax: number
    vacation_saved_days_by_year: Record<string, number>
  },
  ctx: z.RefinementCtx,
) => {
    if (!data.cutover_date.endsWith('-01')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'cutover_date måste vara den första dagen i en månad',
        path: ['cutover_date'],
      })
    }
    const cutoverYear = Number(data.cutover_date.slice(0, 4))
    const currentYear = new Date().getFullYear()
    if (cutoverYear < currentYear - 1 || cutoverYear > currentYear) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'cutover_date måste ligga i innevarande eller föregående år',
        path: ['cutover_date'],
      })
    }
    if (data.ytd_tax > data.ytd_gross) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'ytd_tax kan inte överstiga ytd_gross',
        path: ['ytd_tax'],
      })
    }
    // Sparade dagar: max 5 years back, never the cutover year itself.
    for (const yearKey of Object.keys(data.vacation_saved_days_by_year)) {
      const originYear = Number(yearKey)
      if (originYear < cutoverYear - 5 || originYear > cutoverYear - 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Sparade dagar för ${yearKey}: ursprungsåret måste ligga inom 5 år före cutover (${cutoverYear - 5}-${cutoverYear - 1})`,
          path: ['vacation_saved_days_by_year', yearKey],
        })
      }
    }
}

/** Body for the per-employee PUT (employee id comes from the path). */
export const OpeningBalancesFieldsSchema = z
  .object(openingBalancesShape)
  .superRefine(openingBalancesRefine)

/** One item in the bulk PUT (employee id inline). */
export const OpeningBalancesItemSchema = z
  .object({ employee_id: uuid, ...openingBalancesShape })
  .superRefine(openingBalancesRefine)

export const OpeningBalancesBulkSchema = z.object({
  items: z.array(OpeningBalancesItemSchema).min(1).max(200),
})

// ── Worked-hours per-day records (hourly employees) ─────────────────
//
// Drives base salary calculation for hourly (timanställd) employees:
// `baseSalary = hourly_rate × Σ hours`. Mirrors absence days deliberately:
// same calendar UX, half-day mixing with absence enforced by the 24h cap
// trigger. The calculator sums these per pay period at calculate time.

export const UpsertWorkedDaySchema = z
  .object({
    work_date: isoDate,
    hours: z.number().positive().max(24).default(8),
    notes: z.string().max(2000).optional(),
    salary_run_employee_id: uuid.optional(),
    // Optional shift window. Feeds the shift-premium engine: without explicit
    // times, the engine assumes a default 08:00-17:00 day shift. Either both
    // fields are provided or neither.
    start_time: timeString.optional(),
    end_time: timeString.optional(),
  })
  .refine(
    (data) => (data.start_time == null && data.end_time == null) || (data.start_time != null && data.end_time != null),
    {
      message: 'Ange både start- och sluttid eller låt båda vara tomma',
      path: ['start_time'],
    },
  )

export const WorkedHoursRangeQuerySchema = z.object({
  from: isoDate,
  to: isoDate,
}).refine((data) => data.from <= data.to, {
  message: '`from` måste vara före eller lika med `to`',
  path: ['from'],
})

export const BatchUpsertWorkedDaysSchema = z
  .object({
    // 100-row sanity cap: typical use is one pay period (~22 weekdays). A larger
    // value usually indicates the caller is iterating wrong.
    dates: z.array(isoDate).min(1).max(100),
    hours: z.number().positive().max(24).default(8),
    notes: z.string().max(2000).optional(),
    salary_run_employee_id: uuid.optional(),
    // Optional shift window applied to every date in the batch. Pair both or
    // neither; same fallback behaviour as the single-row endpoint.
    start_time: timeString.optional(),
    end_time: timeString.optional(),
  })
  .refine(
    (data) => (data.start_time == null && data.end_time == null) || (data.start_time != null && data.end_time != null),
    {
      message: 'Ange både start- och sluttid eller låt båda vara tomma',
      path: ['start_time'],
    },
  )

export const AttachDocumentSchema = z.object({
  document_id: uuid,
})

export const LinkDocumentSchema = z.object({
  journal_entry_id: uuid,
  journal_entry_line_id: uuid.optional(),
  inbox_item_id: uuid.optional(),
  transaction_id: uuid.optional(),
})

/**
 * Underlag import preview: filenames only, never file contents. The plan is
 * built from the voucher reference in each name, so the bytes stay in the
 * browser until the user has approved where each file will land.
 *
 * `fiscal_period_id` is required, not optional: a filename carries no year and
 * source systems restart voucher numbering annually, so a plan with no declared
 * year cannot identify a verifikat at all.
 */
export const UnderlagImportPreviewSchema = z.object({
  file_names: z.array(z.string().min(1).max(400)).min(1).max(2000),
  fiscal_period_id: uuid,
})

/**
 * Per-employee override on a salary run (advanced mode).
 *
 * Each field is independently nullable. `null` clears a previously-set
 * override; `undefined` leaves it unchanged. `reason` is required whenever
 * any non-null override is being applied: the DB CHECK constraint
 * enforces this at the storage layer too.
 */
// Upper bound on per-employee override values. 10 MSEK is well above any
// plausible single-period gross/tax/avgifter figure for a salary run and
// catches typos (e.g. an extra zero) before they reach the ledger or AGI.
export const SALARY_OVERRIDE_MAX = 10_000_000

export const SalaryEmployeeOverrideSchema = z
  .object({
    // Per-run monthly salary for this employee, editable while the run is a
    // draft. 0 is allowed (an intentional nollkörning). This is NOT a review
    // override: it sets the base the engine uses for this month only and does
    // not require a reason. The route gates this field to `draft` status.
    monthly_salary: z.number().nonnegative().max(SALARY_OVERRIDE_MAX).optional(),
    // Skatteavdrag is stated in whole kronor (öretal bortfaller, SFF
    // 2011:1261 22 kap. 1 §) and the engine's own values already are: an
    // öre-bearing override would book 2710 with öre that the whole-krona
    // skattekonto draw never clears.
    tax_withheld_override: z
      .number()
      .int('Skatteavdrag anges i hela kronor (öretal bortfaller)')
      .nonnegative()
      .max(SALARY_OVERRIDE_MAX)
      .nullable()
      .optional(),
    avgifter_amount_override: z.number().nonnegative().max(SALARY_OVERRIDE_MAX).nullable().optional(),
    avgifter_basis_override: z.number().nonnegative().max(SALARY_OVERRIDE_MAX).nullable().optional(),
    reason: z.string().min(1).max(500).nullable().optional(),
  })
  .refine(
    (data) => {
      const hasOverride =
        (data.tax_withheld_override !== undefined && data.tax_withheld_override !== null) ||
        (data.avgifter_amount_override !== undefined && data.avgifter_amount_override !== null) ||
        (data.avgifter_basis_override !== undefined && data.avgifter_basis_override !== null)
      if (hasOverride && (data.reason === undefined || data.reason === null || data.reason.trim() === '')) {
        return false
      }
      return true
    },
    {
      message: 'Ange en anledning till justeringen (krävs av BFL för manuella skattejusteringar)',
      path: ['reason'],
    },
  )


// ============================================================
// Dimensions PR6: bulk retro-tagging workbench (appended at end
// of file by PR6 to avoid conflicts; keep new schemas below).
// ============================================================

/**
 * Query filters for GET /api/dimensions/tagging/lines (the BulkTagWorkbench
 * line browser). All filters optional; `limit` is a hard cap (default 200,
 * max 500): the route fetches limit+1 and reports `total_capped` instead of
 * paginating (dimensions plan §3, v1 scope).
 */
export const DimensionTaggingLinesQuerySchema = z.object({
  period_id: uuid.optional(),
  date_from: saneIsoDate.optional(),
  date_to: saneIsoDate.optional(),
  account_from: accountNumber.optional(),
  account_to: accountNumber.optional(),
  /** Free-text ilike filter on journal_entries.description. */
  text: z.string().trim().max(200).optional(),
  /** '1' → only vouchers with at least one untagged line ({} dimensions). */
  only_untagged: z.enum(['0', '1']).optional(),
  /**
   * '1' → include reversal pairs (annulled entries + their stornos). Excluded
   * by default: a pair nets to zero in every dimension bucket when both sides
   * carry the same tag, so retro-tagging it is a no-op, and showing it
   * invites tagging one side only, which skews project P&L.
   */
  include_annulled: z.enum(['0', '1']).optional(),
  /** Cap counts VOUCHERS since the voucher-level rework. */
  limit: z.coerce.number().int().min(1).max(300).default(150),
})

/**
 * Body for POST /api/dimensions/tagging/apply. One dimensions object applied
 * to every listed line via the retag_line_dimensions RPC (the UI groups
 * selected lines by their computed resulting map and issues one POST per
 * distinct map). `dimensions` reuses THE bag schema so validation cannot
 * drift from the engine/API layers; an empty bag is allowed: replace mode
 * uses it to clear phantom tags. `reason` mirrors the RPC's >= 3 chars CHECK.
 */
export const DimensionTaggingApplySchema = z.object({
  line_ids: z.array(uuid).min(1).max(500),
  dimensions: DimensionsBagSchema,
  reason: z.string().trim().min(3).max(500),
})

/**
 * Body for PATCH /api/byra/brand. The app name is byra-editable (WL-17):
 * shown beside the sidebar logo and across branded chrome. Trimmed and
 * capped so it stays a name, not a paragraph; domain and colors are NOT
 * accepted here (ops-managed).
 */
export const ByraBrandUpdateSchema = z.object({
  appName: z.string().trim().min(1).max(60),
})

// ============================================================
// Körjournal (mileage trips)
// ============================================================

// ============ Expense claims (utlägg) ============

const expenseCurrency = z.enum(['SEK', 'EUR', 'USD', 'GBP', 'NOK', 'DKK'])

export const CreateExpenseClaimSchema = z
  .object({
    description: z.string().trim().min(1).max(300),
    expense_date: saneIsoDate,
    /** Gross incl VAT, in `currency`. */
    amount: z.number().positive(),
    /** Deductible VAT part of `amount`, in `currency`. */
    vat_amount: z.number().nonnegative().default(0),
    currency: expenseCurrency.default('SEK'),
    exchange_rate: z.number().positive().optional(),
    expense_account: accountNumberSchema.refine((a) => /^[4-8]/.test(a), {
      message: 'Kostnadskontot måste vara ett resultatkonto (klass 4-8)',
    }),
    employee_id: uuid.optional().nullable(),
    claimant_name: z.string().trim().max(200).optional(),
    document_id: uuid.optional().nullable(),
    inbox_item_id: uuid.optional().nullable(),
    /** Advanced booking: full verifikat lines in claim currency. Deep
     *  validation (balance, liability line) happens in the service. */
    lines: z
      .array(
        z.object({
          account_number: accountNumberSchema,
          debit_amount: z.number().nonnegative().default(0),
          credit_amount: z.number().nonnegative().default(0),
          line_description: z.string().trim().max(300).optional().nullable(),
        }),
      )
      .min(2)
      .max(20)
      .optional(),
  })
  .superRefine((data, ctx) => {
    if (!data.lines && data.vat_amount >= data.amount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Momsen måste vara mindre än totalbeloppet.',
        path: ['vat_amount'],
      })
    }
    if (!data.employee_id && !data.claimant_name?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Ange vem utlägget avser: välj anställd eller skriv ett namn.',
        path: ['claimant_name'],
      })
    }
  })

export const CreateExpensePayoutSchema = z.object({
  claim_ids: z.array(uuid).min(1).max(200),
  payout_date: saneIsoDate,
  cash_account: z.string().regex(/^19\d{2}$/, 'Ange ett likvidkonto i 19xx-serien'),
  notes: z.string().trim().max(1000).optional(),
})

const mileageVehicleType = z.enum(['own_car', 'company_car_fossil', 'company_car_electric'])

export const CreateMileageTripSchema = z
  .object({
    trip_date: saneIsoDate,
    vehicle_type: mileageVehicleType.default('own_car'),
    vehicle_registration: z.string().trim().max(20).optional().nullable(),
    odometer_start: z.number().int().nonnegative().optional().nullable(),
    odometer_end: z.number().int().nonnegative().optional().nullable(),
    distance_km: z.number().positive().max(100000),
    from_location: z.string().trim().min(1).max(200),
    to_location: z.string().trim().min(1).max(200),
    purpose: z.string().trim().min(1).max(500),
    visited: z.string().trim().max(200).optional().nullable(),
    is_round_trip: z.boolean().default(false),
    employee_id: uuid.optional().nullable(),
    notes: z.string().trim().max(1000).optional().nullable(),
  })
  .refine(
    (t) =>
      t.odometer_start == null || t.odometer_end == null || t.odometer_end > t.odometer_start,
    { message: 'Mätarställning vid ankomst måste vara högre än vid start' }
  )
  .refine((t) => t.vehicle_type === 'own_car' || Boolean(t.vehicle_registration?.trim()), {
    message: 'Ange registreringsnummer för förmånsbilen',
  })

export const UpdateMileageTripSchema = z
  .object({
    trip_date: saneIsoDate.optional(),
    vehicle_type: mileageVehicleType.optional(),
    vehicle_registration: z.string().trim().max(20).optional().nullable(),
    odometer_start: z.number().int().nonnegative().optional().nullable(),
    odometer_end: z.number().int().nonnegative().optional().nullable(),
    distance_km: z.number().positive().max(100000).optional(),
    from_location: z.string().trim().min(1).max(200).optional(),
    to_location: z.string().trim().min(1).max(200).optional(),
    purpose: z.string().trim().min(1).max(500).optional(),
    visited: z.string().trim().max(200).optional().nullable(),
    is_round_trip: z.boolean().optional(),
    employee_id: uuid.optional().nullable(),
    notes: z.string().trim().max(1000).optional().nullable(),
  })
  .refine((t) => Object.keys(t).length > 0, { message: 'Inga fält att uppdatera' })

export const BookMileagePeriodSchema = z
  .object({
    from: saneIsoDate,
    to: saneIsoDate,
    entry_date: saneIsoDate,
    counter_account: z.enum(['2820', '2893', '1930']).default('2820'),
    employee_id: uuid.optional(),
  })
  .refine((p) => p.from <= p.to, { message: 'Ogiltigt datumintervall' })
  // Schablon rates are per calendar year: a cross-year period would book
  // every trip at one year's rate.
  .refine((p) => p.from.slice(0, 4) === p.to.slice(0, 4), {
    message: 'Milersättning bokförs per kalenderår: dela upp perioden per år',
  })

export const MileageSalaryPushSchema = z
  .object({
    run_id: uuid,
    employee_id: uuid,
    from: saneIsoDate,
    to: saneIsoDate,
    include_unassigned: z.boolean().default(true),
  })
  .refine((p) => p.from <= p.to, { message: 'Ogiltigt datumintervall' })
  .refine((p) => p.from.slice(0, 4) === p.to.slice(0, 4), {
    message: 'Milersättning bokförs per kalenderår: dela upp perioden per år',
  })

export const MileageDistanceQuerySchema = z.object({
  from: z.string().trim().min(2).max(200),
  to: z.string().trim().min(2).max(200),
})

// ============================================================
// Bank file import
// ============================================================

/**
 * Known bank-file format ids, mirrored from `BankFileFormatId`
 * (lib/import/bank-file/types.ts). `satisfies` pins every member to the union
 * at compile time; a format id added to the union but not listed here only
 * degrades the ADVISORY duplicate preview (400), never the import itself.
 */
const BANK_FILE_FORMAT_IDS = [
  'nordea',
  'nordea_business',
  'seb',
  'swedbank',
  'handelsbanken',
  'lansforsakringar',
  'ica_banken',
  'skandia',
  'lunar',
  'northmill',
  'wise',
  'wise_statement',
  'generic_csv',
  'camt053',
] as const satisfies readonly BankFileFormatId[]

/**
 * POST /api/import/bank-file/check-duplicates
 *
 * The rows are client-supplied (the generic_csv path never round-trips through
 * the parse route), so the array is hard-capped: the parse route caps files at
 * 10 MB, and 20000 rows mirrors that ceiling so an oversized payload cannot
 * drive the per-chunk dedup queries as a DoS vector. `raw_line` must pass
 * through untouched: camt.053/Wise external_ids are derived from it, and the
 * preview must compute byte-identical ids to execute.
 */
export const BankFileCheckDuplicatesSchema = z.object({
  transactions: z
    .array(
      z.object({
        date: isoDate,
        description: z.string().max(1000),
        amount: z.number().finite(),
        currency: z.string().max(8).optional().nullable(),
        raw_line: z.string().max(4000).optional().nullable(),
      })
    )
    .min(1)
    .max(20000),
  format: z.enum(BANK_FILE_FORMAT_IDS),
})

/**
 * POST /api/import/skattekonto-file/execute
 *
 * Rows are client-confirmed but the route recomputes dedup keys and
 * re-partitions against the table server-side: the payload can only choose
 * WHICH parsed rows to import, never what they dedup as. closing_saldo comes
 * from the statement's "Utgående saldo" marker (not derivable from rows).
 */
export const SkattekontoFileExecuteSchema = z.object({
  rows: z
    .array(
      z.object({
        transaktionsdatum: isoDate,
        transaktionstext: z.string().min(1).max(500),
        belopp: z.number().finite(),
      })
    )
    .min(1)
    .max(20000),
  filename: z.string().min(1).max(255),
  file_hash: z.string().regex(/^[0-9a-f]{64}$/),
  variant: z.enum(['csv', 'skv']),
  closing_saldo: z.number().finite().nullable().optional(),
})

// ============================================================
// Company migration reset
// ============================================================

/**
 * POST /api/company/[id]/migration-reset
 *
 * Every confirmation is required independently. The database repeats these
 * checks inside the atomic RPC, including the exact display-name match.
 */
export const CompanyMigrationResetSchema = z.object({
  confirm_name: z
    .string()
    .trim()
    .min(1, 'Ange företagsnamnet exakt som det visas')
    .max(200, 'Företagsnamnet får vara högst 200 tecken'),
  reason: z
    .string()
    .trim()
    .min(20, 'Beskriv varför migreringen behöver göras om med minst 20 tecken')
    .max(1000, 'Beskrivningen får vara högst 1 000 tecken'),
  confirm_no_filed_declarations: z.literal(true, {
    error: 'Bekräfta att inga deklarationer eller årsredovisningar har lämnats in',
  }),
  confirm_retained_archive: z.literal(true, {
    error: 'Bekräfta att den tidigare företagskopian sparas som arkiv',
  }),
})

/**
 * POST /api/bookkeeping/fiscal-periods/[id]/reset
 *
 * Typed confirmation for the destructive fiscal-year reset: the caller must
 * restate the year's label (fiscal_periods.name) exactly. The RPC repeats
 * the match server-side, so this only provides early Swedish feedback.
 */
export const FiscalYearResetSchema = z.object({
  confirm_name: z
    .string()
    .trim()
    .min(1, 'Ange räkenskapsårets namn exakt som det visas')
    .max(200, 'Räkenskapsårets namn får vara högst 200 tecken'),
})

/**
 * POST /api/notices/dismiss
 *
 * notice_id is an opaque lib/notices id (category + state discriminator).
 * Ids are bounded by construction: a multi-connection discriminator collapses
 * to a count plus an 8-char sha256 digest of the sorted parts (see
 * boundedDiscriminator in lib/notices/categories.ts), so the widest real id
 * is a single connection uuid plus a status/expiry, well under this cap;
 * anything longer is garbage.
 */
export const NoticeDismissSchema = z.object({
  notice_id: z.string().min(1).max(200),
})

/**
 * Brand signup access (invite-only white-label domains, 2026-08-27).
 * Emails are lowercased here so they match the CHECK-enforced lowercase
 * storage in brand_signup_allowlist.
 */
export const BrandSignupModeSchema = z.object({
  signup_mode: z.enum(['open', 'invite_only']),
})

export const BrandAllowlistAddSchema = z.object({
  email: z.string().trim().toLowerCase().max(320).pipe(z.string().email()),
  note: z.string().trim().max(200).optional(),
})

export const BrandAllowlistRemoveSchema = z.object({
  id: z.string().uuid(),
})

// ============================================================
// Kundorder (sales orders) schemas
// ============================================================

// Order lines mirror the invoice line shape (same editor, same line math)
// minus the invoice-only fields (ROT/RUT, periodisering). Text rows carry a
// description only.
export const SalesOrderItemSchema = z
  .object({
    id: uuid.optional(),
    line_type: z.enum(['product', 'text']).optional(),
    description: z.string().max(2000),
    quantity: z.number().nonnegative(),
    unit: z.string().max(32),
    unit_price: z.number(),
    discount_percent: z.number().min(0).max(100).nullable().optional(),
    vat_rate: z.number().min(0).max(100).optional(),
    article_id: uuid.nullable().optional(),
    revenue_account: invoicePostingAccount.nullable().optional(),
    dimensions: DimensionsBagSchema.optional(),
  })
  .superRefine((item, ctx) => {
    if (item.line_type === 'text') return
    if (!item.description.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['description'], message: 'Beskrivning krävs' })
    }
  })

export const CreateSalesOrderSchema = z.object({
  customer_id: uuid,
  order_date: isoDate.optional(),
  requested_delivery_date: isoDate.nullable().optional(),
  currency: CurrencySchema.optional(),
  your_reference: z.string().max(200).nullable().optional(),
  our_reference: z.string().max(200).nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
  default_dimensions: DimensionsBagSchema.optional(),
  items: z.array(SalesOrderItemSchema).min(1, 'Minst en orderrad krävs').max(500),
})

// Full replace of header + lines. Lines that carry an `id` keep their
// delivered/invoiced history (the DB refuses lowering quantity below the
// invoiced quantity); lines without an id are new; omitted ids are deleted.
export const UpdateSalesOrderSchema = CreateSalesOrderSchema.partial().extend({
  items: z.array(SalesOrderItemSchema).min(1).max(500).optional(),
})

export const SalesOrderTransitionSchema = z.object({
  action: z.enum(['confirm', 'cancel', 'reopen']),
})

export const RegisterSalesOrderDeliverySchema = z.object({
  delivery_date: isoDate.optional(),
  lines: z
    .array(
      z.object({
        sales_order_item_id: uuid,
        // Cumulative delivered quantity after this registration (not a delta):
        // idempotent on retry, and what the user sees in the dialog.
        delivered_qty: z.number().nonnegative(),
      }),
    )
    .min(1)
    .max(500),
})

export const CreateInvoiceFromSalesOrderSchema = z.object({
  // Explicit picks win. Without them, `mode` selects the lines:
  //   remaining  = every line with quantity left to invoice (default)
  //   delivered  = only what has been delivered but not yet invoiced
  mode: z.enum(['remaining', 'delivered']).optional(),
  lines: z
    .array(
      z.object({
        sales_order_item_id: uuid,
        quantity: z.number().positive(),
      }),
    )
    .max(500)
    .optional(),
  invoice_date: isoDate.optional(),
  due_date: isoDate.optional(),
})

export const SalesOrderListQuerySchema = z.object({
  status: z.enum(['draft', 'confirmed', 'completed', 'cancelled']).optional(),
  customer_id: uuid.optional(),
  q: z.string().max(200).optional(),
})

// ── Parties (Kontakter register) ───────────────────────────────────────────

export const PartiesRegisterQuerySchema = z.object({
  view: z.enum(['suggested', 'observed']).optional(),
  q: z.string().max(120).optional(),
  period: z.enum(['12m', 'all']).optional(),
})

export const PartyDecideSchema = z.object({
  partyIds: z.array(uuid).min(1).max(500),
  kind: z.enum(['confirm', 'dismiss']),
  note: z.string().max(500).optional(),
})

export const PartyPromoteSchema = z.object({
  items: z
    .array(
      z.object({
        partyId: uuid,
        roles: z.array(z.enum(['supplier', 'customer'])).min(1).max(2),
      }),
    )
    .min(1)
    .max(500),
})

export const PartyUndoDecisionsSchema = z.object({
  partyIds: z.array(uuid).min(1).max(500),
})

export const PartyMergeSchema = z.object({
  survivorId: uuid,
  mergedIds: z.array(uuid).min(1).max(50),
  note: z.string().max(500).optional(),
})

export const PartyEnrichSchema = z.object({
  /** Chosen from the SCB picker: sets the party's org number before the fetch. */
  orgNumber: z
    .string()
    .transform((v) => v.replace(/[^0-9]/g, ''))
    .pipe(z.string().regex(/^\d{10}$/))
    .optional(),
})

export const PartySearchRegistryQuerySchema = z.object({
  q: z.string().max(120).optional(),
})

/**
 * GET /api/parties/registry: the org number a customer or supplier form is
 * being filled for. Shape, check digit and the legal-person rule are one
 * function (registryLookupKey in lib/parties/registry-form-fill), so the
 * form and the route cannot disagree about what may be looked up.
 */
export const PartyRegistryLookupQuerySchema = z.object({
  org_number: z.string().trim().min(1).max(20),
})

export const PartyUndoMergeSchema = z.object({
  decisionId: uuid,
})
