import { z } from 'zod'

import { ENTITY_TYPES } from '@/lib/company/entity-type'
import { PURCHASE_CATEGORY_CODES } from '@/lib/categories/purchase-categories'
import { MILEAGE_COUNTER_ACCOUNTS } from '@/lib/mileage/counter-accounts'
import { normaliseSwish, isValidSwish } from '@/lib/payments/swish'
import {
  normalizeSwedbankId,
  SWEDBANK_CORPORATE_PAY_ID_PATTERN,
  SWEDBANK_ISO1_AGREEMENT_PATTERN,
  SWEDBANK_SIGNER_ID_PATTERN,
} from '@/lib/payments/swedbank'
import { NORDEA_AGREEMENT_ID_PATTERN, NORDEA_SIGNER_ID_PATTERN } from '@/lib/payments/nordea'
import { normalizeVatNumber } from '@/lib/vat/vat-number'
import {
  defaultVatRateForTreatment,
  treatmentDeductsInputVat,
} from '@/lib/vat/supplier-invoice-line-checks'
import { ACCOUNT_VAT_TREATMENTS } from '@/lib/vat/account-vat-treatment'
import { ACCOUNT_VAT_BOXES } from '@/lib/vat/account-vat-box'
import { VAT_DECLARATION_CHECK_CODES } from '@/lib/reports/vat-declaration-checks'
import { BEHANDLINGSHISTORIK_CATEGORIES } from '@/lib/reports/behandlingshistorik-types'
import { PERSON_REJECTION_CATEGORIES } from '@/lib/pending-operations/rejection-categories'
import { BULK_IDS_MAX, SHARED_ACKNOWLEDGMENT_GROUPS } from '@/lib/pending-operations/shared-acknowledgment'
import { MAX_INBOX_ITEMS_PER_REMOVAL } from '@/lib/inkorg/remove-items'
import {
  accountNumberSchema,
  isoDateSchema,
  saneIsoDateSchema,
  fiscalYearSchema,
} from '@/lib/invariants/zod'
import { ISO_DATE_RE, ISO_DATE_MESSAGE_SV } from '@/lib/invariants/iso-date'
import { orgNumberKey } from '@/lib/invariants/org-number'
import { isUuid } from '@/lib/invariants/uuid'
import { validateBankgiroNumber } from '@/lib/bankgiro/luhn'
import { DIMENSION_RULE_POLICY } from '@/lib/bookkeeping/dimension-rule-policy'
import { CARD_LEDGER_PATTERN, CARD_LEDGER_RANGE_TEXT, CASH_OR_CARD_LEDGER_PATTERN } from '@/lib/cash-accounts/card-ledger'
import { CARD_ISSUERS } from '@/types'
import { countCalendarMonths, invoiceMonthOnlyAccrualRows } from '@/lib/bookkeeping/accruals/compute'
import { DimensionsBagSchema } from '@/lib/bookkeeping/dimension-resolver'
import { CUSTOMER_ADVANCE_ACCOUNT } from '@/lib/bookkeeping/overpayment'
import { PAYMENT_FEE_ACCOUNT } from '@/lib/bookkeeping/payment-fee'
import {
  MAX_PAYOUT_FEES,
  PAYOUT_FEE_DESCRIPTION_MAX,
  isPayoutFeeAccount,
  payoutFeeTotal,
  payoutFeesWithinInvoices,
} from '@/lib/bookkeeping/payout-fee-lines'
import { SUPPLIER_DEBT_DESCRIPTION_MAX, isSupplierDebtAccount } from '@/lib/bookkeeping/supplier-debt-lines'
import { CUSTOMER_RECEIVABLE_DESCRIPTION_MAX, isCustomerReceivableAccount } from '@/lib/bookkeeping/customer-receivable-lines'
import {
  isAccruedCostAccount,
  pastPeriodDeferralSuggestion,
  periodEndsBeforeInvoiceMonth,
} from '@/lib/bookkeeping/accruals/account-suggestions'
import { ORE_ROUNDING_ACCOUNT, roundOre } from '@/lib/money'
import { VOUCHER_WARNING_CODES } from '@/lib/bookkeeping/voucher-plausibility'
import { isPaidAtIssueAccount } from '@/lib/invoices/paid-at-issue'
import {
  INVOICE_COLOR_PATTERN,
  INVOICE_FOOTER_TEXT_MAX_LENGTH,
  INVOICE_HEADER_TEXT_MAX_LENGTH,
} from '@/lib/invoices/branding-constants'
import { DIMENSION_RULE_TYPES, ruleValueProblem } from '@/lib/dimensions/rule-value'
import { validateEmployeeBankAccount } from '@/lib/payments/bank-account'
import { validateJamkning } from '@/lib/salary/jamkning-rules'
import { FORA_FOK_ID_FORMAT, FORA_FOK_ID_PATTERN, validateForaMarkup } from '@/lib/salary/fora/markup'
import {
  EXTRA_TAX_AMOUNT_MAX,
  EXTRA_TAX_AMOUNT_RANGE,
  EXTRA_TAX_PERCENTAGE_RANGE,
  isStorableExtraTaxPercentage,
  validateExtraTax,
} from '@/lib/salary/extra-tax'
import { VACATION_DAYS_MINIMUM, vacationDaysBelowMinimum } from '@/lib/salary/employee-update-rules'
import { SalaryCalculationPolicySchema } from '@/lib/salary/calculation-policy'
import {
  RECURRING_LINE_ITEM_TYPES,
  validateRecurringLineAmount,
  type RecurringLineItemType,
} from '@/lib/salary/recurring-lines'
import { EXPENSE_CLAIM_REVERSE_CHARGE_KINDS } from '@/lib/expenses/expense-claim-vat'
import { VOUCHER_LINE_VAT_KINDS, VOUCHER_LINE_VAT_RATES } from '@/lib/bookkeeping/voucher-line-vat-code'
import { MAX_INVOICE_EMAIL_COPY_RECIPIENTS } from '@/lib/invoices/email-recipients'
import { INVOICE_POSTING_ACCOUNT_REGEX, isInvoiceLinePostingAccount } from '@/lib/invoices/posting-account'
import { netVat } from '@/lib/bookkeeping/gross-split'
import { computeLineNet } from '@/lib/bookkeeping/invoice-line-amounts'
import { INVOICE_VAT_TREATMENT_OVERRIDES } from '@/lib/invoices/invoice-vat-override'
import { MAX_BANK_ROW_SPLIT } from '@/lib/reconciliation/limits'
import {
  ARTICLE_HOUSEWORK_TYPE_VALUES,
  DEDUCTION_LINE_ERRORS,
  DEDUCTION_TYPES,
  deductionLineIssues,
  normalizeHouseworkType,
  type DeductionType,
} from '@/lib/bookkeeping/rot-rut-rules'
import { NON_IBAN_CURRENCIES } from '@/lib/cash-accounts/invoice-payment-accounts'
import { PERSONAL_NUMBER_INPUT_RE } from '@/lib/customers/mask-personal-number'
import { InvoiceDeliveryAddressSchema } from '@/lib/invoices/delivery-address'
import {
  COUNTRY_CONSISTENCY_MESSAGES,
  checkCountryConsistency,
  defaultCountryForParty,
  isAssignedCountryCode,
  normalizeCountryCode,
} from '@/lib/vat/country-codes'
import {
  isOrgNumberRefusedOnIndividual,
  isPersonalNumberOrgNumberDisallowed,
  normalizeReroutedPersonalNumber,
  orgNumberHoldsPersonalNumber,
  personalNumberDigits,
} from '@/lib/invariants/personal-number-shape'
import {
  CURRENCIES,
  INVOICE_QR_MODES,
  SUPPLIER_INVOICE_REVERSE_CHARGE_KINDS,
  type AuditAction,
  type Currency,
  type InvoiceDocumentType,
  type JournalEntrySourceType,
} from '@/types'
import type { BankFileFormatId } from '@/lib/import/bank-file/types'
import { ARTICLE_MATCH_MAX_ROWS } from '@/lib/import/articles/types'
import {
  mentionsPeriodPlaceholder,
  PERIOD_PLACEHOLDER_REQUIRES_START_MESSAGE,
} from '@/lib/invoices/recurring-placeholders'
import { stockholmYearMonth, todayIsoStockholm } from '@/lib/dates/iso'
import { lineQuantityIssue, LINE_QUANTITY_MESSAGES } from '@/lib/invoices/line-quantity'
import { SEND_ORDER_WAYS } from '@/lib/invoices/send-order'

export const SIECreateAccountsSchema = z.object({
  accounts: z.array(z.object({ number: accountNumberSchema, name: z.string().max(500) })).min(1).max(10_000),
})

export const SIEJobOptionsSchema = z.object({
  createFiscalPeriod: z.boolean().default(true),
  importOpeningBalances: z.boolean().default(true),
  importTransactions: z.boolean().default(true),
  voucherSeries: z.string().trim().min(1).max(16).optional(),
  openingBalanceSeries: z.string().trim().min(1).max(16).optional(),
  updateAccountNames: z.boolean().default(true),
  markImportedNoDocRequired: z.boolean().default(false),
  // Create only the accounts the file uses (#63); unused #KONTO definitions
  // stay in the archived original. Optional, not defaulted: a job submitted
  // without it keeps its input (an identical retry's identity) byte for byte.
  onlyUsedAccounts: z.boolean().optional(),
  // 'append' adds only the file's vouchers the year's import does not hold,
  // as their own batch (issue #108, lib/import/sie-append.ts).
  onExistingPeriod: z.enum(['block','replace','append']).default('block'),
  supersedesImportId: z.string().uuid().optional(),
  // Append only: also book the vouchers that match a posted entry's date and
  // lines but carry no matching source number (skipped by default).
  includePossibleDuplicates: z.boolean().optional(),
  // Append only: a source series the year does not use yet, booked in
  // another series instead ({ "K": "A" }). Unmapped series keep their letter.
  seriesMap: z.record(z.string().trim().min(1).max(16), z.string().trim().min(1).max(16)).optional(),
  // The file's #ORGNR is not the company's and the user said import anyway.
  // A submit-time gate only: submitSIEJob keeps it out of the job's input.
  confirmOrgNumberMismatch: z.boolean().optional(),
})
/**
 * The import's what-to-bring flags as the job reads them: an omitted flag
 * takes the job's own default (SIEJobOptionsSchema: create the year, bring
 * the IB and every verifikation, keep the file's account names), the
 * dashboard's and v1's "import everything". A migration brings the year's IB
 * and every verifikation (post-migration check: trial balances and voucher
 * counts per series). The MCP tool used to stage Boolean(undefined), so an
 * omitted flag was an explicit false and the defaults never applied.
 */
export const SIEImportFlagsSchema = SIEJobOptionsSchema.pick({
  createFiscalPeriod: true,
  importOpeningBalances: true,
  importTransactions: true,
  updateAccountNames: true,
})

export const SIEJobMappingsSchema = z.array(z.object({
  sourceAccount: z.string().min(1).max(40), sourceName: z.string().max(500),
  // Match the chart and worker's account-number rule, including custom accounts.
  targetAccount: accountNumberSchema.or(z.literal('')), targetName: z.string().max(500),
  confidence: z.number().min(0).max(1), matchType: z.enum(['exact','name','class','manual','bas_range']),
  isOverride: z.boolean().default(false),
  defaultVatTreatment: z.enum(ACCOUNT_VAT_TREATMENTS).nullable().optional(),
  defaultVatRate: z.number().min(0).max(100).nullable().optional(),
  vatTreatmentSuggested: z.boolean().optional(), vatTreatmentReviewed: z.boolean().optional(),
  requiresVatTreatmentReview: z.boolean().optional(),
})).max(10_000).superRefine((mappings, ctx) => {
  const sources = new Map<string, string>()
  for (const [index, mapping] of mappings.entries()) {
    const serialized = JSON.stringify(mapping)
    const previous = sources.get(mapping.sourceAccount)
    if (previous !== undefined && previous !== serialized) {
      ctx.addIssue({ code: 'custom', path: [index, 'sourceAccount'],
        message: `Konto ${mapping.sourceAccount} har motstridiga kontomappningar.` })
    }
    sources.set(mapping.sourceAccount, serialized)
  }
}).transform(mappings => {
  // Repeated #KONTO definitions must not target the same metadata upsert row
  // twice. Conflicting definitions are rejected before any import is queued.
  return [...new Map(mappings.map(mapping => [mapping.sourceAccount, mapping])).values()]
})
export const SIEJobActionSchema = z.object({action:z.enum(['resume','undo'])})

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
 * A journal line carries exactly one side (issue #2551).
 *
 * A line with both debit_amount and credit_amount above zero cancels itself,
 * and the balance check sums the two columns, so it cannot see that: the
 * entry "balances" and posts as a nollverifikat. Storno then reverses the
 * line on its net, lands on {0, 0} and dies on the voucher trigger's "has
 * zero total", which leaves the entry uncorrectable.
 *
 * The same rule is enforced by the engine (`assertLinesWellFormed`) and by
 * the DB CHECK `journal_entry_lines_single_side`; this refinement is the
 * layer that turns it into a 400 naming the offending line, identically for
 * the dashboard, /api/v1 and the MCP tools that post through v1. Apply it to
 * every line schema whose rows reach the engine:
 *
 *   .refine(isSingleSidedLine, SINGLE_SIDED_LINE_ISSUE)
 */
function isSingleSidedLine(line: { debit_amount?: number; credit_amount?: number }): boolean {
  return !((line.debit_amount ?? 0) > 0 && (line.credit_amount ?? 0) > 0)
}

const SINGLE_SIDED_LINE_ISSUE = {
  message: 'En verifikationsrad kan inte ha både debet och kredit nollskilda.',
}

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

/** Article posting account: an asset, liability/equity, or revenue account. */
const invoicePostingAccount = z
  .string()
  .regex(INVOICE_POSTING_ACCOUNT_REGEX, 'Posting account must be a 4-digit BAS class 1-3 account')

/** Invoice-line posting account: class 1-3 or an interest-income account (PH 246). */
const invoiceLinePostingAccount = z
  .string()
  .refine(
    isInvoiceLinePostingAccount,
    'Posting account must be a 4-digit BAS class 1-3 account or an interest income account (825x, 826x, 831x, 836x)',
  )

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

/**
 * Periodisering of a cost: förutbetalda kostnader live on 17xx, upplupna
 * kostnader (months before the invoice month) on 29xx.
 */
const expenseAccrualAccount = z
  .string()
  .regex(/^(17|29)\d{2}$/, 'Balanskonto för periodiserad kostnad måste vara ett 17xx-konto (förutbetald) eller 29xx-konto (upplupen)')

/**
 * Periodisering of revenue: förutbetalda intäkter live on 29xx, upplupna
 * intäkter (months before the invoice month) on 17xx.
 */
const revenueAccrualAccount = z
  .string()
  .regex(/^(17|29)\d{2}$/, 'Balanskonto för periodiserad intäkt måste vara ett 29xx-konto (förutbetald) eller 17xx-konto (upplupen)')

/**
 * Shared periodisering period rules for invoice line items: both dates or
 * neither, end after start, and a 1-120 calendar month span. The amount-side
 * rules differ per item shape and stay in each schema's superRefine. A period
 * that lies only in the invoice month is refused where the invoice date is
 * known (CreateSupplierInvoiceSchema, buildInvoiceWriteData).
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

export const EntityTypeSchema = z.enum(ENTITY_TYPES)

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
const COMPONENT_DATE = ISO_DATE_RE

export const K3ComponentSchema = z.object({
  component_id: z.string().uuid().optional().describe('An existing component (update); omit to register a new one.'),
  name: z.string().min(1, 'Komponentens namn krävs.'),
  cost: z.number().positive('Anskaffningsvärdet måste vara större än 0.'),
  useful_life_months: z
    .number()
    .int()
    .positive('Nyttjandeperioden måste vara ett positivt heltal månader.')
    .nullable()
    .describe('Months; null for a component that is not depreciated (mark, K3 17.13).'),
  salvage_value: z.number().nonnegative().optional(),
  acquisition_date: z.string().regex(COMPONENT_DATE).nullable().optional().describe('yyyy-MM-dd; defaults to the asset acquisition date.'),
  depreciation_start_date: z.string().regex(COMPONENT_DATE).nullable().optional().describe('yyyy-MM-dd the component can be used (K3 17.18); defaults to its acquisition date.'),
  opening_accumulated_depreciation: z.number().nonnegative().optional().describe('Accumulated depreciation before the component entered Accounted, SEK; never posted.'),
  opening_depreciation_date: z.string().regex(COMPONENT_DATE).nullable().optional().describe('yyyy-MM-dd the opening amount is stated per.'),
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

export const CurrencySchema = z.enum(CURRENCIES)

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
  'tax_account',
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
  'rot_rut_reclaim',
  'pos_daily_sales',
  'collection_settlement',
  'customer_loss',
  'counterparty_setoff',
  'rot_rut_reclassification',
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

// Mirrors chart_of_accounts_account_type_check. untaxed_reserves is the 21xx
// group (obeskattade reserver); without it every 21xx account the Kontoplan
// dialog derived was refused (#2514).
export const AccountTypeSchema = z.enum([
  'asset', 'equity', 'liability', 'untaxed_reserves', 'revenue', 'expense',
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
  'inkomstdeklaration_ekonomisk_forening',
  'inkomstdeklaration_ideell_forening',
  'arsredovisning',
  'arsredovisning_ekonomisk_forening',
  'arsstamma',
  'foreningsstamma',
  'forenklat_arsbokslut',
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
    // (lib/bookkeeping/invoice-line-amounts.ts); the client never sends a total.
    discount_percent: z.number().min(0).max(100).nullable().optional(),
    vat_rate: z.number().min(0).max(100).optional(),
    // Article linkage. `article_id` ties the line to a catalog article (text
    // rows omit it). `revenue_account` is the legacy wire name for the optional
    // posting-account override the engine books to (class 1-3 or interest
    // income, PH 246); the API validates it against chart_of_accounts before
    // use, and class 1-2 and interest accounts are only accepted on zero-VAT
    // lines (build-invoice-write.ts).
    article_id: uuid.nullable().optional(),
    revenue_account: invoiceLinePostingAccount.nullable().optional(),
    // Kundorder provenance: the order line this invoice line was created
    // from. Round-tripped on draft edits; the DB trigger refuses a quantity
    // that would over-invoice the order line.
    sales_order_item_id: uuid.nullable().optional(),
    // Skattereduktion fields (ROT/RUT-avdrag, grön teknik). `deduction_amount`
    // is intentionally omitted from the client schema: the API computes it
    // from rot-rut-rules.ts so a tampered client can't expand the 1513
    // receivable beyond the line total.
    deduction_type: z.enum(DEDUCTION_TYPES).nullable().optional(),
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
    // Periodisering: spread the line's net revenue over the service period.
    // The revenue entry credits the interim account instead of the revenue
    // account; output VAT is never deferred. 29xx is a förutbetald intäkt
    // (months from the invoice on), 17xx an upplupen intäkt (months before
    // the invoice month, each booked on its last day).
    accrual_period_start: isoDate.nullable().optional(),
    accrual_period_end: isoDate.nullable().optional(),
    accrual_balance_account: revenueAccrualAccount.nullable().optional(),
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
          message:
            item.deduction_type === 'gron_teknik'
              ? 'Rader med grön teknik kan inte periodiseras'
              : 'ROT/RUT-rader kan inte periodiseras',
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
    // Zero and negative quantities are allowed, except on a skattereduktion
    // row or (negative) a sales order row: lib/invoices/line-quantity.ts.
    const quantityIssue = lineQuantityIssue(item)
    if (quantityIssue) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['quantity'], message: LINE_QUANTITY_MESSAGES[quantityIssue] })
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

// POST /api/invoices/[id]/convert and gnubok_convert_invoice (crm#1196): the
// part of a quote to invoice, a percent of its net or a net amount (excl.
// VAT, in the quote's currency, rounded to the öre). Neither: everything not
// yet invoiced.
export const ConvertQuotePartSchema = z
  .object({
    percent: z.number().gt(0).max(100).optional(),
    amount: z.number().gt(0).optional(),
  })
  .strict()
  .refine((part) => part.percent === undefined || part.amount === undefined, {
    message: 'Give percent or amount, not both',
  })

/**
 * Skattereduktion claim completeness (HUSFL: art av arbete + antal
 * arbetstimmar; for grön teknik the installation type and the hours per
 * installation) at the invoice level, where document_type is known: only
 * real invoices book a deduction (buildInvoiceWriteData nulls the fields for
 * proformas, delivery notes and quotes), and free-text rows carry no claim.
 * Field-level paths so the editor can point at the row; validateInvoice
 * (validateDeductionLines) re-runs the same rules for callers that bypass
 * this schema.
 */
function refineRotRutLineCompleteness(
  data: { document_type?: string; items: Array<{ line_type?: string; deduction_type?: DeductionType | null; work_type?: string | null; labor_hours?: number | null }> },
  ctx: z.RefinementCtx,
): void {
  if (data.document_type && data.document_type !== 'invoice') return
  for (const issue of deductionLineIssues(data.items)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['items', issue.index, issue.field],
      message: DEDUCTION_LINE_ERRORS[issue.code],
    })
  }
}

/**
 * Which payment QR code an invoice PDF prints (migration 20261004004343):
 * auto (Swish to a private customer when usable, else the bank-app QR, else
 * Swish, else the payment link), bank_app, swish, payment_link or none.
 */
export const InvoiceQrModeSchema = z
  .enum(INVOICE_QR_MODES)
  .describe(
    'Payment QR code on the invoice PDF: auto (Swish to private customers when usable, else bank app, else Swish, else the payment link), bank_app, swish, payment_link or none. An explicit mode that cannot be printed prints no QR.',
  )

/**
 * Per-invoice VAT treatment (#2906). Omitted = the customer decides (create)
 * or the draft keeps what it has (edit); null clears. The two travel as a
 * pair: sending either replaces both. The rules live in
 * resolveInvoiceVatRules (lib/invoices/vat-rules.ts), applied by the shared
 * invoice builder; this is only the wire shape.
 */
export const InvoiceVatOverrideShape = {
  vat_treatment: z
    .enum(INVOICE_VAT_TREATMENT_OVERRIDES)
    .nullable()
    .optional()
    .describe(
      "This invoice's own VAT treatment instead of the customer's. standard = Swedish VAT at the line rates (ruta 05). export with delivery_country = export of goods (0 %, 3105, ruta 36); reverse_charge with delivery_country = intra-EU supply of goods (0 %, 3108, ruta 35). Without delivery_country, export / reverse_charge are the services treatments and only accepted where the customer already gets them. reverse_charge_domestic = omvänd betalningsskyldighet for construction services (0 %, 3231, ruta 41, ML 16 kap. 13 §): only to a swedish_business customer with a Swedish VAT number (SE + 12 digits), never with delivery_country; every line 0 %. Omit to let the customer decide; null clears.",
    ),
  delivery_country: z
    .string()
    .regex(/^[A-Za-z]{2}$/, 'delivery_country must be an ISO 3166-1 alpha-2 code')
    .transform((v) => normalizeCountryCode(v) as string)
    // An unassigned code would read as "outside the EU" and unlock export.
    .refine(isAssignedCountryCode, 'delivery_country must be an assigned ISO 3166-1 alpha-2 country code')
    .nullable()
    .optional()
    .describe(
      'ISO 3166-1 alpha-2 country the GOODS are transported to. Setting it declares the invoice a supply of goods; alone it implies the treatment (SE = standard, another EU member state = reverse_charge, elsewhere = export). XI = Northern Ireland (inside the EU for goods). Omit for services.',
    ),
}

/**
 * The VAT per rate a received document states (lib/vat/document-vat.ts): one
 * entry per rate, the rate in the unit of the items it sits beside. Supplier
 * invoices carry fractions (0.25), self-billed sales percent (25).
 */
function uniqueRates(entries: ReadonlyArray<{ vat_rate: number }>, ctx: z.RefinementCtx) {
  const seen = new Set<number>()
  entries.forEach((entry, index) => {
    if (seen.has(entry.vat_rate)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'vat_rate'], message: 'Each VAT rate may appear once in vat_breakdown' })
    }
    seen.add(entry.vat_rate)
  })
}

export const SupplierVatBreakdownSchema = z
  .array(z.object({ vat_rate: vatRateDecimal, vat_amount: z.number() }).strict())
  .min(1)
  .max(4)
  .superRefine(uniqueRates)

export const SelfBilledVatBreakdownSchema = z
  .array(
    z.object({
      vat_rate: z.union([z.literal(0), z.literal(6), z.literal(12), z.literal(25)]),
      vat_amount: z.number(),
    }).strict(),
  )
  .min(1)
  .max(4)
  .superRefine(uniqueRates)

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
  your_reference: z
    .string()
    .optional()
    .describe('Er referens. Omitted or empty on POST /invoices: the customer\'s invoice_reference.'),
  our_reference: z.string().optional(),
  // Fakturamärkning: buyer-required marking (kostnadsställe/projekt/PO),
  // separate from your_reference. Printed on the PDF and mapped to Peppol
  // BT-13 OrderReference (and BT-10 when your_reference is empty).
  invoice_marking: z
    .string()
    .max(200)
    .optional()
    .describe('Märkning. Omitted or empty on POST /invoices: the customer\'s invoice_marking.'),
  // Leveransadress (crm#1547): printed on the PDF, Peppol BG-13. Omitted
  // leaves a draft's address alone; null or {} clears it.
  delivery_address: InvoiceDeliveryAddressSchema.nullable().optional(),
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
  // The one payment QR code this invoice prints, overriding the company's
  // invoice_qr_mode. null = inherit the company default; omitted = null on
  // create and unchanged on a draft edit.
  qr_mode: InvoiceQrModeSchema.nullable().optional(),
  // Skattereduktion claim info (ROT/RUT, grön teknik). The personnummer is
  // plaintext on the wire and gets encrypted server-side before it ever hits
  // the DB (see encryptPersonnummer in lib/salary/personnummer.ts).
  // `deduction_housing_designation` is the fastighetsbeteckning at invoice
  // level: required when any ROT or grön teknik item is present (enforced via
  // rot-rut-rules.validateInvoice in the API).
  deduction_personnummer: z.string().max(20).optional(),
  deduction_housing_designation: z.string().max(128).optional(),
  // Bostadsrätt: lägenhetsnummer + föreningens orgnr replace the
  // fastighetsbeteckning (Begaran.xsd: LagenhetsNr + BrfOrgNr). Stamped onto
  // the deduction lines server-side, same as deduction_housing_designation.
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
  // Self-billed sales only (refused otherwise): the VAT per rate the
  // customer's document states, booked instead of the VAT on the summed base
  // when it is within the per-line rounding (lib/vat/document-vat.ts).
  vat_breakdown: SelfBilledVatBreakdownSchema.optional(),
  // Which of the company's bank accounts the invoice asks the customer to pay
  // to (migration 20260904011000). Omitted/null = the per-currency default.
  // The route checks the account belongs to the company, is flagged as a
  // payee and is usable for the invoice currency.
  payment_cash_account_id: z
    .union([uuid, z.literal('')])
    .transform((v) => v || null)
    .nullable()
    .optional(),
  ...InvoiceVatOverrideShape,
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
  .omit({ save_as_draft: true, vat_breakdown: true })
  .superRefine(refineRotRutLineCompleteness)
  .superRefine(refineQuoteFields)

export const CreateCreditNoteSchema = z.object({
  credited_invoice_id: uuid,
  reason: z.string().optional(),
})

// A date field of a form being filled in: empty means "not set yet"; an
// impossible date is refused (the preview renders and fetches a rate for it).
const previewDate = saneIsoDate.or(z.literal('')).nullish().transform((v) => v || null)

/**
 * One row of the invoice editor's live preview: the write path's line
 * (CreateInvoiceItemSchema) without its completeness rules. A row being
 * typed has no description or price yet, and a cleared number field
 * arrives as null. Wrong types are still refused.
 */
const PreviewInvoiceItemSchema = z.object({
  line_type: z.enum(['product', 'text']).optional(),
  description: z.string().max(2000).nullish().transform((v) => v ?? ''),
  quantity: z.number().nullish().transform((v) => v ?? 0),
  unit: z.string().max(64).nullish().transform((v) => v ?? ''),
  unit_price: z.number().nullish().transform((v) => v ?? 0),
  discount_percent: z.number().min(0).max(100).nullish(),
  vat_rate: z.number().min(0).max(100).nullish(),
  // The article link, for the article number column (crm#1084): the
  // preview reads the number from the company's own article, as the write
  // path copies it. Anything but a uuid previews as a line without one.
  article_id: z
    .string()
    .max(64)
    .nullish()
    .transform((v) => (v && uuid.safeParse(v).success ? v : null)),
  deduction_type: z.enum(DEDUCTION_TYPES).nullish(),
  labor_hours: z.number().nonnegative().nullish(),
  work_type: z.string().max(64).nullish(),
  housing_designation: z.string().max(128).nullish(),
  apartment_number: z.string().max(32).nullish(),
  brf_org_number: z.string().max(32).nullish(),
})

/**
 * POST /api/invoices/preview-pdf (and preview-email): the editor's draft as
 * it is now, rendered without being saved, from the fields the write path
 * uses (CreateInvoiceBaseSchema). A live preview renders a half-filled
 * form: no customer yet, no rows yet and empty dates render with
 * placeholders (lib/invoices/preview-draft.ts) instead of a 400. A
 * malformed value (a string quantity, an unknown qr_mode, an impossible
 * date) is still a 400.
 *
 * credited_invoice_id previews the kreditfaktura of that invoice: its rows
 * and amounts come from the original, as POST /api/invoices creates it, and
 * notes is the reason printed on it.
 */
export const InvoicePreviewSchema = z.object({
  customer_id: z.union([uuid, z.literal('')]).nullish().transform((v) => v || null),
  credited_invoice_id: uuid.nullish(),
  document_type: InvoiceDocumentTypeSchema.optional(),
  // The predicted number the editor shows ("får nummer N när den skickas").
  invoice_number: z.string().max(64).nullish(),
  invoice_date: previewDate,
  due_date: previewDate,
  delivery_date: previewDate,
  valid_until: previewDate,
  currency: CurrencySchema.optional(),
  your_reference: z.string().max(500).nullish(),
  our_reference: z.string().max(500).nullish(),
  invoice_marking: z.string().max(200).nullish(),
  // The write path's shape: half-filled parts are fine, '' is not set.
  delivery_address: InvoiceDeliveryAddressSchema.nullish(),
  notes: z.string().max(10000).nullish(),
  // Printed only when it is an https address, the shape the write path accepts.
  payment_link_url: z.string().max(2048).nullish(),
  payment_cash_account_id: z.union([uuid, z.literal('')]).nullish().transform((v) => v || null),
  // Empty or null = inherit the company's invoice_qr_mode.
  qr_mode: z.union([InvoiceQrModeSchema, z.literal('')]).nullish().transform((v) => v || null),
  ore_rounding: z.boolean().nullish(),
  ...InvoiceVatOverrideShape,
  deduction_personnummer: z.string().max(20).nullish(),
  deduction_housing_designation: z.string().max(128).nullish(),
  deduction_apartment_number: z.string().max(25).nullish(),
  deduction_brf_org_number: z.string().max(32).nullish(),
  items: z.array(PreviewInvoiceItemSchema).max(1000).optional().transform((v) => v ?? []),
})

export type InvoicePreviewInput = z.infer<typeof InvoicePreviewSchema>

// ============================================================
// Rot/rut begäran om utbetalning (Skatteverkets husavdragstjänst)
// ============================================================

export const RotRutPayoutFileSchema = z.object({
  // rot and rut make the HUS file, gron_teknik the grön teknik Begaran file.
  deduction_type: z.enum(DEDUCTION_TYPES),
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
  // Omitted → the company's primary bank account. The engine validates
  // existence against chart_of_accounts.
  bank_account: z
    .string()
    .regex(/^19\d{2}$/, 'Bankkontot måste vara ett BAS 19xx-konto')
    .optional(),
})

/**
 * POST /api/rot-rut/payout-requests/[id]/reclaim: book the share Skatteverket
 * refused back onto the customer(s). The amounts come from the recorded
 * beslut, never from the body; only the booking date is the caller's.
 */
export const RotRutReclaimSchema = z.object({
  booking_date: isoDate,
})

// Link a begäran (plus any others the same transfer paid) to an existing
// payout verifikat. The route's [id] is always part of the set.
export const RotRutLinkVoucherSchema = z.object({
  journal_entry_id: uuid,
  request_ids: z.array(uuid).max(10).optional(),
  dry_run: z.boolean().optional(),
})

// The beslutsfil JSON downloaded from Skatteverkets rot/rut e-tjänst. Defined
// in lib/invoices/rot-rut-beslut-file, which the batch allocation dialog
// reads in the browser without this module.
export { RotRutBeslutFileSchema } from '@/lib/invoices/rot-rut-beslut-file'

// ============================================================
// Articles (artikelregister)
// ============================================================

export const ArticleTypeSchema = z.enum(['vara', 'tjanst'])

/**
 * articles.housework_type: a Skatteverket arbetstypskod (BYGG, EL, ..., STAD,
 * TRADGARD, ..., INSTALLATION_SOLCELLER for grön teknik) or the bare kind
 * ROT / RUT (deduction only, no arbetstyp pre-fill). Case-insensitive, stored
 * upper-case; '' clears to null. The
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
        message: `Ogiltig arbetstyp för skattereduktion. Tillåtna värden: ${ARTICLE_HOUSEWORK_TYPE_VALUES.join(', ')}`,
      })
      return z.NEVER
    }
    return normalized
  })

// One rule set for every article door: the dashboard, and the approval of an
// agent's staged gnubok_create_article / gnubok_update_article
// (lib/articles/article-commands.ts). An empty optional text is stored as
// null there; '' (and a null currency) for unit or currency means "not
// sent", as the agent path always read it.
const blankAsUnset = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v)

export const CreateArticleSchema = z.object({
  name: z.string().trim().min(1, 'Article name is required').max(200),
  type: ArticleTypeSchema.optional(),
  unit: z.preprocess(blankAsUnset, z.string().trim().min(1).max(32).optional()),
  price_excl_vat: nonNegativeAmount,
  vat_rate: vatRatePercent.optional(),
  // Default price currency; omitted = SEK. Pre-fills a new invoice's currency.
  // Constrained to the same CurrencySchema enum invoices use, which mirrors the
  // seeded currencies reference table: an unknown code is a clean 400 here
  // instead of a raw FK violation (23503) surfacing at insert time. Case is
  // not significant ('eur' is EUR).
  currency: z.preprocess(
    (v) => (v == null ? undefined : typeof v === 'string' ? blankAsUnset(v.trim().toUpperCase()) : v),
    CurrencySchema.optional(),
  ),
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
  // The VAT per rate the customer's document states (percent rates, like the
  // items). Omitted: the VAT on the summed base per rate (crm#1367).
  vat_breakdown: SelfBilledVatBreakdownSchema.optional(),
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
// service where the buyer is established. At spawn, executeRecurringSchedule
// adopts a stored rate only when it is in that default set (the invoice
// editor's rule, getArticleVatRateAdoptionSet), so a stored 25/12/6 on a line
// to such a customer bills 0% (crm#1285); a supply taxed where it is performed
// (fastighetstjänst, persontransport, restaurang/catering, ...) is invoiced
// from the editor, where the rate is picked per line. A stored rate outside
// getPermittedVatRates still refuses the run.
// A rate outside 0/6/12/25 is rejected here: there is no such Swedish rate, and
// the buyer could not deduct ingående moms on it.
export const RecurringScheduleItemSchema = z
  .object({
    // 'text' = free-text or blank spacer row copied onto every generated
    // invoice as a text row: description only (may be empty), amounts
    // ignored. Defaults to 'product'.
    line_type: z.enum(['product', 'text']).optional(),
    description: z.string().max(2000),
    quantity: z.number(),
    unit: z.string().default('st'),
    unit_price: z.number(),
    vat_rate: z
      .union([z.literal(0), z.literal(6), z.literal(12), z.literal(25)])
      .nullable()
      .optional(),
    // Copied onto the generated invoice_items.dimensions; merges over the
    // schedule's default_dimensions on that item's revenue line.
    dimensions: DimensionsBagSchema.optional(),
    // Article the line was picked from (accounted#52). Every door checks it
    // belongs to the company; the spawn copies it onto the invoice line with
    // the article's number and revenue account. Ignored on text rows.
    article_id: uuid.nullable().optional(),
  })
  .superRefine((item, ctx) => {
    if (item.line_type === 'text') return
    if (item.description.trim().length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['description'], message: 'Item description is required' })
    }
    if (item.quantity <= 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['quantity'], message: 'Quantity must be positive' })
    }
    if (item.unit.trim().length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['unit'], message: 'Unit is required' })
    }
  })

// A schedule needs something to bill: text rows alone make an empty invoice.
function requireBillableRecurringLine(
  items: ReadonlyArray<{ line_type?: string }> | undefined,
  ctx: z.RefinementCtx,
): void {
  if (items && !items.some((item) => item.line_type !== 'text')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['items'],
      message: 'At least one billable (non-text) line is required',
    })
  }
}

// Object form kept separate so callers that need .strict() (the MCP staged
// params) can add it before the refinement; the refined form is the API's.
export const CreateRecurringScheduleObjectSchema = z.object({
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
  // First day of the billing period the first generated invoice covers.
  // Unlocks {periodstart}/{periodslut}/{nästa periodstart} in notes and line
  // descriptions; advanced by interval_months after every run.
  period_start: isoDate.nullable().optional(),
  items: z.array(RecurringScheduleItemSchema).min(1, 'At least one item is required'),
})

export function refineCreateRecurringSchedule(
  data: z.infer<typeof CreateRecurringScheduleObjectSchema>,
  ctx: z.RefinementCtx,
): void {
  requireBillableRecurringLine(data.items, ctx)
  if (
    !data.period_start
    && mentionsPeriodPlaceholder([data.notes, ...data.items.map((item) => item.description)])
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['period_start'],
      message: PERIOD_PLACEHOLDER_REQUIRES_START_MESSAGE,
    })
  }
}

export const CreateRecurringScheduleSchema =
  CreateRecurringScheduleObjectSchema.superRefine(refineCreateRecurringSchedule)

export const UpdateRecurringScheduleObjectSchema = z.object({
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
  // null clears the period (the period placeholders then must not be used).
  period_start: isoDate.nullable().optional(),
  // Replace all items if provided. Omit to keep existing items unchanged.
  items: z.array(RecurringScheduleItemSchema).min(1).optional(),
})

export function refineUpdateRecurringSchedule(
  data: z.infer<typeof UpdateRecurringScheduleObjectSchema>,
  ctx: z.RefinementCtx,
): void {
  requireBillableRecurringLine(data.items, ctx)
}

// The period-placeholder rule for updates needs the stored row (a partial
// update may only touch notes); the routes and the MCP executor check it
// with assertPeriodPlaceholdersResolvable after merging with the row.
export const UpdateRecurringScheduleSchema =
  UpdateRecurringScheduleObjectSchema.superRefine(refineUpdateRecurringSchedule)

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
  }).refine(isSingleSidedLine, SINGLE_SIDED_LINE_ISSUE)).min(2).optional(),
  // Bypass the duplicate-payment guard. Set after the user reviews the
  // candidate list returned by INVOICE_PAID_LIKELY_DUPLICATE and confirms
  // none of them are this payment. v1 callers must use a fresh
  // Idempotency-Key on the retry: the original is body-hash bound.
  force: z.boolean().optional(),
  // crm#1823: the 19xx account the payment landed on, when it is not the one
  // the invoice asked to be paid to. One of the company's own enabled cash
  // accounts (resolveInvoicePaymentAccount). Custom lines carry their own
  // accounts, so the two are not sent together.
  payment_account: accountNumber
    .refine(isPaidAtIssueAccount, { message: 'Betalkontot måste vara ett 19xx-konto (kassa, bank eller Swish)' })
    .optional()
    .describe(
      'The 19xx account the payment landed on (on a credit note: the account the refund left). One of the company\'s own enabled cash accounts, else 400 INVOICE_PAID_PAYMENT_ACCOUNT_INVALID with the accounts that can be named. Omitted: the account the invoice asked to be paid to, else the company\'s primary bank account. Not combinable with lines.',
    ),
}).refine((body) => !(body.payment_account && body.lines), {
  path: ['payment_account'],
  message: 'payment_account and lines are not sent together: custom lines carry their own accounts',
})

export const MarkInvoiceSentSchema = z.object({
  // Optional user-edited issuance lines ("Markera som skickad och bokför").
  // When present they replace the generated invoice entry verbatim: the route
  // validates balance and books exactly these lines, and accrual schedules
  // are NOT created (what the user reviewed is what books). Only honored on
  // the accrual book-at-issue path; ignored for credit notes, cash-method
  // and deferred-booking companies, which don't book at mark-sent.
  //
  // The single-side rule (#2551) is the one place it is NOT declared as a
  // refinement here: both consumers of this schema (mark-sent and send) run
  // every line through parseCustomIssuanceLines, whose own both-sides check
  // predates it and returns the targeted INVOICE_MARK_SENT_LINES_INVALID
  // instead of a generic "Ogiltig förfrågan". A refinement here would fire
  // first and downgrade that message. The rule still holds on this path:
  // parseCustomIssuanceLines, then the engine, then the DB CHECK.
  lines: z.array(z.object({
    account_number: accountNumber,
    debit_amount: nonNegativeAmount.default(0),
    credit_amount: nonNegativeAmount.default(0),
    line_description: z.string().optional(),
    dimensions: DimensionsBagSchema.optional(),
  })).min(2).optional(),
})

// The kontantfaktura (crm#1281, lib/invoices/paid-at-issue.ts): mark-sent
// only. The invoice is issued already paid, on its fakturadatum, to this
// 19xx account (kassa, bank, Swish), as one cash verifikat in either
// accounting method. Deliberately NOT on MarkInvoiceSentSchema: the send
// route extends that schema and would silently drop the field, emailing an
// unpaid invoice while the caller believes it is paid.
export const MarkInvoiceSentPaidAtIssueSchema = z.object({
  paid_at_issue: z
    .object({
      account_number: accountNumber.refine(isPaidAtIssueAccount, {
        message: 'Betalkontot måste vara ett 19xx-konto (kassa, bank eller Swish)',
      }),
    })
    .optional(),
})

// Bulk Bokför: drafts are issued (F-number + mark-sent semantics, no email)
// and booked when the company books at issue; sent/overdue unbooked invoices
// get the deferred /book semantics. 200 caps one request at two list pages.
export const InvoicesBulkBookSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
})

export const INVOICE_EMAIL_SUBJECT_MAX_LENGTH = 200
export const INVOICE_EMAIL_BODY_MAX_LENGTH = 5000

/**
 * This send's own email subject and message, in place of the company's
 * texts (Inställningar > Utskick) or the stock texts. For this send only:
 * never stored on the invoice, though the delivery history keeps the email
 * as it was sent. Same placeholders as the company texts. Empty or
 * whitespace-only = no override.
 */
export const InvoiceEmailOverrideShape = {
  email_subject: z
    .string()
    .max(INVOICE_EMAIL_SUBJECT_MAX_LENGTH)
    .nullish()
    .describe(
      'This send only: the email subject instead of the company text. Placeholders {fakturanummer}, {kundnamn}, {förnamn}, {företag}, {förfallodatum}, {belopp}. Not stored on the invoice.',
    ),
  email_body: z
    .string()
    .max(INVOICE_EMAIL_BODY_MAX_LENGTH)
    .nullish()
    .describe(
      'This send only: the message of the email instead of the company text (the greeting and sign-off stay). Same placeholders as email_subject. Not stored on the invoice.',
    ),
}

export const SendInvoiceSchema = MarkInvoiceSentSchema.extend({
  additional_cc: invoiceEmailAddressList.optional(),
  additional_bcc: invoiceEmailAddressList.optional(),
  ...InvoiceEmailOverrideShape,
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

/**
 * POST /api/invoices/[id]/attachments: attach documents already in the
 * archive (uploaded through POST /api/documents) to a draft invoice. The
 * upper bound is lib/invoices/invoice-attachments MAX_INVOICE_ATTACHMENTS.
 */
export const LinkInvoiceAttachmentsSchema = z.object({
  document_ids: z.array(uuid).min(1).max(10),
})

/**
 * POST /api/invoices/[id]/uncredit: Ångra kreditering
 * (lib/invoices/uncredit-invoice.ts). attest_not_delivered is the person's
 * word that a credit note marked as sent never reached the customer.
 */
export const UncreditInvoiceSchema = z.object({
  dry_run: z.boolean().optional(),
  attest_not_delivered: z.boolean().optional(),
})

/** POST /api/invoices/preview-email: the preview draft plus this send's own texts. */
export const InvoiceEmailPreviewSchema = InvoicePreviewSchema.extend(InvoiceEmailOverrideShape)

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

const INDIVIDUAL_ORG_NUMBER_MESSAGE =
  'An individual customer has no org number: org_number must be empty or the person\'s personnummer '
  + '(which is stored as personal_number). Use customer_type "swedish_business" for a business.'

/**
 * Fakturareferens (crm#1200): '' and null both mean none (on update, a clear).
 * The customer commands store a blank as NULL.
 */
const CustomerInvoiceReferenceSchema = z
  .string()
  .trim()
  .max(200)
  .nullable()
  .optional()
  .describe('Fakturareferens: the Er referens (your_reference) a new invoice to this customer gets when the request states none.')

/**
 * Märkning (crm#1477): '' and null both mean none (on update, a clear), as
 * for the Fakturareferens.
 */
const CustomerInvoiceMarkingSchema = z
  .string()
  .trim()
  .max(200)
  .nullable()
  .optional()
  .describe('Märkning: the invoice_marking (Peppol BT-13 OrderReference) a new invoice to this customer gets when the request states none.')

/**
 * State or province of a US or Canadian customer ('WA'), printed "City, ST
 * ZIP" (lib/invoices/postal-address.ts). Blank is none: the write stores null.
 */
const CustomerAddressStateSchema = z.string().trim().max(100).optional()

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
  // Optional on the customer: '' (an untouched form field) means no email,
  // same as omitting it. UpdateCustomerSchema reads '' as a clear.
  email: emptyStringAsUndefined(z.string().email('Invalid email address')),
  phone: z.string().optional(),
  invoice_email_cc_addresses: invoiceEmailAddressList.nullable().optional(),
  invoice_email_bcc_addresses: invoiceEmailAddressList.nullable().optional(),
  address_line1: z.string().optional(),
  address_line2: z.string().optional(),
  postal_code: z.string().optional(),
  city: z.string().optional(),
  address_state: CustomerAddressStateSchema,
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
  invoice_reference: CustomerInvoiceReferenceSchema,
  invoice_marking: CustomerInvoiceMarkingSchema,
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
  // A Swedish enskild firma's org number IS its owner's personnummer, so
  // swedish_business accepts one and the list surfaces mask it
  // (orgNumberIsPersonalIdentifier). Only the foreign business types, where
  // the value cannot be an org number at all, still refuse it.
  if (isPersonalNumberOrgNumberDisallowed(customer.customer_type, customer.org_number)) {
    ctx.addIssue({
      code: 'custom',
      path: ['org_number'],
      message:
        'org_number looks like a Swedish personal identity number (personnummer), which a foreign '
        + 'business cannot have. Use customer_type "swedish_business" for a Swedish enskild firma, or '
        + '"individual" with the number passed as personal_number for a private person.',
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
  // A privatperson has no org number. Anything on an individual that is not
  // its personnummer (rerouted above) is refused here rather than stored.
  if (isOrgNumberRefusedOnIndividual(customer.customer_type, customer.org_number)) {
    ctx.addIssue({
      code: 'custom',
      path: ['org_number'],
      message: INDIVIDUAL_ORG_NUMBER_MESSAGE,
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
  // Optional on the customer, so a cleared field is a clear: '' and null both
  // store NULL. MCP and v1 PATCH reuse this shape.
  email: emptyStringAsNull(z.string().email('Invalid email address')),
  phone: z.string().optional(),
  invoice_email_cc_addresses: invoiceEmailAddressList.nullable().optional(),
  invoice_email_bcc_addresses: invoiceEmailAddressList.nullable().optional(),
  address_line1: z.string().optional(),
  address_line2: z.string().optional(),
  postal_code: z.string().optional(),
  city: z.string().optional(),
  address_state: CustomerAddressStateSchema,
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
  invoice_reference: CustomerInvoiceReferenceSchema,
  invoice_marking: CustomerInvoiceMarkingSchema,
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

/**
 * suppliers.org_number is stored as the 10-digit key (#2391): the form asks
 * for XXXXXX-XXXX and the AI extractor emits bare digits, and the matcher
 * compares through the same key, so storage is canonical whatever the caller
 * typed. Only Swedish-shaped input (10 or 12 digits once separators are
 * stripped) is rewritten; a foreign registration number or an unrecognised
 * value is stored as typed, because eu_business and non_eu_business
 * suppliers keep their home-registry number in this column.
 */
const supplierOrgNumber = z.string().transform((v) => orgNumberKey(v) ?? v.trim())

/**
 * A payment-routing field: free text a payment file reads, so a value that
 * cannot route a payment is refused at every door (the dashboard, v1 and the
 * agent's create_supplier used to apply three different rule sets). An empty
 * string passes: on create it means "not set", on update "clear it".
 */
/**
 * A payment routing number, blank or valid. The refusal is Swedish, for the
 * person at the form; params.en keeps the English for an agent's field
 * refusal (lib/errors/refusal.ts fieldIssue).
 */
function paymentRoutingField(max: number, valid: (compact: string) => boolean, message: { sv: string; en: string }) {
  return z
    .string()
    .max(max)
    .refine((v) => v.trim() === '' || valid(v.replace(/\s/g, '').toUpperCase()), { message: message.sv, params: { en: message.en } })
    .optional()
}

/**
 * The supplier register's one rule set: the dashboard form, v1 and the MCP
 * gnubok_create_supplier create through it (lib/suppliers/create-supplier.ts),
 * and UpdateSupplierSchema is its partial.
 */
export const CreateSupplierSchema = z.object({
  name: z.string().trim().min(1, 'Supplier name is required').max(255),
  // Omitted: swedish_business, as the agent path always defaulted it.
  supplier_type: SupplierTypeSchema.optional(),
  email: emptyStringAsUndefined(z.string().email('Invalid email address').max(255)),
  phone: z.string().max(50).optional(),
  address_line1: z.string().max(255).optional(),
  address_line2: z.string().max(255).optional(),
  postal_code: z.string().max(20).optional(),
  city: z.string().max(100).optional(),
  country: CountryCodeSchema,
  org_number: supplierOrgNumber.optional(),
  // Free text: a non-EU supplier's tax number has no VIES prefix, and reverse
  // charge never reads it (see lib/bookkeeping/supplier-invoice-entries.ts).
  vat_number: z.string().max(20).optional(),
  bankgiro: paymentRoutingField(20, validateBankgiroNumber, {
    sv: 'Bankgironumret stämmer inte: det har 7 eller 8 siffror och en kontrollsiffra. Kontrollera det mot fakturan.',
    en: 'Invalid Bankgiro (must be 7-8 digits with valid Luhn check digit)',
  }),
  plusgiro: paymentRoutingField(20, (v) => /^\d{1,7}-?\d$/.test(v), {
    sv: 'Plusgironumret stämmer inte: det har 2 till 8 siffror. Kontrollera det mot fakturan.',
    en: 'Invalid Plusgiro (expected 2-8 digits)',
  }),
  bank_account: z.string().max(50).optional(),
  iban: paymentRoutingField(42, (v) => /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(v), {
    sv: 'IBAN stämmer inte: det börjar med två bokstäver för landet, till exempel SE, och två siffror.',
    en: 'Invalid IBAN format',
  }),
  bic: paymentRoutingField(11, (v) => /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(v), {
    sv: 'BIC/SWIFT stämmer inte: den har 8 eller 11 tecken, till exempel ESSESESS.',
    en: 'Invalid BIC/SWIFT format',
  }),
  clearing_number: z.string().optional(),
  account_number: z.string().optional(),
  default_expense_account: emptyStringAsUndefined(accountNumber),
  // Whole days 0-365; 0 = betalning direkt / vid mottagande (issue #2070).
  default_payment_terms: z.number().int().min(0).max(365).optional(),
  default_currency: CurrencySchema.nullable().optional(),
  // The self-billing agreement with the supplier (ML 2023:200 17 kap 15 §
  // p.1): the reference a självfaktura to it prints (crm#1367). Without one
  // no self-billing invoice can be issued to the supplier.
  self_billing_agreement_ref: emptyStringAsUndefined(z.string().trim().min(1).max(128)),
  // The supplier debits its invoices itself (autogiro, account debit):
  // they stay out of to-pay lists and payments (crm#1463).
  auto_debit: z.boolean().optional(),
  // The dimension bag ({sie_dim_no: code}) its new supplier invoices take
  // when they name none; {} clears it (accounted#144,
  // lib/suppliers/default-dimensions.ts).
  default_dimensions: DimensionsBagSchema.optional(),
  notes: z.string().max(2000).optional(),
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
  self_billing_agreement_ref: emptyStringAsNull(z.string().trim().min(1).max(128)),
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
  // VAT off by öre. Carries the line's sign: a negative line (a discount or
  // a credited period inside the invoice) carries negative VAT.
  vat_amount: z.number().optional(),
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
  // Periodisering: spread the line's net cost over the service period. The
  // registration entry debits the interim account instead of account_number;
  // input VAT is never deferred. 17xx is a förutbetald kostnad (months from
  // the invoice on), 29xx an upplupen kostnad (months before the invoice
  // month, each booked on its last day).
  accrual_period_start: isoDate.nullable().optional(),
  accrual_period_end: isoDate.nullable().optional(),
  accrual_balance_account: expenseAccrualAccount.nullable().optional(),
  // Dimensions PR7: per-item bag merged over the invoice's
  // default_dimensions on the expense line this item books to.
  dimensions: DimensionsBagSchema.optional(),
}).refine(
  (item) => {
    if (item.vat_amount == null || item.vat_amount === 0) return true
    const lineTotal = item.amount != null
      ? item.amount
      : (item.quantity ?? 1) * (item.unit_price ?? 0)
    const vatRate = item.vat_rate ?? 0.25
    if (Math.sign(item.vat_amount) !== Math.sign(lineTotal)) return false
    // 1-öre tolerance covers POS rounding; anything beyond is an upstream bug
    // or a client trying to inflate 2641 debit beyond the statutory ceiling.
    return roundOre(Math.abs(item.vat_amount)) <= roundOre(Math.abs(netVat(lineTotal, vatRate)) + 0.01)
  },
  {
    message: 'vat_amount must have the sign of the line and cannot exceed line_total × vat_rate',
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

// The supplier's own invoice number, stored exactly as given. A value with no
// visible character is refused here as the database refuses it
// (supplier_invoices_number_not_blank): a missing number is NULL, never ''.
// Registering by hand or through the API still needs a number; only the
// provider import stores an invoice without one (crm#1039).
export const supplierInvoiceNumber = z
  .string()
  .min(1, 'Supplier invoice number is required')
  .regex(/\S/, 'Supplier invoice number is required')

/**
 * The number rules of a supplier invoice: the supplier's own number is
 * required on an ordinary one, and refused on a self-billing invoice, whose
 * number the database assigns from the company's series (crm#1367). The
 * agreement reference belongs to a self-billing invoice only.
 */
function addSelfBillingNumberIssues(
  invoice: { is_self_billed?: boolean; supplier_invoice_number?: string; self_billing_agreement_ref?: string },
  ctx: z.RefinementCtx,
): void {
  if (invoice.is_self_billed) {
    if (invoice.supplier_invoice_number !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['supplier_invoice_number'],
        message: 'A self-billing invoice takes its number from the company series: omit supplier_invoice_number',
      })
    }
    return
  }
  if (invoice.supplier_invoice_number === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['supplier_invoice_number'],
      message: 'Supplier invoice number is required',
    })
  }
  if (invoice.self_billing_agreement_ref !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['self_billing_agreement_ref'],
      message: 'self_billing_agreement_ref is only accepted with is_self_billed',
    })
  }
}

export const CreateSupplierInvoiceSchema = z.object({
  supplier_id: uuid,
  // Optional invoice PDF/image already stored in the WORM document archive.
  // The route verifies company ownership and that the document is unused.
  document_id: uuid.optional(),
  // Required, except on a self-billing invoice, which takes its number from
  // the company's own series (refused there: superRefine below).
  supplier_invoice_number: supplierInvoiceNumber.optional(),
  // Självfaktura (crm#1367): we issue the invoice in the supplier's name
  // under a prior agreement (ML 2023:200 17 kap 15 §). The number comes from
  // the company's self-billing series and Accounted makes the document.
  is_self_billed: z.boolean().optional(),
  // The agreement the self-billing invoice is issued under. Defaults to the
  // supplier card's self_billing_agreement_ref; only with is_self_billed.
  self_billing_agreement_ref: z.string().trim().min(1).max(128).optional(),
  invoice_date: isoDate,
  // Omitted: invoice_date + the supplier's default_payment_terms (30 days
  // when unset), the same rule the dashboard form and the inbox apply.
  due_date: isoDate.optional(),
  delivery_date: optionalIsoDate,
  currency: CurrencySchema.optional(),
  // Bounded by the shared `exchangeRate` primitive so the value can never
  // reach `supplier_invoices_exchange_rate_check` and come back as a 500.
  exchange_rate: exchangeRate.optional(),
  vat_treatment: VatTreatmentSchema.optional(),
  reverse_charge: z.boolean().optional(),
  // Under reverse charge from a supplier in another EU country: goods
  // (eu_goods, basis 4515-4517, ruta 20) or services (eu_services, 4535-4537,
  // ruta 21). Omitted books services. Refused for any other supplier type or
  // without reverse charge (resolveSupplierInvoiceReverseChargeKind).
  reverse_charge_kind: z.enum(SUPPLIER_INVOICE_REVERSE_CHARGE_KINDS).optional(),
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
  // items[].dimensions merge over it per expense line. Omitted: the
  // supplier's default_dimensions; {} registers the invoice untagged
  // (lib/suppliers/default-dimensions.ts).
  default_dimensions: DimensionsBagSchema.optional(),
  // The VAT per rate the supplier's document states. Omitted: the VAT on the
  // summed base per rate. Either way it is spread onto the lines so they sum
  // to it (lib/vat/document-vat.ts, crm#1367). Refused under reverse charge
  // and for exempt or export purchases, which carry no Swedish VAT.
  vat_breakdown: SupplierVatBreakdownSchema.optional(),
  items: z.array(CreateSupplierInvoiceItemSchema).min(1, 'At least one item is required'),
}).superRefine((invoice, ctx) => {
  addSelfBillingNumberIssues(invoice, ctx)

  // The per-item vat_amount ceiling can only assume 25 % when a line omits
  // vat_rate: the invoice's vat_treatment, which actually decides the rate,
  // is visible one level up (issue #2553). Two rules follow from it.
  const treatment = invoice.vat_treatment
  const deducts = treatmentDeductsInputVat(treatment)
  const treatmentRate = defaultVatRateForTreatment(treatment)
  if (invoice.vat_breakdown && (!deducts || invoice.reverse_charge === true || treatment === 'reverse_charge')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['vat_breakdown'],
      message: 'vat_breakdown is only accepted on an invoice that charges Swedish VAT (not reverse charge, exempt or export)',
    })
  }
  invoice.items.forEach((item, index) => {
    const lineTotal = item.amount != null
      ? item.amount
      : (item.quantity ?? 1) * (item.unit_price ?? 0)

    // 1. exempt / export: the supplier charges no Swedish moms (an exempt
    //    supply is undantagen, ML 10 kap; an export purchase carries none
    //    either), so no line may claim a rate or an amount. Without this the
    //    line passed validation and the 0.25 column default booked input VAT
    //    on 2641 that was never invoiced.
    if (!deducts) {
      if ((item.vat_rate ?? 0) !== 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['items', index, 'vat_rate'],
          message: `vat_treatment '${treatment}' carries no Swedish VAT: vat_rate must be 0 or omitted`,
        })
      }
      if ((item.vat_amount ?? 0) !== 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['items', index, 'vat_amount'],
          message: `vat_treatment '${treatment}' carries no Swedish VAT: vat_amount must be 0 or omitted`,
        })
      }
      return
    }

    // 2. A line that omits vat_rate is booked at the treatment's rate, so
    //    that is the ceiling its manual vat_amount override has to respect:
    //    on a reduced_12 invoice the item-level check would otherwise wave
    //    through a 25 % override.
    if (item.vat_amount == null || item.vat_rate != null) return
    const maxVat = Math.abs(netVat(lineTotal, treatmentRate))
    // Same 1-öre POS tolerance as the item-level refine.
    if (roundOre(Math.abs(item.vat_amount)) > roundOre(maxVat + 0.01)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['items', index, 'vat_amount'],
        message: `vat_amount cannot exceed line_total × the vat_treatment rate (${treatmentRate})`,
      })
    }
  })

  // Periodisering: a period that lies only in the invoice month books the
  // cost to 17xx and straight back in the same month, two verifikat that
  // cancel out. The item schema cannot see invoice_date, so the rule is here.
  for (const index of invoiceMonthOnlyAccrualRows(invoice.invoice_date, invoice.items)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['items', index, 'accrual_period_end'],
      message: 'Perioden måste omfatta en annan månad än fakturamånaden',
    })
  }

  // An upplupen kostnad (29xx) is the cost of months before the invoice
  // month. A period that reaches the invoice month is refused, not split:
  // the user splits the line (the invoice month's share is no accrual).
  if (!ISO_DATE_RE.test(invoice.invoice_date)) return
  invoice.items.forEach((item, index) => {
    if (!isAccruedCostAccount(item.accrual_balance_account) || !item.accrual_period_end) return
    if (periodEndsBeforeInvoiceMonth(item.accrual_period_end, invoice.invoice_date)) return
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['items', index, 'accrual_period_end'],
      message:
        'En upplupen kostnad (29xx) måste avse månader före fakturamånaden. Dela raden: ' +
        'månaderna före fakturamånaden på 29xx och resten som förutbetald kostnad (17xx) eller direkt på kostnadskontot.',
    })
  })

  // The opposite (accounted#113): a förutbetald kostnad (17xx) of months that
  // ended before the invoice month would book all of them on the invoice
  // date. An omitted account gets the upplupen one server side instead.
  invoice.items.forEach((item, index) => {
    if (!item.accrual_period_start || !item.accrual_balance_account) return
    const suggested = pastPeriodDeferralSuggestion(
      { direction: 'expense', targetAccount: item.account_number },
      item.accrual_balance_account,
      item.accrual_period_end,
      invoice.invoice_date,
    )
    if (!suggested) return
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['items', index, 'accrual_balance_account'],
      message:
        `Perioden slutar före fakturamånaden, så kostnaden är en upplupen kostnad: välj ${suggested} i stället för ` +
        `${item.accrual_balance_account}, så bokförs varje månad i sin egen månad. På 17xx skulle hela beloppet bokföras på fakturadatumet.`,
    })
  })
})

// Pre-submit duplicate lookup for the supplier-invoice editor. Mirrors the
// partial unique index idx_supplier_invoices_company_supplier_number on
// (company_id, supplier_id, supplier_invoice_number), which excludes
// credited/reversed invoices, so the advisory never warns on the re-issue
// pattern the index was widened to allow. The payment reference is looked
// for among the same live invoices; the number, the reference or both. The
// invoice date and the amount to pay (with its currency, SEK when omitted)
// look for the same document again among the invoices with the reference.
export const SupplierInvoiceExistsQuerySchema = z
  .object({
    supplier_id: uuid,
    number: z.string().min(1).max(200).optional(),
    reference: z.string().min(1).max(200).optional(),
    invoice_date: isoDate.optional(),
    total: z.coerce.number().finite().optional(),
    currency: CurrencySchema.optional(),
  })
  .refine((query) => query.number !== undefined || query.reference !== undefined, {
    path: ['number'],
    message: 'number or reference is required',
  })

export const MarkSupplierInvoicePaidSchema = z.object({
  amount: z.number().positive().optional(),
  payment_date: isoDate.optional(),
  exchange_rate_difference: z.number().optional(),
  // #2955: the SEK that actually left the payment account, for a
  // foreign-currency invoice. The amount cleared off 2440 is read from the
  // ledger; a difference to it books as kursvinst (3960) or kursförlust (7960).
  amount_sek: z
    .number()
    .positive()
    .optional()
    .describe(
      'Foreign-currency invoices only: the SEK that left the payment account for this payment. Defaults to the SEK the invoice carries on 2440 for the paid share (no kursdifferens); a different figure books the difference on 3960 (gain) or 7960 (loss). Under kontantmetoden (no registration verifikat) it instead translates the whole payment verifikat at the rate it implies. Not combinable with exchange_rate_difference or lines.',
    ),
  notes: z.string().optional(),
  force: z.boolean().optional(),
  // Which BAS account to credit for the payment. Omitted: the company's
  // primary bank account.
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
  }).refine(isSingleSidedLine, SINGLE_SIDED_LINE_ISSUE)).min(2).optional(),
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
  supplier_invoice_number: supplierInvoiceNumber.optional(),
  invoice_date: isoDate.optional(),
  due_date: isoDate.optional(),
  delivery_date: optionalIsoDate,
  payment_reference: z.string().optional(),
  notes: z.string().optional(),
  // "Dras automatiskt" (crm#1463): the supplier debits the invoice itself, so
  // it stays out of to-pay lists and payments. New invoices take it from the
  // supplier card (inherit_supplier_auto_debit); this changes one invoice.
  auto_debit: z.boolean().optional(),
})

/**
 * PATCH /api/supplier-invoices/[id]/items/[itemId]: move one line to another
 * expense account. The registration verifikat is corrected inline (BFL 5 kap
 * 5 §, track 2) in the same call, so the invoice and the ledger never
 * disagree about where the cost sits.
 */
export const SupplierInvoiceItemAccountSchema = z.object({
  account_number: accountNumberSchema,
})

// ============================================================
// Supplier payment batch (betalfil) schemas
// ============================================================

// No format: the company's bank decides the file form (pain.001, or the LB
// file for a bank that takes no pain.001; batchFileFormat). An old client's
// `format` is stripped like any unknown key.
export const PreviewSupplierPaymentBatchSchema = z.object({
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
  // for API/MCP compatibility. They land in the same bag, so they carry the
  // bag's value rule (and the jel_dimensions_well_formed CHECK): a bad alias
  // is a 400 here, not a database error at insert. Blank still means untagged.
  cost_center: z
    .string()
    .trim()
    .max(40, 'Kostnadsställe får vara högst 40 tecken')
    .regex(/^[^"{}]*$/, 'Kostnadsställe får inte innehålla ", { eller }')
    .optional(),
  project: z
    .string()
    .trim()
    .max(40, 'Projekt får vara högst 40 tecken')
    .regex(/^[^"{}]*$/, 'Projekt får inte innehålla ", { eller }')
    .optional(),
}).refine(isSingleSidedLine, SINGLE_SIDED_LINE_ISSUE)

const SOURCE_ID_NOT_UUID_MESSAGE =
  'source_id måste vara ett UUID: id:t på posten i Accounted som verifikatet bokförs från. ' +
  'En referens från ett annat system hör hemma i description eller notes.'

export const CreateJournalEntrySchema = z.object({
  fiscal_period_id: uuid,
  entry_date: isoDate,
  description: z.string().min(1, 'Description is required'),
  source_type: JournalEntrySourceTypeSchema.default('manual'),
  // journal_entries.source_id is a uuid column: a free-form external reference
  // ("<provider>:<date>") reached the insert and answered 500
  // BOOKKEEPING_DATABASE_ERROR. The shape check is lib/invariants/uuid.ts
  // (any hex layout, not RFC version strictness), so a hyphenated uuid the
  // column took before still passes. '' stays accepted: the engine stores it
  // as null.
  source_id: z
    .string({ error: SOURCE_ID_NOT_UUID_MESSAGE })
    .refine((value) => value === '' || isUuid(value), { error: SOURCE_ID_NOT_UUID_MESSAGE })
    .optional()
    .describe(
      'Id (UUID) of the Accounted record this voucher is booked from, e.g. the bank transaction for source_type ' +
        'bank_transaction. Not an external reference: put another system\'s reference in description or notes ' +
        '(a retried request is recognised by its Idempotency-Key).',
    ),
  bank_booking_context: z.array(z.object({
    transaction_id: uuid,
    cash_account_id: uuid.nullable(),
    target_cash_account_id: uuid.optional(),
    settlement_account: accountNumber,
    date: isoDate,
    amount: z.number().finite(),
    currency: z.string().regex(/^[A-Z]{3}$/),
  })).optional(),
  voucher_series: z.string().regex(/^[A-Z]$/, 'Verifikationsserie måste vara en bokstav A-Z').optional(),
  notes: z.string().max(2000).optional(),
  lines: z.array(CreateJournalEntryLineSchema).min(2, 'At least two lines are required for double-entry'),
})

/**
 * source_type values a caller may put on a voucher it authors through a
 * generic create door. The label is load-bearing, not decoration: it decides
 * the dimension-rule and registry-validation exemptions
 * (lib/bookkeeping/dimension-rules.ts), keeps 'vat_settlement' out of the VAT
 * return, scopes SIE replacement to 'import' and gates storno/correction
 * handling. A caller-chosen engine-owned label let a business voucher claim
 * a policy exemption and show a false source in the ledger.
 *
 *   API (v1 POST /journal-entries and /journal-entries/batch-create): every
 *     source type the dimension-rule policy ENFORCES. Integrations label
 *     their own business vouchers with them (a webshop integration posts
 *     'webshop_order' vouchers through this door), and those labels claim
 *     nothing. The rule-exempt, engine-owned types (opening balances,
 *     bokslut, storno, corrections, credit notes, accruals, settlements,
 *     'system') are refused. 'import' is refused too: an import voucher
 *     needs the durable batch identity only the SIE import engine writes
 *     (guard_sie_entry_provenance raises 23514 without one), so the label
 *     could never post here and answered 500. History from another system
 *     goes through POST /imports/sie, or is booked as 'manual'. Derived from
 *     DIMENSION_RULE_POLICY, so a new source type is classified once there
 *     and this door follows.
 *   Dashboard (POST /api/bookkeeping/journal-entries): 'manual', plus
 *     'vat_settlement' for the reviewed momsredovisning proposal and VAT
 *     booking templates (lib/bookkeeping/template-source-type.ts).
 */
export const API_VOUCHER_SOURCE_TYPES: readonly JournalEntrySourceType[] = (
  Object.keys(DIMENSION_RULE_POLICY) as JournalEntrySourceType[]
).filter((sourceType) => DIMENSION_RULE_POLICY[sourceType] === 'enforced')

/** The v1 voucher doors' answer to source_type 'import': what to use instead. */
export const API_IMPORT_SOURCE_TYPE_MESSAGE =
  'source_type "import" kan inte sättas här: importerade verifikat kräver en importbatch, och den skapar bara ' +
  'SIE-importen. Importera historik från ett annat system som en SIE4-fil med POST ' +
  '/api/v1/companies/{companyId}/imports/sie, eller bokför verifikaten med source_type "manual" (standard).'
export const DASHBOARD_VOUCHER_SOURCE_TYPES = ['manual', 'vat_settlement'] as const

/**
 * A konteringsrad's momskod on the voucher API and the MCP tool create_voucher
 * (crm#1096): a reverse-charge purchase the server expands into its lines
 * (expandVoucherLineVatCodes). The rate is a fraction like every
 * self-assessed rate in the API (reverse_charge_rate, default_vat_rate).
 */
export const VoucherLineVatCodeSchema = z.object({
  kind: z.enum(VOUCHER_LINE_VAT_KINDS),
  // A union of literals, as vatRateDecimal: the v1 spec renders each rate.
  // The reasons are Swedish, so they reach message_sv on the MCP door as well
  // (zodFieldIssues keeps a schema's Swedish words, a union has no rendering
  // of its own), and a missing rate is not answered with the percent hint.
  rate: z.union(VOUCHER_LINE_VAT_RATES.map((rate) => z.literal(rate)), {
    error: (issue) =>
      issue.input === undefined
        ? 'rate krävs: 0.25, 0.12 eller 0.06'
        : 'rate måste vara ett decimaltal, inte procent: 0.25, 0.12 eller 0.06',
  }),
})

/** POST /api/v1/companies/{companyId}/journal-entries (+ batch-create items). */
export const CreateApiJournalEntrySchema = CreateJournalEntrySchema.extend({
  lines: z
    .array(
      CreateJournalEntryLineSchema.extend({
        vat_code: VoucherLineVatCodeSchema.nullish().describe(
          'Momskod for a reverse-charge purchase (omvänd betalningsskyldighet) booked on this BAS class 4-6 cost line: ' +
            'the server adds its lines directly under it, the fiktiv moms (2645, or 2647 for domestic_services, debit; ' +
            '2614/2624/2634 credit) and the basis pair (44xx/45xx debit, 4598 credit), on the line\'s SEK amount. ' +
            'kind: eu_goods (ruta 20), eu_services (21), non_eu_services (22), domestic_services (24, e.g. byggtjänster). ' +
            'rate: 0.25, 0.12 or 0.06. On an account that reports ruta 20-24 itself (4531, or a kontoplan momskod that is ' +
            'reverse charge) only the account\'s own kind and rate are accepted and no basis pair is added. ' +
            'Omit or null for none: no line gets one by itself.',
        ),
      }),
    )
    .min(2, 'At least two lines are required for double-entry'),
  source_type: z
    .enum(API_VOUCHER_SOURCE_TYPES, {
      error: (issue) =>
        issue.input === 'import'
          ? API_IMPORT_SOURCE_TYPE_MESSAGE
          : 'source_type kan inte vara en motorägd källtyp här: ingående balans, bokslut, storno, rättelser, ' +
            'kreditnotor, periodiseringar, avräkningar och systemverifikat sätts av sina egna flöden och undantas ' +
            `från dimensionsreglerna. Tillåtna värden: ${API_VOUCHER_SOURCE_TYPES.join(', ')}.`,
    })
    .default('manual'),
})

/** POST /api/bookkeeping/journal-entries: what the dashboard's own forms send. */
/**
 * The warning codes a person confirmed after a VOUCHER_NEEDS_CONFIRMATION
 * answer (lib/bookkeeping/voucher-warnings-guard.ts). The checks run again on
 * every send, so this names what was seen, never a blanket override.
 */
export const AcknowledgedWarningsSchema = z.array(z.enum(VOUCHER_WARNING_CODES)).max(VOUCHER_WARNING_CODES.length).optional()

export const CreateDashboardJournalEntrySchema = CreateJournalEntrySchema.extend({
  source_type: z
    .enum(DASHBOARD_VOUCHER_SOURCE_TYPES, {
      error:
        'source_type kan bara vara "manual" eller "vat_settlement" här. Övriga källtyper sätts av sina egna flöden.',
    })
    .default('manual'),
  acknowledged_warnings: AcknowledgedWarningsSchema,
  // The VAT period a reviewed momsredovisning settles (the Moms page's "Bokför
  // momsrapport" dialog sends it): the route then refuses a period that is
  // already booked and keys the verifikat on it, like the v1 and MCP booking
  // (lib/reports/vat-settlement-booking.ts, accounted#58). Lazy because the
  // period shape is declared further down this module.
  vat_settlement_period: z.lazy(() => VatSettlementPeriodSchema).optional(),
})

/** Body of the dashboard's draft commit: only the confirmed warnings. */
export const CommitJournalEntryDraftSchema = z.object({
  acknowledged_warnings: AcknowledgedWarningsSchema,
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
  // The original was booked with debit and credit swapped and these lines
  // book it the right way round. Without it, lines that negate the original
  // answer MEANINGLESS_CORRECTION (reason negates_original): the storno
  // already reverses the original, so the same reversal again is a second
  // reversal, not a rättelse (crm#1397).
  sides_swapped: z.boolean().optional(),
})

/**
 * POST /api/bookkeeping/journal-entries/[id]/correct (the ändringsverifikation
 * dialog): the v1 body plus the corrected entry's date. The storno stays on
 * the original's date; the rättelse is dated `entry_date` in the period that
 * covers it (crm#1368: a verifikat booked on the wrong day).
 */
export const CorrectJournalEntryAppSchema = CorrectJournalEntrySchema.extend({
  entry_date: isoDate.optional(),
  // Booking-time warnings on the corrected lines (AcknowledgedWarningsSchema).
  acknowledged_warnings: AcknowledgedWarningsSchema,
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
}).refine(isSingleSidedLine, SINGLE_SIDED_LINE_ISSUE)

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
// The registry tables (dimensions/dimension_values) shipped in
// 20260702084500_dimensions_substrate.

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
 * POST /api/dimensions - create a custom dimension (dimensions PR10).
 * sie_dim_no omitted → server picks the next free number >= 20 (SIE leaves
 * 20+ unreserved). parent_sie_dim_no declares an #UNDERDIM hierarchy.
 */
export const CreateDimensionSchema = z.object({
  name: z.string().trim().min(1).max(60),
  sie_dim_no: z.coerce.number().int().min(1).max(9999).optional(),
  resets_annually: z.boolean().optional(),
  parent_sie_dim_no: z.coerce.number().int().min(1).max(9999).nullable().optional(),
})

const AccountDimensionRuleTypeSchema = z
  .enum(DIMENSION_RULE_TYPES)
  .describe('required: no posting on the account without a value; default: pre-filled when a line has none; fixed: always applied.')

/** GET /api/dimensions/rules query - optional exact-account filter. */
export const ListDimensionRulesQuerySchema = z.object({
  account_number: accountNumber.optional().describe('Only the rules of this account.'),
})

/**
 * POST /api/dimensions/rules - per-account dimension policy (dimensions
 * PR10). 'required' carries no value; 'default'/'fixed' must carry the value
 * to apply (ruleValueProblem, lib/dimensions/rule-value.ts). One rule per
 * (account, dimension): enforced by the DB UNIQUE. Also the input of the
 * v1 and MCP doors (operation dimension-rules.create).
 */
export const CreateAccountDimensionRuleSchema = z
  .object({
    account_number: accountNumber,
    dimension_id: uuid.describe('The dimension row id (dimension_id from the dimension list), not its sie_dim_no.'),
    rule_type: AccountDimensionRuleTypeSchema,
    value_id: uuid.optional().describe('default/fixed: the dimension value to apply (dimension_value_id). Omit for required.'),
    is_active: z.boolean().optional().describe('false saves the rule paused. Default true.'),
  })
  .superRefine((rule, ctx) => {
    const problem = ruleValueProblem(rule.rule_type, Boolean(rule.value_id))
    if (problem) ctx.addIssue({ code: 'custom', path: ['value_id'], message: problem })
  })

/**
 * PATCH /api/dimensions/rules/[id]: a partial update, so the value rule is
 * checked in lib/dimensions/rules-service.ts against the rule's effective
 * type (the stored one when rule_type is not sent).
 */
export const UpdateAccountDimensionRuleSchema = z.object({
  rule_type: AccountDimensionRuleTypeSchema.optional(),
  value_id: uuid.nullable().optional().describe('The value to apply; null clears it (required rules carry none).'),
  is_active: z.boolean().optional().describe('false pauses the rule without losing it.'),
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
    // Basis box of a reverse-charge purchase booked by category or account:
    // eu_goods ruta 20, eu_services ruta 21, non_eu_services ruta 22. Only
    // with vat_treatment 'reverse_charge'. Omitted, the v1 door reads the box
    // off the row's underlag (or refuses, #94); the dashboard books an EU
    // service, the box its review shows. Beside a template, a v1 door refuses
    // a box the template does not book (templateBoxRefusal).
    reverse_charge_kind: z.enum(['eu_goods', 'eu_services', 'non_eu_services']).optional(),
    // The underlag's actual moms, in the transaction's currency. Replaces the
    // rate-based VAT line of a category or template booking (see
    // buildMappingResultFromCategory / applyVatAmountOverride).
    vat_amount: z.number().positive().optional(),
    account_override: accountNumber.optional(),
    counterparty_template_id: z.string().uuid().optional(),
    // Dimensions bag {sie_dim_no: code} applied to the business lines of the
    // generated verifikat (bank/VAT legs stay untagged). Wins over a learned
    // counterparty-template bag when both are present.
    dimensions: DimensionsBagSchema.optional(),
    user_description: z.string().max(500).optional(),
    inbox_item_id: z.string().uuid().optional(),
    // The stable id of the suggestion the booking started from
    // (BookingProposal.template_id), recorded in suggestion_log. Omitted when
    // the person picked the account themselves.
    proposal_id: z.string().min(1).max(200).optional(),
    confirm_no_match: z.boolean().optional(),
    // The caller's word that the VAT the row's underlag shows is foreign VAT
    // the seller charged in error: a reverse charge is then booked on the
    // whole amount paid instead of refused (crm#1765,
    // TX_CATEGORIZE_REVERSE_CHARGE_SELLER_VAT). A Swedish seller's VAT is
    // refused all the same; a Swedish VAT number beside an address abroad
    // is no Swedish seller, and the flag then says it is not established here.
    confirm_foreign_seller_vat: z.boolean().optional(),
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
  .refine((v) => !v.reverse_charge_kind || v.vat_treatment === 'reverse_charge', {
    message: "reverse_charge_kind is only valid with vat_treatment 'reverse_charge'",
    path: ['reverse_charge_kind'],
  })

/**
 * POST /api/transactions/{id}/categorize, the dashboard's door: the v1 body
 * plus whether the person saw the booking's review. false is the row's one
 * click, booked only when the direct-booking policy lets proposal_id through
 * without a review; true is Granska bokföring. Kept off the v1 body: the API
 * and agent doors stage or book on their own terms.
 */
export const DashboardCategorizeSchema = CategorizeTransactionSchema.safeExtend({
  review_shown: z.boolean().optional(),
  /**
   * The transactions page's Bokför valda: one category for a selection, no
   * booking's review seen. A booking a booking review rule matches is then
   * refused, never stamped as reviewed (accounted#130 step 2).
   */
  in_bulk: z.boolean().optional(),
  /**
   * The person's answer to TX_CATEGORIZE_VAT_PERIOD_FILED: the row is dated
   * in a momsperiod whose declaration is filed and its booking changes the
   * underlag for it (lib/transactions/filed-vat-categorize.ts). The check
   * runs again on the confirmed send, and the booking is recorded as made
   * past it.
   */
  confirm_filed_vat_period: z.boolean().optional(),
})

/**
 * POST /api/bookkeeping/proposal-preview: the lines a proposal books. A bank
 * row's proposal is the categorize body its booking sends; a template applied
 * to a typed total names the catalog template, or one cost/liability pair
 * booked as money out (an utlägg's omvänd skattskyldighet).
 */
export const ProposalPreviewSchema = z.union([
  z.object({ transaction_id: uuid, booking: CategorizeTransactionSchema }).strict(),
  z.object({ amount: z.number().positive().max(1_000_000_000), template_id: z.string().min(1).max(100) }).strict(),
  z
    .object({
      amount: z.number().positive().max(1_000_000_000),
      pair: z
        .object({
          debit_account: accountNumber,
          credit_account: accountNumber,
          vat_treatment: VatTreatmentSchema.nullable(),
          reverse_charge_supplier_type: z.enum(['eu_business', 'non_eu_business', 'swedish_business']).optional(),
        })
        .strict(),
    })
    .strict(),
])

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
    // Booking-time warnings on the typed lines (AcknowledgedWarningsSchema).
    acknowledged_warnings: AcknowledgedWarningsSchema,
  })
  .refine((v) => !v.force || !!v.expected_duplicate_transaction_id || !!v.expected_duplicate_journal_entry_id, {
    message: 'expected_duplicate_transaction_id or expected_duplicate_journal_entry_id is required when force=true',
    path: ['expected_duplicate_journal_entry_id'],
  })

// ── Webshop orders (Orders page) ──────────────────────────────

export const WebshopPlatformSchema = z.enum(['woocommerce', 'shopify', 'zettle', 'kustom'])

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

/** A calendar quarter of the OSS underlag; the OSS scheme started 1 July 2021. */
export const OssUnderlagQuerySchema = z.object({
  year: z.coerce.number().int().min(2021).max(2100).describe('Calendar year; the OSS scheme started 1 July 2021.'),
  quarter: z.coerce.number().int().min(1).max(4).describe('Calendar quarter, 1-4.'),
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

/**
 * The new customer as the user confirmed it in the dialog, e.g. prefilled
 * from the billing contact fetched on demand from Shopify (whose order rows
 * carry no names). A person, a company, or both: the company becomes the
 * customer name and the person its contact.
 */
const WebshopOrderNewCustomerSchema = z
  .object({
    name: emptyStringAsNull(z.string().trim().max(200)),
    company: emptyStringAsNull(z.string().trim().max(200)),
    email: emptyStringAsNull(z.string().trim().email('Ange en giltig e-postadress').max(254)),
  })
  .strict()
  .refine((customer) => Boolean(customer.name || customer.company), {
    message: 'Ange kundens namn eller företag',
    path: ['name'],
  })

export const CreateInvoiceFromWebshopOrderSchema = z.object({
  /** Omitted: match by email/orgnr within the company, else create. */
  customer_id: uuid.optional(),
  /**
   * Used only when the route creates the customer: ignored when customer_id
   * is given, and an existing customer with the same email wins over it.
   */
  customer: WebshopOrderNewCustomerSchema.optional(),
})

/**
 * Mark a webshop order as booked/handled outside the integration, with an
 * optional reference to the existing (posted) verifikat that covers it.
 */
export const MarkWebshopOrderBookedSchema = z.object({
  journal_entry_id: uuid.optional(),
})

/** {"<payment_method>": {mode:'book', account:'1930'} | {mode:'invoice'}} */
/**
 * One country rule (WebshopCountryAccountRule): an ISO 3166-1 alpha-2 code
 * or the EU / NON_EU catch-all, a VAT rate in percent (null: every rate with
 * VAT), and where the bucket books. The settings route checks the accounts
 * against the chart (lib/webshop-orders/country-rule-checks.ts).
 */
const webshopCountryRuleCountry = z.string().regex(/^([A-Z]{2}|EU|NON_EU)$/)
const webshopCountryRuleRate = z.number().min(0).max(100).nullable()
const WebshopCountryAccountRuleSchema = z.discriminatedUnion('mode', [
  z.object({
    country: webshopCountryRuleCountry,
    vat_rate: webshopCountryRuleRate,
    mode: z.literal('accounts'),
    revenue_account: accountNumber,
    vat_account: accountNumber.nullable(),
  }),
  z.object({
    country: webshopCountryRuleCountry,
    vat_rate: webshopCountryRuleRate,
    mode: z.literal('swedish'),
    revenue_account: accountNumber.nullish(),
  }),
])

/**
 * Either part of the per-store settings, or both: a PUT replaces only the
 * parts it carries, so the payment-method form and the country form never
 * overwrite each other.
 */
export const WebshopStoreSettingsUpdateSchema = z
  .object({
    platform: WebshopPlatformSchema,
    store_scope: z.string().min(1).max(255),
    payment_method_account_map: z
      .record(
        z.string().min(1).max(64),
        z.discriminatedUnion('mode', [
          z.object({ mode: z.literal('book'), account: accountNumber }),
          z.object({ mode: z.literal('invoice') }),
        ]),
      )
      .optional(),
    country_account_rules: z.array(WebshopCountryAccountRuleSchema).max(100).optional(),
  })
  .refine(
    (value) =>
      value.payment_method_account_map !== undefined || value.country_account_rules !== undefined,
    { message: 'Nothing to update: send payment_method_account_map, country_account_rules or both' },
  )

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
 * addressed by the target's ledger account: a BAS 19xx bank account, or a
 * company card's liability account for a row already on a card (the service
 * refuses a move between a bank and a card). Deliberately no null variant:
 * unassigning a row would just re-strand it under the primary account's
 * report (the exact symptom the move action exists to fix).
 */
export const MoveTransactionCashAccountSchema = z.object({
  account_number: z
    .string()
    .regex(CASH_OR_CARD_LEDGER_PATTERN, 'Expected a BAS 19xx bank account or a company card account number'),
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
  // Booking-time warnings on the typed lines (AcknowledgedWarningsSchema).
  acknowledged_warnings: AcknowledgedWarningsSchema,
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

/**
 * POST /items/bulk-book, Inkorgen's "Bokför valda": the shared body plus the
 * person's answer about the underlag held back because their booking changes
 * the underlag for a momsdeklaration already filed (skipped with reason
 * filed_vat_period, lib/transactions/filed-vat-categorize.ts). Sent again
 * with it, those are booked and recorded as booked past the warning. Kept
 * off the staged params: an approval has nobody to ask.
 */
export const DashboardBulkBookInboxSchema = BulkBookInboxSchema.extend({
  confirm_filed_vat_period: z.boolean().optional(),
})

const matchInvoiceFields = z
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
      // User-edited payment lines keep their tags, as on mark-paid (without
      // this key Zod stripped a caller's bag before the route saw it).
      dimensions: DimensionsBagSchema.optional(),
    }).refine(isSingleSidedLine, SINGLE_SIDED_LINE_ISSUE)).min(2).optional(),
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

function forceNamesCandidate(v: { force?: boolean; expected_journal_entry_id?: string }): boolean {
  return !v.force || !!v.expected_journal_entry_id
}

const FORCE_NAMES_CANDIDATE_ISSUE = {
  message: 'expected_journal_entry_id is required when force=true',
  path: ['expected_journal_entry_id'],
}

export const MatchInvoiceSchema = matchInvoiceFields.refine(forceNamesCandidate, FORCE_NAMES_CANDIDATE_ISSUE)

/**
 * The dashboard match dialog's body: MatchInvoiceSchema plus where a
 * customer's excess of a krona or more is booked (lib/bookkeeping/
 * overpayment.ts) and the excess the dialog showed, which the route books or
 * refuses with MATCH_OVERPAYMENT_CHANGED, as the agent match does at approval
 * (crm#1045). The mirror for a payout short of the invoice by the payment
 * provider's fee: fee_account and the fee the dialog showed
 * (lib/bookkeeping/payment-fee.ts, MATCH_PAYMENT_FEE_CHANGED, crm#1364).
 * Not on the v1 body: that route books neither.
 */
export const DashboardMatchInvoiceSchema = matchInvoiceFields
  .extend({
    overpayment_account: z.enum([CUSTOMER_ADVANCE_ACCOUNT, ORE_ROUNDING_ACCOUNT]).optional(),
    overpayment_amount: z.number().positive().optional(),
    fee_account: z.enum([PAYMENT_FEE_ACCOUNT]).optional(),
    fee_amount: z.number().positive().optional(),
  })
  .refine(forceNamesCandidate, FORCE_NAMES_CANDIDATE_ISSUE)
  .refine((v) => (v.overpayment_account === undefined) === (v.overpayment_amount === undefined), {
    message: 'overpayment_account and overpayment_amount are sent together',
    path: ['overpayment_amount'],
  })
  .refine((v) => (v.fee_account === undefined) === (v.fee_amount === undefined), {
    message: 'fee_account and fee_amount are sent together',
    path: ['fee_amount'],
  })

/**
 * Query of the "Koppla till verifikat" candidate lists (customer and supplier
 * invoices). `voucher` is the text a person typed to name a verifikat by its
 * number ("A17", "A-17"): the list then holds that verifikat at any date
 * (lib/invoices/voucher-label.ts). Text that names no number gives an empty list.
 */
export const VoucherCandidatesQuerySchema = z.object({
  voucher: z.string().trim().max(40).optional(),
})

/**
 * Link an existing posted verifikat as payment for an invoice. No new
 * journal entry is created: only an invoice_payments row pointing at the
 * supplied journal_entry_id, plus the invoice's paid/remaining are advanced.
 *
 * `amount` is the share of the verifikat that is this invoice's, in the
 * invoice's currency, for a verifikat that settles several invoices. Omitted,
 * what the verifikat has left must fit inside the invoice's remainder.
 */
export const LinkInvoiceToVoucherSchema = z.object({
  journal_entry_id: uuid,
  notes: z.string().max(2000).optional(),
  amount: z.number().finite().positive().optional(),
})

/**
 * Supplier-invoice mirror: link an existing posted verifikat as payment for a
 * supplier invoice. No new JE: only a supplier_invoice_payments row pointing
 * at the supplied journal_entry_id, plus the invoice's paid/remaining advance.
 *
 * `amount` is the share of the verifikat that is this invoice's, in the
 * invoice's currency, for a verifikat that pays several debts. Omitted, what
 * the verifikat has left must fit inside the invoice's remainder.
 */
export const LinkSupplierInvoiceToVoucherSchema = z.object({
  journal_entry_id: uuid,
  notes: z.string().max(2000).optional(),
  amount: z.number().finite().positive().optional(),
})

/**
 * Undo a link made with LinkSupplierInvoiceToVoucherSchema: `payment_id` is
 * the supplier_invoice_payments row the link wrote. The row is removed and
 * the invoice gets its amount back; the verifikat is not touched.
 */
export const UnlinkSupplierInvoiceFromVoucherSchema = z.object({
  payment_id: uuid,
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
          // Bound at 99,999,999 SEK per line.
          // Real-world max is in the millions; an 8-digit ceiling catches
          // typos (1000000 mistyped as 10000000000) before they hit the
          // RPC, without blocking legitimate large bookings.
          debit_amount: nonNegativeAmount.max(99_999_999, 'Line amount exceeds maximum'),
          credit_amount: nonNegativeAmount.max(99_999_999, 'Line amount exceeds maximum'),
          currency: z.string().min(3).max(3).default('SEK'),
          line_description: z.string().max(200).optional(),
          // Dimensions PR7: per-line bag, wins over default_dimensions.
          dimensions: DimensionsBagSchema.optional(),
        }).refine(isSingleSidedLine, SINGLE_SIDED_LINE_ISSUE)
      )
      .min(2, 'A verifikat needs at least two lines')
      .max(200)
      .optional(),
    // Dimensions PR7: header-level bag for the business lines in BOTH the
    // template and manual paths; the bank side and the moms lines stay
    // untagged (crm#1313), and per-line bags win per key.
    // lib/transactions/bulk-book.ts merges before calling the RPC.
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
    if (hasExisting && data.default_dimensions) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'default_dimensions only applies when a new verifikat is created: a posted verifikat is immutable, so a link cannot tag it',
        path: ['default_dimensions'],
      })
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
 * POST /api/transactions/bulk-book, the dashboard's door: the shared body
 * plus the person's answer to BULK_BOOK_VAT_PERIOD_FILED, a new
 * samlingsverifikat dated in a momsperiod whose declaration is filed, with
 * lines that change the underlag for it
 * (lib/transactions/filed-vat-bulk-book.ts). The check runs again on the
 * confirmed send, and the booking is recorded as made past it. Kept off the
 * v1 and MCP body: a staged samlingsverifikat carries the note on its
 * proposal instead.
 */
export const DashboardBulkBookSchema = BulkBookSchema.safeExtend({
  confirm_filed_vat_period: z.boolean().optional(),
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
        ], {
          // Every guard branches on kind: say which id goes with which.
          error:
            'kind is required: "customer_invoice" (incoming payment, pass invoice_id) or "supplier_invoice" (outgoing payment, pass supplier_invoice_id)',
        }),
      )
      .min(1, 'At least one allocation is required')
      // Capped to bound the FOR UPDATE locks the RPC takes (PR #603 compliance
      // review, OWASP V4.2). The ceiling is the shared bank row split: a
      // Skatteverket ROT/RUT payout pays one invoice per buyer, 100+ on one row.
      .max(MAX_BANK_ROW_SPLIT, `At most ${MAX_BANK_ROW_SPLIT} allocations per batch`),
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
    // A payment service's fee on the row (lib/bookkeeping/payout-fee-lines.ts):
    // a debit on a class 6 cost account, no VAT. The fee and debt rows are
    // bare in the MCP tool's listed schema (refinements, not regex or bounds,
    // which pays for supplier_debts in the frozen tools/list budget); the
    // refusals say the rule. At most five rows of the two together, below.
    fees: z
      .array(
        z.object({
          account: z.string().refine(isPayoutFeeAccount, 'Fee account must be a BAS class 6 cost account, e.g. 6570'),
          amount: z.number().refine((amount) => amount > 0, 'Fee amount must be greater than 0'),
          description: z
            .string()
            .refine((text) => text.length <= PAYOUT_FEE_DESCRIPTION_MAX, `At most ${PAYOUT_FEE_DESCRIPTION_MAX} characters`)
            .optional(),
        }),
      )
      .optional(),
    // A supplier invoice the row also pays that was registered before the
    // company kept its books here, so it is only in the 2440 balance
    // (lib/bookkeeping/supplier-debt-lines.ts): a debit on a 244x account, no
    // VAT. Supplier batches only; not a fee, so it may exceed the invoices.
    supplier_debts: z
      .array(
        z.object({
          account: z.string().refine(isSupplierDebtAccount, 'Debt account must be a supplier debt account 2440 to 2449, e.g. 2440'),
          amount: z.number().refine((amount) => amount > 0, 'Debt amount must be greater than 0'),
          description: z
            .string()
            .refine((text) => text.length <= SUPPLIER_DEBT_DESCRIPTION_MAX, `At most ${SUPPLIER_DEBT_DESCRIPTION_MAX} characters`)
            .optional(),
        }),
      )
      .optional(),
    // The customer side of supplier_debts: a customer invoice the row also
    // pays that was issued before the company kept its books here, so it is
    // only in the 1510 balance (lib/bookkeeping/customer-receivable-lines.ts):
    // a credit on a 151x account, no VAT. Customer batches only; not a fee,
    // so it may exceed the invoices.
    customer_receivables: z
      .array(
        z.object({
          account: z
            .string()
            .refine(isCustomerReceivableAccount, 'Receivable account must be a customer receivable account 1510 to 1519, e.g. 1510'),
          amount: z.number().refine((amount) => amount > 0, 'Receivable amount must be greater than 0'),
          description: z
            .string()
            .refine(
              (text) => text.length <= CUSTOMER_RECEIVABLE_DESCRIPTION_MAX,
              `At most ${CUSTOMER_RECEIVABLE_DESCRIPTION_MAX} characters`,
            )
            .optional(),
        }),
      )
      .optional(),
  })
  .superRefine((data, ctx) => {
    if (data.force && !(data.expected_journal_entry_ids?.length)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expected_journal_entry_ids'],
        message: 'expected_journal_entry_ids is required when force=true',
      })
    }
    if (data.fees?.length) {
      const allocated = data.allocations.reduce((sum, a) => sum + a.amount, 0)
      if (!payoutFeesWithinInvoices(allocated, payoutFeeTotal(data.fees))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['fees'],
          message: 'The fees must be smaller than the invoices they settle',
        })
      }
    }
    if (data.supplier_debts?.length && data.allocations.some((a) => a.kind !== 'supplier_invoice')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['supplier_debts'],
        message: 'supplier_debts go with supplier_invoice allocations only (an outgoing payment)',
      })
    }
    if (data.customer_receivables?.length && data.allocations.some((a) => a.kind !== 'customer_invoice')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['customer_receivables'],
        message: 'customer_receivables go with customer_invoice allocations only (an incoming payment)',
      })
    }
    // At most five extra rows on the verifikat, fees and the rows from before together, as the RPC.
    const debtRows = data.supplier_debts?.length ?? 0
    const receivableRows = data.customer_receivables?.length ?? 0
    if ((data.fees?.length ?? 0) + debtRows + receivableRows > MAX_PAYOUT_FEES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [debtRows > 0 ? 'supplier_debts' : receivableRows > 0 ? 'customer_receivables' : 'fees'],
        message: `At most ${MAX_PAYOUT_FEES} fee, debt and receivable rows together`,
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

/**
 * POST /api/transactions/[id]/match-rot-rut-payout: settle one or several
 * ROT/RUT begäran with the bank row that carried Skatteverkets utbetalning.
 * Amount, date and bank account all come from the transaction, so the body
 * is just the target(s): `request_id` for one begäran, `request_ids` when
 * Skatteverket paid several beslut in one transfer (#2239). Exactly one of
 * the two.
 */
export const MatchRotRutPayoutSchema = z
  .object({
    request_id: uuid.optional(),
    request_ids: z.array(uuid).min(1).max(10).optional(),
  })
  .refine((body) => (body.request_id ? 1 : 0) + (body.request_ids ? 1 : 0) === 1, {
    message: 'Ange antingen request_id eller request_ids',
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
    // User-edited payment lines keep their tags, as on mark-paid.
    dimensions: DimensionsBagSchema.optional(),
  })).min(2).optional(),
  // A bank row already booked is refused with MATCH_SI_TX_ALREADY_BOOKED
  // (accounted#58). true reverses the row's own categorization verifikat
  // (storno) and books the payment in its place; only that booking, never a
  // samlingsverifikat, a split or a reconciliation link (details.storno_allowed).
  storno_existing: z.boolean().optional(),
  // Bypass the soft-duplicate guard (MATCH_SI_POSSIBLE_DUPLICATE) after the
  // person reviewed the verifikat it named, bound to it by
  // expected_journal_entry_id as on the customer match (accounted#58).
  force: z.boolean().optional(),
  expected_journal_entry_id: uuid.optional(),
}).refine(forceNamesCandidate, FORCE_NAMES_CANDIDATE_ISSUE)

// The Inkorg's "Registrera och koppla till betalningen": the inbox convert
// body (as POST /items/:id/convert takes it) and the bank row the item looks
// already paid by. The company paid it from that row, so a person paying it
// privately is a different answer (the utlägg), never this one.
export const RegisterAndSettleInboxItemSchema = z.object({
  transaction_id: uuid,
  invoice: CreateSupplierInvoiceSchema,
}).refine((body) => body.invoice.paid_with_private_funds !== true, {
  message: 'A privately paid invoice is an utlägg, not a payment from the bank row',
  path: ['invoice', 'paid_with_private_funds'],
})

// The Inkorg's one click: what a person answered on the page, as request
// parameters (never stored): what was bought, and where the seller is when
// the document names no country (lib/operations/inkorg-one-click.ts).
const OneClickAnswerFields = {
  purchase_category: z.enum(PURCHASE_CATEGORY_CODES).optional(),
  seller_country: z.enum(['se', 'eu', 'non_eu']).optional(),
}

/** GET /api/inkorg/items/:id/booking-plan */
export const InboxItemBookingPlanQuerySchema = z.object(OneClickAnswerFields)

/**
 * POST /api/inkorg/items/:id/book: the plan's preview token, the answers it
 * was planned with, and the bank row the page showed. After a
 * VOUCHER_NEEDS_CONFIRMATION answer the person read, the same request again
 * with the codes it showed (AcknowledgedWarningsSchema).
 */
export const BookInboxItemOneClickSchema = z.object({
  preview_token: z.string().regex(/^pv1\.[A-Za-z0-9_-]{43}$/, 'Not a preview token: send back the preview_token the booking plan answered.'),
  ...OneClickAnswerFields,
  transaction_id: uuid.optional(),
  acknowledged_warnings: AcknowledgedWarningsSchema,
})

/** POST /api/inkorg/items/:id/companion: the receipt that came with the invoice :id as one purchase. */
export const FollowInboxCompanionSchema = z.object({
  receipt_item_id: uuid,
})

/** POST /api/inkorg/items/remove: the inbox items to take out of the Inkorg in one go. */
export const RemoveInboxItemsSchema = z.object({
  inbox_item_ids: z.array(uuid).min(1).max(MAX_INBOX_ITEMS_PER_REMOVAL),
})

/** POST /api/inkorg/items/restore: the deleted inbox item to put back, by its own id. */
export const RestoreInboxItemSchema = z.object({
  inbox_item_id: uuid,
})

/**
 * The link to a company portal as pasted: the server applies the URL rule
 * (normalizePortalUrl in lib/receipt-hunt/company-portals.ts) and refuses
 * with INKORG_PORTAL_URL_INVALID, so the person reads why in Swedish.
 */
const portalUrlInput = z.string().trim().min(1).max(4096)

/**
 * POST /api/inkorg/portals: the purchase whose supplier keeps its invoices
 * in a portal, and the link. The supplier is read off the purchase on the
 * server, never sent.
 */
export const CreateCompanyPortalSchema = z.object({
  transaction_id: uuid,
  url: portalUrlInput,
})

/** PATCH /api/inkorg/portals/:id: a new link for the portal; which supplier it is stays. */
export const UpdateCompanyPortalSchema = z.object({
  url: portalUrlInput,
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
export const UpdateCashAccountFieldsSchema = InvoicePaymentAccountSchema.extend({
  voucher_series: UpdateCashAccountVoucherSeriesSchema.shape.voucher_series.optional(),
  name: z.string().trim().min(1).max(100).nullable().optional(),
  invoice_payee: z.boolean().optional(),
  // Accounts no bank connection holds only: a connection-held account's
  // enabled state is owned by the AccountPickerDialog (enabled_uids), and
  // setEnabled() refuses it (409), so the shape alone cannot say which.
  enabled: z.boolean().optional(),
}).strict()

/**
 * The same fields with the "something to update" rule. Split from
 * UpdateCashAccountFieldsSchema because a refined object cannot be
 * extended: the v1 operation adds cash_account_id to the unrefined fields.
 */
export const UpdateCashAccountSchema = UpdateCashAccountFieldsSchema.refine((body) => Object.keys(body).length > 0, {
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

const CARD_LEDGER_MESSAGE = `Ett företagskort bokförs på ${CARD_LEDGER_RANGE_TEXT}`

/** The card's liability account: the allowlist of the cash_accounts_card_shape CHECK. */
const CardLedgerAccountSchema = z.string().regex(CARD_LEDGER_PATTERN, CARD_LEDGER_MESSAGE)

/** The last four digits of each card billed on the statement, deduplicated. */
const CardLast4Schema = z
  .array(z.string().trim().length(4, 'Ange kortets fyra sista siffror').regex(/^\d+$/, 'Ange kortets fyra sista siffror'))
  .min(1)
  .max(20)
  .transform((values) => [...new Set(values)])

/**
 * POST /api/cash-accounts with kind 'card': a company card (företagskort).
 * Its statement rows book against a liability account (lib/cash-accounts/
 * card-ledger.ts); it is never a payee, the primary or bank-connected, so it
 * takes no payee fields. ledger_account omitted gets the suggested one.
 */
export const CreateCardAccountSchema = z.object({
  kind: z.literal('card'),
  name: z.string().trim().min(1, 'Ange ett namn').max(100),
  currency: CurrencySchema,
  card_issuer: z.enum(CARD_ISSUERS),
  ledger_account: CardLedgerAccountSchema.optional(),
  card_last4: CardLast4Schema.optional(),
  voucher_series: z.string().regex(/^[A-Z]$/, 'Verifikationsserie måste vara en bokstav A-Z').nullable().optional(),
}).strict()

/**
 * The one request shape of every create door (dashboard route, v1, MCP): a
 * bank account (kind omitted or 'bank', CreateCashAccountSchema's rules) or
 * a company card (kind 'card', CreateCardAccountSchema's rules). Flat, so the
 * MCP tool keeps a plain object schema; the kind-specific rules run in the
 * refinement and splitCreateCashAccountRequest() hands each service its own
 * input.
 */
export const CreateCashAccountRequestSchema = CreateCashAccountSchema.extend({
  kind: z.enum(['bank', 'card']).optional(),
  ledger_account: accountNumberSchema.optional(),
  card_issuer: z.enum(CARD_ISSUERS).optional(),
  card_last4: CardLast4Schema.optional(),
  voucher_series: z.string().regex(/^[A-Z]$/, 'Verifikationsserie måste vara en bokstav A-Z').nullable().optional(),
}).superRefine((value, ctx) => {
  const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message })
  if (value.kind === 'card') {
    if (value.ledger_account !== undefined && !CARD_LEDGER_PATTERN.test(value.ledger_account)) {
      issue('ledger_account', CARD_LEDGER_MESSAGE)
    }
    if (value.card_issuer === undefined) issue('card_issuer', 'Välj kortutgivare')
    if (value.payee !== undefined) issue('payee', 'Ett företagskort har inga betaluppgifter')
    if (value.invoice_payee === true) issue('invoice_payee', 'Ett företagskort visas aldrig som betalningsmottagare')
    return
  }
  if (value.ledger_account !== undefined && !/^19[2-9]\d$/.test(value.ledger_account)) {
    issue('ledger_account', 'Bankkonton bokförs på 1920-1999')
  }
  if (value.card_issuer !== undefined) issue('card_issuer', 'Bara ett företagskort har kortutgivare')
  if (value.card_last4 !== undefined) issue('card_last4', 'Bara ett företagskort har kortsiffror')
  if (value.voucher_series !== undefined) issue('voucher_series', 'Sätt verifikationsserien på kontot efteråt')
})

export type CreateCashAccountRequest = z.infer<typeof CreateCashAccountRequestSchema>

/** A validated create request, split into the input of the service it names. */
export function splitCreateCashAccountRequest(
  request: CreateCashAccountRequest,
):
  | { kind: 'bank'; input: z.infer<typeof CreateCashAccountSchema> }
  | { kind: 'card'; input: z.infer<typeof CreateCardAccountSchema> } {
  if (request.kind === 'card') {
    return {
      kind: 'card',
      input: {
        kind: 'card',
        name: request.name,
        currency: request.currency,
        // The refinement refused a card without an issuer.
        card_issuer: request.card_issuer ?? 'other',
        ...(request.ledger_account !== undefined ? { ledger_account: request.ledger_account } : {}),
        ...(request.card_last4 !== undefined ? { card_last4: request.card_last4 } : {}),
        ...(request.voucher_series !== undefined ? { voucher_series: request.voucher_series } : {}),
      },
    }
  }
  return {
    kind: 'bank',
    input: {
      name: request.name,
      currency: request.currency,
      ...(request.ledger_account !== undefined ? { ledger_account: request.ledger_account } : {}),
      ...(request.invoice_payee !== undefined ? { invoice_payee: request.invoice_payee } : {}),
      ...(request.payee !== undefined ? { payee: request.payee } : {}),
    },
  }
}

/**
 * DELETE /api/cash-accounts/[id]: dry_run=true answers the same checks and
 * what would go, without writing (the confirmation dialog's preview).
 */
export const RemoveCashAccountQuerySchema = z.object({
  dry_run: z.enum(['true', 'false']).optional(),
}).strict()

/**
 * GET /api/cash-accounts/ledger-suggestions: every suggestion of the company,
 * or those that involve one bank connection's accounts (the bank picker).
 */
export const LedgerSuggestionsQuerySchema = z.object({
  connection_id: uuid.optional(),
}).strict()

/**
 * PATCH /api/bank/connections/[id]/ledgers: which bank ledger account each
 * named synced bank account of the connection books on from now on, for any
 * aggregator (lib/cash-accounts/ledger-change.ts). Accounts not named keep
 * theirs; ?dry_run=true answers the moves without writing.
 */
export const ChangeBankLedgersSchema = z.object({
  accounts: z
    .array(z.object({
      uid: z.string().min(1).max(200),
      // An account number; that it is a bank account (19xx) is the service's rule.
      ledger_account: accountNumber,
    }).strict())
    .min(1)
    .max(50),
}).strict()

export const ChangeBankLedgersQuerySchema = z.object({
  dry_run: z.enum(['true', 'false']).optional(),
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

/**
 * A bank-assigned file id as typed in Settings (lib/payments/swedbank.ts,
 * lib/payments/nordea.ts): spaces and hyphens dropped and upper case, then
 * the bank's documented format. An emptied field clears the id. `refused` is
 * a number the bank also assigns that belongs to another service: it is
 * refused by name (Swedish message, English in params.en for message_en)
 * before the format check, which would only say "wrong format".
 */
function bankFileIdSchema(pattern: RegExp, message: string, refused?: { pattern: RegExp; sv: string; en: string }) {
  const normalized = z.string().transform(normalizeSwedbankId)
  const checked = refused
    ? normalized.refine((id) => !refused.pattern.test(id), { message: refused.sv, params: { en: refused.en }, abort: true })
    : normalized
  return checked
    .pipe(z.union([z.literal(''), z.string().regex(pattern, message)]))
    .transform((id) => id || null)
    .nullable()
    .optional()
}

/**
 * Swedbank's ISO 20022 1.0 agreement number (06 + organisationsnummer +
 * B001/R001) typed into a 2.0 id field: what it is, that paying through the
 * bank connection needs no file agreement, and which ids a file needs.
 */
function swedbankIso1Agreement(notSv: string, notEn: string) {
  return {
    pattern: SWEDBANK_ISO1_AGREEMENT_PATTERN,
    sv:
      `Det här är Swedbanks avtalsnummer för ISO 20022 1.0 (06 + organisationsnummer + B001 eller R001), inte ${notSv}. ` +
      'Betalar du med Betala via banken behövs inget filavtal. Betalfiler härifrån följer Swedbanks ISO 2.0 och kräver ' +
      'SignerID (123456789ORI0001) och avtals-id för Corporate Pay (123456789CPO0001): be Swedbank om dem.',
    en:
      `This is Swedbank's ISO 20022 1.0 agreement number (06 + organisation number + B001 or R001), not ${notEn}. ` +
      'Paying with Pay through the bank needs no file agreement. Payment files from here follow Swedbank ISO 2.0 and need ' +
      'the SignerID (123456789ORI0001) and the Corporate Pay agreement id (123456789CPO0001): ask Swedbank for them.',
  }
}

/**
 * PUT /api/settings/skattekonto-account: the skattekonto's ledger account
 * (lib/skatteverket/skattekonto-account-service.ts). Which account the form
 * allows (2012 only for an enskild firma) is the service's rule, not the
 * schema's, so the refusal names the allowed accounts.
 */
export const SetSkattekontoAccountSchema = z.object({
  account: z.enum(['1630', '2012']),
})

/** POST /api/settings/skattekonto-account/transfer-draft: the draft's date, today when omitted. */
export const SkattekontoTransferDraftSchema = z.object({
  entry_date: saneIsoDate.optional(),
})

export const UpdateSettingsSchema = z.object({
  entity_type: EntityTypeSchema.optional(),
  company_name: z.string().optional(),
  org_number: z.string().optional(),
  address_line1: z.string().optional(),
  address_line2: z.string().optional(),
  postal_code: z.string().optional(),
  city: z.string().optional(),
  // Säte: the municipality the company is registered in, printed as säte in
  // the annual report. Not the postal town (`city`).
  registered_office: z.string().trim().max(100, 'Säte får vara max 100 tecken').nullable().optional(),
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
  // Swedbank's own ids for pain.001 files: the SignerID goes in InitgPty, the
  // Corporate Pay agreement id in Dbtr/Id (lib/payments/swedbank.ts).
  swedbank_signer_id: bankFileIdSchema(
    SWEDBANK_SIGNER_ID_PATTERN,
    'SignerID ska ha formatet 123456789ORI0001 (9 siffror, ORI, 4 siffror)',
    swedbankIso1Agreement('ett SignerID', 'a SignerID'),
  ),
  swedbank_corporate_pay_id: bankFileIdSchema(
    SWEDBANK_CORPORATE_PAY_ID_PATTERN,
    'Avtals-id ska ha formatet 123456789CPO0001 (9 siffror, CPO, 4 siffror)',
    swedbankIso1Agreement('ett avtals-id för Corporate Pay', 'a Corporate Pay agreement id'),
  ),
  // Nordea's Signer ID for pain.001 files, InitgPty with SchmeNm CUST (lib/payments/nordea.ts).
  nordea_signer_id: bankFileIdSchema(
    NORDEA_SIGNER_ID_PATTERN,
    'Signer ID får bara innehålla bokstäver och siffror, högst 35 tecken',
  ),
  // Nordea's CCM agreement id for pain.001 files, Dbtr with SchmeNm BANK (lib/payments/nordea.ts).
  nordea_agreement_id: bankFileIdSchema(
    NORDEA_AGREEMENT_ID_PATTERN,
    'Avtals-ID får bara innehålla bokstäver och siffror, högst 35 tecken',
  ),
  invoice_payment_accounts: InvoicePaymentAccountsSchema.optional(),
  accounting_method: AccountingMethodSchema.optional(),
  // Not a column: why accounting_method changes in a fiscal year that already
  // has posted verifikat (a correction, lib/company/accounting-method-change.ts).
  // Recorded in audit_log, never written to company_settings.
  accounting_method_correction_reason: z
    .string()
    .trim()
    .min(10, 'Skälet ska vara minst 10 tecken')
    .max(500, 'Skälet får vara max 500 tecken')
    .optional(),
  // #967: register/send invoices without booking; booking is a separate step.
  defer_invoice_booking: z.boolean().optional(),
  // #523: month-end currency revaluation, reversed the next day.
  fx_revaluation_monthly: z.boolean().optional(),
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
  // K3 kapitel 20: capitalise finansiella leasingavtal instead of the 20.29 relief.
  finance_lease_capitalisation: z.boolean().optional(),
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
  invoice_ocr_length_digit: z
    .boolean()
    .optional()
    .describe("true: the OCR reference on invoices carries Bankgirot's length digit before the check digit (invoice 1042 is paid as 104265, not 10421). For a bankgiro whose OCR control at the bank checks the reference's length; such a bankgiro refuses a reference without it. Default false."),
  invoice_show_bankgiro: z.boolean().optional(),
  invoice_show_plusgiro: z.boolean().optional(),
  invoice_show_swish: z.boolean().optional(),
  // Superseded by invoice_qr_mode: still accepted (and stored) so existing
  // API callers keep working, but no longer read when rendering an invoice.
  // The describe reaches the MCP settings tool and the API skill, so a caller
  // learns that setting it changes nothing.
  invoice_show_payment_qr: z
    .boolean()
    .optional()
    .describe('Superseded by invoice_qr_mode: accepted for compatibility, no longer changes the PDF.'),
  // The one payment QR code invoices print (lib/invoices/payment-qr.ts).
  invoice_qr_mode: InvoiceQrModeSchema.optional(),
  invoice_show_logo: z.boolean().optional(),
  // An article number column on the invoice PDF and the seller's item
  // identifier in the e-invoice (crm#1084). Default off.
  invoice_show_article_number: z.boolean().optional(),
  // Superseded by the fixed invoice layout (company name in Från and the
  // footer on every invoice): still accepted and stored so existing callers
  // keep working, but no settings UI writes them any more. The describe
  // reaches the MCP settings tool and the API skill.
  invoice_show_company_name: z
    .boolean()
    .optional()
    .describe(
      'Superseded by the fixed invoice layout, which always prints the company name in Från and the footer: accepted for compatibility.',
    ),
  invoice_company_name_position: z
    .enum(['header', 'footer'])
    .optional()
    .describe('Superseded by the fixed invoice layout: accepted for compatibility, no longer changes the PDF.'),
  invoice_late_fee_text: z.string().nullable().optional(),
  invoice_credit_terms_text: z.string().nullable().optional(),
  // The English texts of the two above (crm#1735). The describe reaches the
  // MCP settings tool and the API skill.
  invoice_late_fee_text_en: z
    .string()
    .nullable()
    .optional()
    .describe('English invoice_late_fee_text, printed on invoices to customers whose language is en. Null or empty prints the Swedish text.'),
  invoice_credit_terms_text_en: z
    .string()
    .nullable()
    .optional()
    .describe('English invoice_credit_terms_text, printed on invoices to customers whose language is en. Null or empty prints the Swedish text.'),
  // Opt-in for the invoice payment-link feature (editor field + automatic
  // Stripe link on send). Default off at the DB level.
  invoice_payment_links_enabled: z.boolean().optional(),
  // The ways invoices go out, in the order the editor tries them: a non-empty
  // list of distinct ways; null clears the order.
  invoice_send_order: z
    .array(z.enum(SEND_ORDER_WAYS))
    .min(1)
    .refine((ways) => new Set(ways).size === ways.length, { message: 'Each way may appear once.' })
    .nullable()
    .optional()
    .describe('The order invoices are sent in: peppol, kivra, billo, email, each at most once. The invoice editor picks the first way in the list that the invoice can use. Null clears the order.'),
  // Editable invoice email texts: { sv?: {...}, en?: {...} }; null clears
  // all overrides. Without this entry the generic PUT would silently strip
  // the field (the schema is the de-facto column whitelist).
  invoice_email_texts: InvoiceEmailTextsSchema.nullable().optional(),
  invoice_email_cc_addresses: invoiceEmailAddressList.nullable().optional(),
  invoice_email_bcc_addresses: invoiceEmailAddressList.nullable().optional(),
  // Reply-To for invoice mail; null falls back to the company email, then the
  // sending user. Owner/admin only, like the copy lists (settings route).
  invoice_email_reply_to: invoiceEmailAddress.nullable().optional(),
  // Invoice branding: colors enforced as #RRGGBB at the DB level too
  // (see migration 20260526120200_invoice_branding.sql). Set under
  // Inställningar > Fakturor (PdfPrintSettings) through this PUT, and by the
  // v1 settings operation and its MCP tool.
  invoice_primary_color: z
    .string()
    .regex(INVOICE_COLOR_PATTERN, 'Ange en giltig hex-färg (#RRGGBB)')
    .optional(),
  invoice_accent_color: z
    .string()
    .regex(INVOICE_COLOR_PATTERN, 'Ange en giltig hex-färg (#RRGGBB)')
    .optional(),
  invoice_font_family: z
    .enum(['Helvetica', 'Times-Roman', 'Courier', 'Source Sans 3', 'Source Serif 4', 'Custom'])
    .optional(),
  invoice_header_text: z.string().max(INVOICE_HEADER_TEXT_MAX_LENGTH).nullable().optional(),
  invoice_footer_text: z.string().max(INVOICE_FOOTER_TEXT_MAX_LENGTH).nullable().optional(),
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
  // load-bearing for correctness.
  dimensions_enabled: z.boolean().optional(),
  // One click on a bank row's or the Inkorg's suggestion books it without a
  // review when the direct-booking policy allows it (accounted#130). Off:
  // every suggestion opens its review. Dashboard only (owner/admin): no
  // settings operation writes it, so a key cannot turn its own review off.
  direct_booking_enabled: z.boolean().optional(),
  // An incoming payment that names one open customer invoice by its OCR or
  // invoice number books against it on arrival, without a person (crm#2226).
  // Dashboard only (owner/admin), like the switch above: no settings
  // operation writes it.
  auto_book_customer_payments: z.boolean().optional(),
  // Körjournal (mileage log): UI-visibility toggle only, never load-bearing
  // for correctness (trips created via API/MCP work regardless).
  mileage_enabled: z.boolean().optional(),
  // Kundorder (sales orders): UI-visibility toggle only, never load-bearing
  // for correctness (the pages and APIs work regardless).
  sales_orders_enabled: z.boolean().optional(),
  // Invoice document type toggles (offert, proforma, återkommande,
  // självfaktura): UI-visibility only, never load-bearing for correctness.
  quotes_enabled: z.boolean().optional(),
  proforma_enabled: z.boolean().optional(),
  recurring_invoices_enabled: z.boolean().optional(),
  self_billing_enabled: z.boolean().optional(),
  // Self-billing on the purchase side (crm#1367): the series' prefix (letters,
  // digits and hyphens, never ending in a digit, which would run into the
  // number), where it continues, and the acceptance clause the document
  // prints (empty = the built-in text). The insert trigger never lets the
  // series reuse a number, whatever next_self_billing_number says.
  self_billing_prefix: z
    .string()
    .trim()
    .max(12)
    .regex(/^[A-Za-z0-9-]*$/, 'Prefixet får bara innehålla bokstäver, siffror och bindestreck')
    .refine((prefix) => !/[0-9]$/.test(prefix), 'Prefixet får inte sluta med en siffra')
    .optional(),
  next_self_billing_number: z.number().int().min(1).max(999_999_999).optional(),
  self_billing_acceptance_text: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
    z.string().trim().max(1000).nullable().optional(),
  ),
  // Salary payment file
  preferred_payment_format: z.enum(['bg_lb', 'pain001']).optional(),
  // Salary settings (migration 20260703190000). Day of month salaries are
  // paid (1-28 so it exists in every month) and the fallback bank for the
  // payment-file panel's upload instructions (the paying account's bank
  // comes first, lib/salary/payment/instruction-bank.ts).
  salary_pay_day: z.number().int().min(1).max(28).optional(),
  salary_default_bank: z
    .enum(['swedbank', 'seb', 'handelsbanken', 'nordea', 'other'])
    .nullable()
    .optional(),
  // Öresavrundning: round each net payout up to whole kronor (banks that
  // reject öre in salary payment files). Diff books on 3740.
  salary_net_rounding: z.boolean().optional(),
  // Payslip sections on the copy the employee receives (migration
  // 20260930200000). The employer's own view always prints both.
  salary_payslip_show_employer_cost: z.boolean().optional(),
  salary_payslip_show_breakdown: z.boolean().optional(),
  // Regionalt stöd (migration 20261026110000, lib/salary/regional-support.ts):
  // employees work at a fast driftställe in a stödområde. Runs calculated
  // afterwards declare FK471/FK476 and book the avdrag.
  salary_regional_support: z.boolean().optional(),
  // Calculation conventions (migration 20260919120100): partial-month
  // proration, sick-pay rate, long-leave measure, leave context, net and
  // one-off tax rounding. The full object is stored (every key present,
  // defaults filled) and replaced as a whole by this route; the v1 salary
  // settings route merges a partial patch into the stored policy first.
  salary_calculation_policy: SalaryCalculationPolicySchema.optional(),
  // Avvikelseperiod (migration 20260918120000): which month's absence and
  // worked days a new run reads. Snapshotted onto each run at creation.
  salary_deviation_period: z.enum(['same_month', 'previous_month']).optional(),
  // Vacation year basis (payroll gap-closure 3.1): the statutory Apr 1 - Mar
  // 31 split (a new company's default) or the sammanfallande calendar year.
  // The settings route blocks changing this while open vacation-ledger rows
  // exist.
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
// VAT filing record (issues #2746, #2786)
// ============================================================

/**
 * A VAT period of any cadence, the key of the filing record
 * (lib/vat/filing-record.ts). Yearly (helårsmoms) is the räkenskapsår, named
 * like every yearly VAT period: the year it ends in, period 1. Shared by the
 * dashboard routes and the vat-filings operations (v1 and MCP).
 */
const vatFilingPeriodShape = {
  period_type: z
    .enum(['monthly', 'quarterly', 'yearly'])
    .describe('The momsperiod length; yearly is helårsmoms, one period per räkenskapsår.'),
  year: z.coerce
    .number()
    .int()
    .min(2000)
    .max(2100)
    .describe('Calendar year of the period; for yearly, the year the räkenskapsår ends.'),
  period: z.coerce.number().int().min(1).max(12).describe('1-12 monthly, 1-4 quarterly, 1 yearly.'),
}

function refineVatFilingPeriod(
  data: { period_type: 'monthly' | 'quarterly' | 'yearly'; period: number },
  ctx: z.RefinementCtx,
) {
  if (data.period_type === 'quarterly' && data.period > 4) {
    ctx.addIssue({
      code: 'custom',
      path: ['period'],
      message: 'For quarterly period_type, period must be 1-4.',
    })
  }
  if (data.period_type === 'yearly' && data.period !== 1) {
    ctx.addIssue({
      code: 'custom',
      path: ['period'],
      message: 'For yearly period_type, period must be 1.',
    })
  }
}

export const VatFilingPeriodSchema = z.object(vatFilingPeriodShape).superRefine(refineVatFilingPeriod)

/** The period of a reviewed momsredovisning on the dashboard voucher door (CreateDashboardJournalEntrySchema). */
export const VatSettlementPeriodSchema = z
  .object({
    ...vatFilingPeriodShape,
    fiscal_period_id: uuid.optional(),
  })
  .superRefine(refineVatFilingPeriod)

export const MarkVatFilingSchema = z
  .object({
    ...vatFilingPeriodShape,
    /** Swedish calendar date the declaration was filed. */
    filed_on: saneIsoDate.describe(
      'Swedish calendar date the declaration was filed (YYYY-MM-DD): after the period ended, not in the future.',
    ),
    /** Skatteverket's reference (kvittensnummer); null clears a stored one. */
    reference: z
      .string()
      .trim()
      .max(200)
      .nullable()
      .optional()
      .describe("Skatteverket's reference (kvittensnummer). Omit to keep a stored one, null to clear it."),
  })
  .superRefine(refineVatFilingPeriod)

/**
 * One momsdeklaration finding of one VAT period, the key of a review
 * (lib/vat/check-reviews.ts, crm#1171). Shared by the dashboard route
 * /api/reports/vat-declaration/check-reviews and the MCP-only operation
 * vat-check-reviews.mark (gnubok_mark_vat_check_reviewed).
 */
const vatCheckReviewTargetShape = {
  ...vatFilingPeriodShape,
  fiscal_period_id: z
    .string()
    .uuid()
    .optional()
    .describe('Yearly only, optional: the räkenskapsår the period is, instead of the year it ends in.'),
  check_code: z
    .enum(VAT_DECLARATION_CHECK_CODES)
    .describe("The finding's code, as declaration_checks (gnubok_vat_close_check) reports it."),
}

export const VatCheckReviewTargetSchema = z.object(vatCheckReviewTargetShape).superRefine(refineVatFilingPeriod)

export const MarkVatCheckReviewedSchema = z
  .object({
    ...vatCheckReviewTargetShape,
    note: z
      .string()
      .trim()
      .max(1000)
      .optional()
      .describe('What was checked, e.g. "Basbeloppet är bokat i A61" (max 1000 characters).'),
    expected_fingerprint: z
      .string()
      .regex(/^v[0-9]+:[0-9a-f]{16}$/)
      .optional()
      .describe('The finding as seen (a dry run answers it); refused as VAT_CHECK_CHANGED when the figures moved since.'),
  })
  .superRefine(refineVatFilingPeriod)

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

// Momsruta override for 26xx VAT accounts; lib/vat/account-vat-box.ts is the
// source of truth and the DB CHECK on chart_of_accounts.vat_box mirrors it.
export const AccountVatBoxSchema = z.enum(ACCOUNT_VAT_BOXES)
const vatBox = AccountVatBoxSchema.nullable().optional()

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
  vat_box: vatBox,
  sru_code: z.string().nullable().optional(),
})

export const UpdateAccountSchema = z.object({
  account_name: z.string().min(1).optional(),
  is_active: z.boolean().optional(),
  description: z.string().nullable().optional(),
  default_vat_code: z.string().nullable().optional(),
  default_vat_rate: defaultVatRate,
  default_vat_treatment: defaultVatTreatment,
  vat_box: vatBox,
  sru_code: z.string().nullable().optional(),
})

/**
 * Which EU country each OSS account is for (unionsordningen): the request of
 * every door (accounts.oss-countries). Which account may take what is decided
 * in lib/vat/oss-account-countries.ts.
 */
export const SetOssAccountCountriesSchema = z.object({
  accounts: z
    .array(
      z.object({
        account_number: z.string().min(1).max(10),
        country: z
          .string()
          .nullable()
          .describe('ISO 3166-1 alpha-2 of another EU country, e.g. "DE". "EU" on a VAT account shared by every country. null clears the account.'),
        vat_rate: z.number().nullable().optional().describe('Percent, e.g. 19 or 25.5. Sales accounts only.'),
      }),
    )
    .min(1)
    .max(200),
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
      .max(MAX_BANK_ROW_SPLIT)
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
    (d) => d <= todayIsoStockholm(),
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
  status: z.enum(['pending', 'committed', 'rejected', 'failed_partial', 'unknown']).default('pending'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
  // Newest first by default; a bokslut batch of fifty operations is worked
  // oldest first, so the queue can be flipped.
  order: z.enum(['asc', 'desc']).default('desc'),
})

export const PendingOperationsBulkSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(BULK_IDS_MAX),
  // The routine high-risk groups the person acknowledged in the bulk dialog
  // (lib/pending-operations/shared-acknowledgment.ts). A high-risk operation
  // outside an acknowledged group is skipped, as before.
  acknowledged_groups: z.array(z.enum(SHARED_ACKNOWLEDGMENT_GROUPS)).max(SHARED_ACKNOWLEDGMENT_GROUPS.length).optional(),
})

// Bulk reject: same id list plus the person's category (required) and an
// optional reason, applied to every rejected row.
export const PendingOperationsBulkRejectSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(BULK_IDS_MAX),
  rejection_category: z.enum(PERSON_REJECTION_CATEGORIES),
  rejection_reason: z.string().max(2000).optional(),
})

// ============================================================
// Audit trail schemas
// ============================================================

// `satisfies` keeps every filter value a member of the AuditAction union:
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
  // The report's own list, so a new category (beslut) cannot drift out of
  // the filter the way arkiv did.
  category: z.enum(BEHANDLINGSHISTORIK_CATEGORIES).optional(),
  format: z.enum(['json', 'csv', 'xlsx', 'pdf']).default('json'),
})

/**
 * GET /api/bookkeeping/fiscal-periods/[id]/ef-declaration: the year-end
 * wizard's NE-bilaga inputs. An absent or empty field means "not entered"
 * (coercing '' would read it as 0); amounts that can only be zero or more
 * are refused when negative.
 */
/**
 * Earlier years' EF periodiseringsfonder as "år:belopp" pairs separated by
 * commas ("2019:50000,2021:30000"), one per avsättningsår.
 */
const efPfondFonderParam = z
  .string()
  .regex(
    /^\d{4}:\d+(\.\d{1,2})?(,\d{4}:\d+(\.\d{1,2})?)*$/,
    'Ange periodiseringsfonderna som år:belopp, till exempel 2019:50000,2021:30000',
  )
  .transform((value) =>
    value.split(',').map((pair) => {
      const [year, balance] = pair.split(':')
      return { cohort_year: Number(year), balance: Number(balance) }
    }),
  )
  .refine((fonder) => fonder.length <= 10, 'Högst 10 periodiseringsfonder')
  .refine(
    (fonder) => new Set(fonder.map((fond) => fond.cohort_year)).size === fonder.length,
    'Varje avsättningsår får bara finnas en gång',
  )

export const EfDeclarationPreviewQuerySchema = z.object({
  category: z.enum(['full', 'pensioner', 'passive']).optional(),
  kapitalunderlag: emptyStringAsUndefined(z.coerce.number()),
  sparatFordelningsbelopp: emptyStringAsUndefined(z.coerce.number().nonnegative()),
  expansionsfondKapitalunderlag: emptyStringAsUndefined(z.coerce.number()),
  priorYearSchablonavdrag: emptyStringAsUndefined(z.coerce.number().nonnegative()),
  priorYearActualCharged: emptyStringAsUndefined(z.coerce.number().nonnegative()),
  pfondDesiredAmount: emptyStringAsUndefined(z.coerce.number().nonnegative()),
  pfondExistingFonder: emptyStringAsUndefined(efPfondFonderParam),
  expansionsfondExistingBalance: emptyStringAsUndefined(z.coerce.number().nonnegative()),
  expansionsfondDesiredChange: emptyStringAsUndefined(z.coerce.number()),
})

/** Semesterskuld: as of a fiscal period's end (period_id) or Dec 31 of `year`. */
export const VacationLiabilityQuerySchema = z.object({
  period_id: uuid.optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  // A date of its own (a month end) instead of the period's end or Dec 31.
  as_of: isoDate.optional(),
  format: z.enum(['json', 'xlsx', 'pdf']).default('json'),
})

const previewTokenField = z.string().regex(/^pv1\.[A-Za-z0-9_-]{43}$/, 'Ogiltig förhandsgranskning').optional()

/** POST /api/salary/vacation-liability/reconcile: stäm av semesterlöneskuld per datum. */
export const VacationLiabilityReconcileSchema = z
  .object({
    as_of: saneIsoDateSchema,
    dry_run: z.boolean().optional(),
    preview_token: previewTokenField,
  })
  .strict()

/** POST /api/salary/vacation-liability/method: how the semesterlöneskuld is booked. */
export const VacationLiabilityMethodSchema = z
  .object({
    method: z.enum(['accrual', 'remeasure']),
    dry_run: z.boolean().optional(),
    preview_token: previewTokenField,
  })
  .strict()

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
  }).refine(isSingleSidedLine, SINGLE_SIDED_LINE_ISSUE)).min(2, 'At least two lines are required for double-entry'),
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

/** GET /api/import/opening-balance/split-per-project: the preview's year (#3313). */
export const OpeningBalanceSplitQuerySchema = z.object({
  fiscal_period_id: uuid,
})

/** POST /api/import/opening-balance/split-per-project: apply the previewed split. */
export const OpeningBalanceSplitApplySchema = z.object({
  fiscal_period_id: uuid,
  expected_fingerprint: z.string().min(1).max(64).optional(),
})

// ============================================================
// Register import schemas (customers, suppliers)
// ============================================================

/** What a register row states of the type: TypeStated in lib/import/shared/stated-fields.ts. */
const statedTypeField = z.enum(['type', 'business']).nullable().default(null)

const ImportedCustomerRowSchema = z.object({
  row_index: z.number().int(),
  name: z.string().min(1),
  customer_type: CustomerTypeSchema,
  // What the file (or the review step) states of the type and the country
  // (lib/import/customers/types.ts): an update writes only that. Nothing
  // stated for a wizard opened before the fields existed, so its update
  // leaves both.
  customer_type_stated: statedTypeField,
  country_stated: z.boolean().default(false),
  // Defaulted so a wizard opened before the field existed can still submit.
  customer_number: z.string().trim().max(32).nullable().default(null),
  org_number: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  address_line1: z.string().nullable(),
  address_line2: z.string().nullable(),
  postal_code: z.string().nullable(),
  city: z.string().nullable(),
  country: countryCode,
  vat_number: z.string().nullable(),
  default_payment_terms: z.number().int().min(0).max(365).nullable(),
  notes: z.string().nullable(),
  // The existing customer the user said this row is (same name, nothing else
  // matched). Defaulted like customer_number for an older wizard.
  confirmed_duplicate_of: z.string().uuid().nullable().default(null),
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
  // Same: the preview flags an individual with an org number that is not a
  // personnummer, and a hand-built request is refused here.
  if (isOrgNumberRefusedOnIndividual(row.customer_type, row.org_number)) {
    ctx.addIssue({ code: 'custom', path: ['org_number'], message: INDIVIDUAL_ORG_NUMBER_MESSAGE })
  }
}).transform((row) => {
  // An individual's personnummer arrives in the file's org number column
  // (the classifier types a row as individual BECAUSE that column holds a
  // personnummer). It is moved into personal_number, which the route
  // encrypts, and org_number is left empty, same as CreateCustomerSchema.
  if (!orgNumberHoldsPersonalNumber(row.customer_type, row.org_number)) {
    return { ...row, personal_number: null as string | null }
  }
  return {
    ...row,
    org_number: null,
    personal_number: normalizeReroutedPersonalNumber(row.org_number!) as string | null,
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
  // What the file (or the review step) states of the type, the country and
  // the currency (lib/import/suppliers/types.ts): an update writes only that.
  // Nothing stated for a wizard opened before the fields existed, so its
  // update leaves all three.
  supplier_type_stated: statedTypeField,
  country_stated: z.boolean().default(false),
  default_currency_stated: z.boolean().default(false),
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
  default_payment_terms: z.number().int().min(0).max(365).nullable(),
  default_currency: z.string(),
  notes: z.string().nullable(),
  // The existing supplier the user said this row is (same name, nothing else
  // matched). Defaulted so an older wizard can still submit.
  confirmed_duplicate_of: z.string().uuid().nullable().default(null),
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

// The keys a browser-parsed article file is matched on (POST
// /api/import/articles/match). The client sends a larger file in batches.
export const ArticleImportMatchSchema = z.object({
  rows: z
    .array(z.object({ article_number: z.string().nullable(), name: z.string() }))
    .min(1, 'At least one row is required')
    .max(ARTICLE_MATCH_MAX_ROWS),
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
// Personalkategori: the BAS wage series an employee books on. Arbetare
// (kollektivanställda) book 70xx (7010/7082/7090), tjänstemän 72xx; owners and
// board members ignore it (lib/salary/account-mapping.ts lineItemAccount).
export const PersonnelCategorySchema = z.enum(['arbetare', 'tjansteman'])
export const SalaryTypeSchema = z.enum(['monthly', 'hourly'])
export const FSkattStatusSchema = z.enum(['a_skatt', 'f_skatt', 'fa_skatt', 'not_verified'])
export const VacationRuleSchema = z.enum(['procentregeln', 'sammaloneregeln', 'none', 'semesterersattning'])

/** Vacation pools on a 'vacation' payslip line (migration 20260919130100). */
export const VacationCategorySchema = z.enum(['paid', 'extra_paid', 'saved', 'unpaid', 'advance'])

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
  // Textrad: words only, no money (lib/salary/text-rows.ts, migration 20261014233000).
  'text',
])

// Base employee object (no refinements, safe for .partial())
const EmployeeSchemaBase = z.object({
  first_name: z.string().min(1).max(200),
  last_name: z.string().min(1).max(200),
  personnummer: z.string().regex(/^\d{12}$/, 'Personnummer måste vara 12 siffror (ÅÅÅÅMMDDNNNN)'),
  employment_type: EmploymentTypeSchema.default('employee'),
  personnel_category: PersonnelCategorySchema.default('tjansteman'),
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
  // 0-40 here; the 25-day statutory minimum (semesterlagen 4 §) is a
  // cross-field rule below: it does not apply with vacation_rule 'none'.
  vacation_days_per_year: z.number().int().min(0).max(40).default(25),
  semestertillagg_rate: z.number().min(0).max(0.05).default(0.0043),
  // Kollektivavtal semesterlön rate as a fraction (0.135 = 13.5 %); null =
  // statutory 12 % (14.4 % at 30 days). Bounds mirror the DB CHECK and
  // lib/salary/vacation-pay-rate: below the floor is illegal, above 30 % is
  // a unit typo.
  vacation_pay_rate: z.number().min(0.12).max(0.3).nullable().optional(),
  // Fora uppmärkning (lib/salary/fora/markup.ts): the FOK code the employee
  // is reported to Fora under every month, and the date it applies from. Set
  // together; never on owners or board members (checked below and on update).
  fora_fok_id: z.string().trim().toUpperCase().regex(FORA_FOK_ID_PATTERN, FORA_FOK_ID_FORMAT).optional(),
  fora_fok_start_date: isoDate.optional(),
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
  // Förhöjt skatteavdrag (SFL 11 kap. 22 §, lib/salary/extra-tax.ts): the
  // employee's request to withhold more, whole kronor per run or a requested
  // total percentage of taxable income. At most one is set; null clears.
  extra_tax_amount: z.number().int(EXTRA_TAX_AMOUNT_RANGE).min(1, EXTRA_TAX_AMOUNT_RANGE).max(EXTRA_TAX_AMOUNT_MAX, EXTRA_TAX_AMOUNT_RANGE).nullable().optional(),
  extra_tax_percentage: z.number().refine(isStorableExtraTaxPercentage, EXTRA_TAX_PERCENTAGE_RANGE).nullable().optional(),
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

  // Fewer than 25 vacation days only for an employee without vacation
  // (vacation_rule 'none', e.g. a company owner outside semesterlagen).
  if (vacationDaysBelowMinimum(data.vacation_rule, data.vacation_days_per_year)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: VACATION_DAYS_MINIMUM,
      path: ['vacation_days_per_year'],
    })
  }

  // Jämkning: the engine (isJamkningValid in lib/salary/calculation-engine.ts)
  // applies the beslut only when BOTH dates are set, so a percentage needs
  // both a start and an end date on every write path (#2058). The create body
  // is the whole row, so the shared validator sees the final state here.
  for (const issue of validateJamkning(data)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue.message, path: [issue.field] })
  }

  // Förhöjt skatteavdrag: kronor or percentage, never both.
  for (const issue of validateExtraTax(data)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue.message, path: [issue.field] })
  }

  // Fora code: with its start date, and only on employment_type 'employee'.
  for (const issue of validateForaMarkup(data)) {
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
//
// The update contract (#3008): an absent key leaves the column unchanged and
// an explicit null clears it. Every column that is nullable in the database
// accepts null here; before, only vacation_pay_rate and jämkning did, so an
// emptied slutdatum (or email, bank account, ...) had no way to reach the
// UPDATE and the stored value came back after save. NOT NULL columns keep
// rejecting null. Cross-field rules on the merged row (a monthly employee
// needs a salary, A-skatt needs a table, Växa-stöd needs a start date) are
// checked by every door through lib/salary/employee-update-rules.ts.
const EmployeeSchemaPatchBase = EmployeeSchemaBase.extend({
  employment_end: EmployeeSchemaBase.shape.employment_end.nullable(),
  monthly_salary: EmployeeSchemaBase.shape.monthly_salary.nullable(),
  hourly_rate: EmployeeSchemaBase.shape.hourly_rate.nullable(),
  tax_table_number: EmployeeSchemaBase.shape.tax_table_number.nullable(),
  tax_municipality: EmployeeSchemaBase.shape.tax_municipality.nullable(),
  clearing_number: EmployeeSchemaBase.shape.clearing_number.nullable(),
  bank_account_number: EmployeeSchemaBase.shape.bank_account_number.nullable(),
  email: EmployeeSchemaBase.shape.email.nullable(),
  phone: EmployeeSchemaBase.shape.phone.nullable(),
  address_line1: EmployeeSchemaBase.shape.address_line1.nullable(),
  postal_code: EmployeeSchemaBase.shape.postal_code.nullable(),
  city: EmployeeSchemaBase.shape.city.nullable(),
  fora_fok_id: EmployeeSchemaBase.shape.fora_fok_id.nullable(),
  fora_fok_start_date: EmployeeSchemaBase.shape.fora_fok_start_date.nullable(),
  vaxa_stod_start: EmployeeSchemaBase.shape.vaxa_stod_start.nullable(),
  vaxa_stod_end: EmployeeSchemaBase.shape.vaxa_stod_end.nullable(),
  employment_type: EmploymentTypeSchema,
  personnel_category: PersonnelCategorySchema,
  employment_degree: z.number().min(1).max(100),
  hours_per_week: z.number().positive().max(80),
  workdays_per_week: z.number().min(1).max(7),
  salary_type: SalaryTypeSchema,
  tax_column: z.number().int().min(1).max(6),
  is_sidoinkomst: z.boolean(),
  f_skatt_status: FSkattStatusSchema,
  vacation_rule: VacationRuleSchema,
  vacation_days_per_year: z.number().int().min(0).max(40),
  semestertillagg_rate: z.number().min(0).max(0.05),
  vacation_pay_rate: z.number().min(0.12).max(0.3).nullable(),
  vaxa_stod_eligible: z.boolean(),
  // Update only, never on create (a new employee is active). false is the
  // same soft delete as DELETE, which does nothing but set this flag; true
  // reactivates. The key was advertised by the MCP tool and the DELETE docs
  // while missing here, so Zod stripped it and the PATCH answered 200 with
  // the employee unchanged (crm#1133). NOT NULL in the database: null is
  // refused.
  is_active: z.boolean(),
  // Request only, never a column (lib/salary/employee-update-rules.ts,
  // SAMMALONEREGELN_KOLLEKTIVAVTAL_KEY): true confirms that a central
  // kollektivavtal keeps sammalöneregeln although employment_degree changes
  // (semesterlagen 2 a §, 16 § andra stycket 3-4). Recorded in audit_log.
  sammaloneregeln_kollektivavtal_confirmed: z.boolean(),
})

export const UpdateEmployeeSchema = EmployeeSchemaPatchBase.partial().superRefine((data, ctx) => {
  // Only validate salary when salary_type is being changed in this update.
  // A null amount (clear) counts as missing: the new salary type needs one.
  if (data.salary_type === 'monthly' && data.monthly_salary !== undefined && (data.monthly_salary ?? 0) <= 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Månadslön måste vara större än 0 för månadslöneform',
      path: ['monthly_salary'],
    })
  }
  if (data.salary_type === 'hourly' && data.hourly_rate !== undefined && (data.hourly_rate ?? 0) <= 0) {
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
  // the PATCH body carries; merged-state validation (an existing employee
  // with vaxa_stod_start already set can have vaxa_stod_eligible flipped on
  // without also sending start in the body, or have start cleared while the
  // stored flag stays on) is lib/salary/employee-update-rules.ts, run by
  // every door. What the schema CAN enforce:
  //   - If the body enables vaxa_stod AND clears vaxa_stod_start explicitly
  //     (sending null), reject: that would orphan the eligibility flag.
  //   - If both dates are in the body, the end may not precede the start
  //     (a null date skips the ordering check).
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

  // Vacation days: when the body carries both keys the rule is checkable
  // here; a body with one of them is checked on the merged row by
  // lib/salary/employee-update-rules.ts.
  if (
    data.vacation_rule !== undefined &&
    data.vacation_days_per_year !== undefined &&
    vacationDaysBelowMinimum(data.vacation_rule, data.vacation_days_per_year)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: VACATION_DAYS_MINIMUM,
      path: ['vacation_days_per_year'],
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

  // Förhöjt skatteavdrag: both forms in one body is refused here; one form
  // sent while the other is stored is the merged-row check in
  // lib/salary/employee-update-rules.ts.
  for (const issue of validateExtraTax(data)) {
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

// ============================================================
// Shift premium rules (OB-tillägg / övertid): shift_premium_rules
// ============================================================

/** The six premium families the engine derives (migration 20260526120900). */
export const ShiftPremiumItemTypeSchema = z.enum([
  'overtime_50',
  'overtime_100',
  'ob_weekday_evening',
  'ob_weekend',
  'ob_night',
  'ob_holiday',
])

/** How a premium hour is priced (migration 20261027213119, lib/salary/shift-premium-engine.ts). */
export const ShiftPremiumAmountFormSchema = z.enum(['percent_of_hourly', 'monthly_divisor', 'sek_per_hour'])

/** 'HH:MM' wall-clock time, 00:00 to 23:59. Seconds are dropped on input so
 * the stored TIME and the UI agree on one shape. */
const clockTime = z
  .string()
  .regex(/^\d{2}:\d{2}$/, 'Ange klockslag som HH:MM')
  .refine((v) => {
    const [h, m] = v.split(':').map(Number)
    return h >= 0 && h <= 23 && m >= 0 && m <= 59
  }, 'Ange klockslag mellan 00:00 och 23:59')

const isoWeekdayArray = z
  .array(z.number().int().min(1).max(7))
  .min(1, 'Välj minst en veckodag')
  .max(7)
  .refine((days) => new Set(days).size === days.length, 'Samma veckodag angiven flera gånger')

const twoDecimals = (v: number) => Math.round(v * 100) === v * 100

const premiumPercent = z.number().min(0).max(500).refine(twoDecimals, 'Max två decimaler')
const premiumMonthlyDivisor = z
  .number()
  .min(1, 'Delaren måste vara minst 1')
  .max(10000)
  .refine(twoDecimals, 'Max två decimaler')
const premiumSekPerHour = z.number().min(0).max(10000).refine(twoDecimals, 'Max två decimaler')
const premiumHourlyDivisor = z
  .number()
  .min(1, 'Delaren måste vara minst 1')
  .max(1000)
  .refine(twoDecimals, 'Max två decimaler')

const SHIFT_PREMIUM_SCOPE_MESSAGE = 'Välj antingen alla anställda eller minst en namngiven anställd'

export const SHIFT_PREMIUM_VALIDITY_MESSAGE = '"Gäller till" måste vara samma dag som eller efter "Gäller från".'

/** Both scope fields together: all=true means no named employees, all=false
 * means at least one. Shared by create (always both present) and the merged
 * state on update (the service merges with the stored row before checking). */
export function shiftPremiumScopeIsConsistent(appliesToAll: boolean, employeeIds: string[]): boolean {
  return appliesToAll ? employeeIds.length === 0 : employeeIds.length > 0
}

export interface ShiftPremiumAmountFields {
  premium_percent: number | null
  monthly_divisor: number | null
  sek_per_hour: number | null
  hourly_divisor: number | null
}

/**
 * The amount field of each form, mirroring the DB CHECK
 * shift_premium_rules_amount_fields_check: exactly the form's own field is
 * set, and hourly_divisor only ever accompanies percent_of_hourly. Returns
 * the offending field, or null when the combination is valid.
 */
export function shiftPremiumAmountFieldError(
  form: z.infer<typeof ShiftPremiumAmountFormSchema>,
  fields: ShiftPremiumAmountFields,
): keyof ShiftPremiumAmountFields | null {
  const own: Record<typeof form, keyof ShiftPremiumAmountFields> = {
    percent_of_hourly: 'premium_percent',
    monthly_divisor: 'monthly_divisor',
    sek_per_hour: 'sek_per_hour',
  }
  if (fields[own[form]] == null) return own[form]
  for (const key of ['premium_percent', 'monthly_divisor', 'sek_per_hour'] as const) {
    if (key !== own[form] && fields[key] != null) return key
  }
  if (form !== 'percent_of_hourly' && fields.hourly_divisor != null) return 'hourly_divisor'
  return null
}

const SHIFT_PREMIUM_AMOUNT_MESSAGES: Record<keyof ShiftPremiumAmountFields, string> = {
  premium_percent: 'Ange procent för procent av timlön, och bara då',
  monthly_divisor: 'Ange delare för månadslön delat med, och bara då',
  sek_per_hour: 'Ange kronor för kronor per timme, och bara då',
  hourly_divisor: 'Timlönedelaren hör bara till procent av timlön',
}

export function shiftPremiumAmountMessage(field: keyof ShiftPremiumAmountFields): string {
  return SHIFT_PREMIUM_AMOUNT_MESSAGES[field]
}

export const CreateShiftPremiumRuleSchema = z
  .object({
    name: z.string().trim().min(1, 'Ange ett namn').max(100),
    day_of_week: isoWeekdayArray,
    start_time: clockTime,
    /** end <= start means the window wraps past midnight (22:00-06:00). */
    end_time: clockTime,
    /** Defaults to percent_of_hourly, the only form before 2026-10. */
    amount_form: ShiftPremiumAmountFormSchema.default('percent_of_hourly'),
    premium_percent: premiumPercent.nullable().optional(),
    monthly_divisor: premiumMonthlyDivisor.nullable().optional(),
    sek_per_hour: premiumSekPerHour.nullable().optional(),
    hourly_divisor: premiumHourlyDivisor.nullable().optional(),
    valid_from: isoDate,
    valid_to: isoDate.nullable().optional(),
    item_type: ShiftPremiumItemTypeSchema,
    priority: z.number().int().min(-1000).max(1000).default(0),
    applies_to_all_employees: z.boolean().default(true),
    applies_to_employee_ids: z.array(uuid).max(500).default([]),
    is_active: z.boolean().default(true),
  })
  .superRefine((data, ctx) => {
    const amountError = shiftPremiumAmountFieldError(data.amount_form, {
      premium_percent: data.premium_percent ?? null,
      monthly_divisor: data.monthly_divisor ?? null,
      sek_per_hour: data.sek_per_hour ?? null,
      hourly_divisor: data.hourly_divisor ?? null,
    })
    if (amountError) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: shiftPremiumAmountMessage(amountError),
        path: [amountError],
      })
    }
    if (data.valid_to && data.valid_to < data.valid_from) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: SHIFT_PREMIUM_VALIDITY_MESSAGE, path: ['valid_to'] })
    }
    if (!shiftPremiumScopeIsConsistent(data.applies_to_all_employees, data.applies_to_employee_ids)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: SHIFT_PREMIUM_SCOPE_MESSAGE,
        path: ['applies_to_employee_ids'],
      })
    }
    if (new Set(data.applies_to_employee_ids).size !== data.applies_to_employee_ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Samma anställd angiven flera gånger',
        path: ['applies_to_employee_ids'],
      })
    }
  })

/**
 * Partial update. The amount fields and the scope pair are checked on the
 * merged state by lib/salary/shift-premium-rules.ts; here only what the body
 * alone can show. Sending amount_form switches the form: the service clears
 * the fields of the other forms, so the body names the new form's field only.
 */
export const UpdateShiftPremiumRuleSchema = z
  .object({
    name: z.string().trim().min(1, 'Ange ett namn').max(100).optional(),
    day_of_week: isoWeekdayArray.optional(),
    start_time: clockTime.optional(),
    end_time: clockTime.optional(),
    amount_form: ShiftPremiumAmountFormSchema.optional(),
    premium_percent: premiumPercent.optional(),
    monthly_divisor: premiumMonthlyDivisor.optional(),
    sek_per_hour: premiumSekPerHour.optional(),
    /** null clears it (back to the employee's schedule divisor). */
    hourly_divisor: premiumHourlyDivisor.nullable().optional(),
    valid_from: isoDate.optional(),
    /** null clears it (open-ended). */
    valid_to: isoDate.nullable().optional(),
    item_type: ShiftPremiumItemTypeSchema.optional(),
    priority: z.number().int().min(-1000).max(1000).optional(),
    applies_to_all_employees: z.boolean().optional(),
    applies_to_employee_ids: z.array(uuid).max(500).optional(),
    is_active: z.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    if (Object.keys(data).length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Inga fält att uppdatera' })
    }
    if (data.valid_from && data.valid_to && data.valid_to < data.valid_from) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: SHIFT_PREMIUM_VALIDITY_MESSAGE, path: ['valid_to'] })
    }
    // Scope is only checkable here when both halves travel together; a
    // single-field patch is checked against the stored row by the service.
    if (
      data.applies_to_all_employees !== undefined &&
      data.applies_to_employee_ids !== undefined &&
      !shiftPremiumScopeIsConsistent(data.applies_to_all_employees, data.applies_to_employee_ids)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: SHIFT_PREMIUM_SCOPE_MESSAGE,
        path: ['applies_to_employee_ids'],
      })
    }
    if (data.applies_to_employee_ids && new Set(data.applies_to_employee_ids).size !== data.applies_to_employee_ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Samma anställd angiven flera gånger',
        path: ['applies_to_employee_ids'],
      })
    }
  })

export type CreateShiftPremiumRuleInput = z.infer<typeof CreateShiftPremiumRuleSchema>
export type UpdateShiftPremiumRuleInput = z.infer<typeof UpdateShiftPremiumRuleSchema>

export const RecurringLineItemTypeSchema = z.enum(RECURRING_LINE_ITEM_TYPES)

/** Same inclusive-bound semantics as BENEFIT_PERIOD_ORDER_MESSAGE, for
 * employee_recurring_lines (migration 20260902140000). */
export const RECURRING_LINE_PERIOD_ORDER_MESSAGE =
  '"Gäller till" måste vara samma dag som eller efter "Gäller från". Lämna fältet tomt för en löpande rad.'

const recurringLineAmountIssue = (
  data: { item_type?: string; amount?: number },
  ctx: z.RefinementCtx,
) => {
  // Mirrors the employee_recurring_lines_amount_sign and _text_row CHECKs:
  // a deduction is negative, a text row is 0. Kept in the schema so the
  // violation is a field-level 400 instead of a Postgres 23514.
  if (data.item_type === undefined) return
  const message = validateRecurringLineAmount(data.item_type as RecurringLineItemType, data.amount)
  if (message) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message,
      path: ['amount'],
    })
  }
}

/** benefit_type names the benefit a nettolöneavdrag för förmån pays for (crm#1492). */
export const RECURRING_LINE_BENEFIT_TYPE_MESSAGE =
  'Förmånen anges bara på ett nettolöneavdrag för förmån (net_deduction_benefit_payment).'

export const CreateEmployeeRecurringLineSchema = z.object({
  item_type: RecurringLineItemTypeSchema,
  description: z.string().min(1).max(200),
  // A text row has no amount: omitted means 0 (lib/salary/text-rows.ts).
  amount: z.number().optional(),
  account_number: accountNumberSchema.optional(),
  benefit_type: EmployeeBenefitTypeSchema.optional().describe(
    'net_deduction_benefit_payment only: the benefit this payment is for. Required when the employee has several benefit types.',
  ),
  valid_from: isoDate,
  valid_to: isoDate.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  is_active: z.boolean().optional(),
}).superRefine((data, ctx) => {
  recurringLineAmountIssue(data, ctx)
  if (data.benefit_type !== undefined && data.item_type !== 'net_deduction_benefit_payment') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: RECURRING_LINE_BENEFIT_TYPE_MESSAGE, path: ['benefit_type'] })
  }
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
  benefit_type: EmployeeBenefitTypeSchema.nullable().optional(),
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
  // Omitted: the company's salary series (lib/salary/create-run.ts
  // resolveSalaryRunSeries), the same rule as the dashboard and MCP.
  voucher_series: z.string().regex(/^[A-Z]$/, 'Verifikationsserie måste vara en bokstav A-Z').optional(),
  notes: z.string().max(2000).optional(),
  // Avvikelseperiod: the calendar window absence + worked days are read
  // from. Both or neither; omitted = company_settings.salary_deviation_period
  // (same_month | previous_month). Pairing, ordering and the two-month cap
  // are enforced in lib/salary/deviation-period.ts so every creation path
  // (dashboard, v1, MCP) gets identical errors.
  deviation_period_start: isoDate.optional(),
  deviation_period_end: isoDate.optional(),
})

// One-click variant for the dashboard route: all fields optional - the route
// resolves defaults server-side (period = month after the latest
// non-corrected run, payment date from company_settings.salary_pay_day,
// series from the per-source-type map), so "Starta lönekörning" can POST {}.
// The v1 REST surface keeps the strict CreateSalaryRunSchema above (period
// and payment date are required there and 400 on omissions).
export const CreateSalaryRunWithDefaultsSchema = z.object({
  period_year: z.number().int().min(2020).max(2100).optional(),
  period_month: z.number().int().min(1).max(12).optional(),
  payment_date: isoDate.optional(),
  voucher_series: z.string().regex(/^[A-Z]$/, 'Verifikationsserie måste vara en bokstav A–Z').optional(),
  notes: z.string().max(2000).optional(),
  deviation_period_start: isoDate.optional(),
  deviation_period_end: isoDate.optional(),
})

// A new version of a run's pain.001 (crm#1219). The confirmation is the
// guard against paying the month twice: without it there is no new version.
export const NewSalaryPaymentFileVersionSchema = z
  .object({
    confirm_previous_not_approved: z.literal(true, {
      message: 'Bekräfta att den tidigare betalfilen inte har godkänts i banken',
    }),
  })
  .strict()

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
  // Required on every row but a text row (item_type 'text', words only),
  // which has no amount. The shared line commands
  // (lib/salary/payslip-lines.ts) refuse a missing or 0 kr amount on any
  // other row, except a vacation row that carries days in quantity.
  amount: z.number().optional(),
  account_number: accountNumber.optional(),
  sort_order: z.number().int().default(0),
  // Engångsskatt (lib/salary/one-off-tax.ts): the verified Skatteverket
  // percentage for a one-off amount (bonus, provision, semesterersättning at
  // final settlement). null/omitted = taxed by the monthly table. Only valid
  // on a positive taxable addition of an eligible type: the shared command
  // module answers 400 and the DB CHECK refuses anything else.
  one_off_tax_percent: z.number().min(0).max(100).nullable().optional(),
  // Which vacation pool a 'vacation' line draws from (lib/salary/vacation-
  // category.ts), in Fortnox/Azets terms: paid = Betalda (the default when
  // omitted), extra_paid = Extra betalda, saved = Sparade, unpaid = Obetalda,
  // advance = Förskott. Only valid on item_type 'vacation'; the shared command
  // module answers 400 and the DB CHECK refuses anything else.
  vacation_category: VacationCategorySchema.nullable().optional(),
  // Origin year of the sparade dagar a 'saved' line consumes. Omitted = the
  // oldest saved year first (the one that expires first).
  vacation_saved_year: fiscalYearSchema.nullable().optional(),
  // Semesterlön for rörliga lönedelar paid with this salary
  // (lib/salary/variable-vacation-pay.ts): only on a positive
  // semesterersattning row of an employee on sammalöneregeln. true is the
  // caller's confirmation that a central kollektivavtal lets it be paid with
  // the salary (Semesterlagen 2 a § andra stycket), recorded in audit_log.
  // The calculation then counts the row as already paid.
  settles_variable_vacation_pay: z.boolean().optional(),
})

// account_number is an override only (lib/salary/account-mapping.ts): null
// drops a stored override so the line books on the default the booking
// resolves from the item type and the employee. settles_variable_vacation_pay
// is set when the line is added, with its confirmation: a changed mind is a
// deleted line and a new one.
export const UpdateSalaryLineItemSchema = CreateSalaryLineItemSchema.partial()
  .omit({ salary_run_employee_id: true, settles_variable_vacation_pay: true })
  .extend({ account_number: accountNumber.nullable().optional() })

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
  // Omitted: one scheduled day of the employee (lib/salary/absence.ts).
  hours: z.number().positive().max(24).optional(),
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
  // Explicit null = the previous system could not export historical net pay;
  // the payslip then prints "Underlag saknas" for the accumulator instead of
  // a false 0. Omitted still means 0 (the full-replace default).
  ytd_net: z.number().min(0).nullable().default(0),
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
  // Categorized vacation pools (migration 20260919130000), in Fortnox/Azets
  // terms. vacation_paid_days_remaining above is Betalda and
  // vacation_saved_days_by_year is Sparade per år; these complete the set.
  //
  // The day the vacation pools are struck per. Omitted/null = the day before
  // cutover_date. Booked runs whose avvikelseperiod ends on or before this day
  // are already inside the balance and are not deducted again by the ledger,
  // so under salary_deviation_period = previous_month a balance the old system
  // struck BEFORE the month the first Accounted run deducts must say so here.
  vacation_as_of_date: isoDate.nullable().optional(),
  // Obetalda: unpaid days left this vacation year (lapse at year close).
  vacation_unpaid_days_remaining: z.number().min(0).max(40).default(0),
  // Förskott: förskottssemester days granted but not yet taken.
  vacation_advance_days_remaining: z.number().min(0).max(40).default(0),
  // Extra betalda: paid days above the statutory entitlement left this year;
  // counted into the paid pool with vacation_paid_days_remaining.
  vacation_extra_paid_days_remaining: z.number().min(0).max(40).default(0),
  // Förskottsskuld in SEK (Semesterlagen 29 a §). Report only: its own row on
  // the vacation-liability report, subtracted from the net liability.
  opening_advance_vacation_debt: z.number().min(0).default(0),
}

const openingBalancesRefine = (
  data: {
    cutover_date: string
    ytd_gross: number
    ytd_tax: number
    vacation_saved_days_by_year: Record<string, number>
    vacation_as_of_date?: string | null
  },
  ctx: z.RefinementCtx,
) => {
    if (data.vacation_as_of_date && data.vacation_as_of_date > data.cutover_date) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'vacation_as_of_date kan inte ligga efter cutover_date',
        path: ['vacation_as_of_date'],
      })
    }
    if (!data.cutover_date.endsWith('-01')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'cutover_date måste vara den första dagen i en månad',
        path: ['cutover_date'],
      })
    }
    const cutoverYear = Number(data.cutover_date.slice(0, 4))
    const currentYear = stockholmYearMonth().year
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
    // Omitted: one scheduled day of the employee (lib/salary/worked-days.ts).
    hours: z.number().positive().max(24).optional(),
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
    // Omitted: one scheduled day of the employee.
    hours: z.number().positive().max(24).optional(),
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
  /** A document another verifikat holds gets a byte-identical copy here (crm#1171). */
  copy: z.boolean().optional(),
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

/** Upper bound for hours in one pay month: 31 days of 24 hours. */
export const HOURS_WORKED_MAX = 744

export const SalaryEmployeeOverrideSchema = z
  .object({
    // Per-run monthly salary for this employee, editable while the run is a
    // draft. 0 is allowed (an intentional nollkörning). This is NOT a review
    // override: it sets the base the engine uses for this month only and does
    // not require a reason. The route gates this field to `draft` status.
    monthly_salary: z.number().nonnegative().max(SALARY_OVERRIDE_MAX).optional(),
    // The hourly counterpart (accounted#1): the period's worked hours as one
    // total, for a period kept without calendar days. Draft only, like
    // monthly_salary; the service refuses it once the calendar has days.
    hours_worked: z.number().nonnegative().max(HOURS_WORKED_MAX).optional(),
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
  // An avgiftsunderlag of 0 kr declares the pay in the AGI as no underlag
  // for socialavgifter (FK131-FK134, e.g. under 1 000 kr in the year, SAL
  // 2 kap. 14 §), so Skatteverket charges no avgift on it: an avgift above
  // 0 next to it would be booked and filed in FK487 for nothing (crm#1372).
  .refine(
    (data) => data.avgifter_basis_override !== 0 || data.avgifter_amount_override === 0,
    {
      message:
        'Avgiftsunderlag 0 kr betyder att ersättningen inte är underlag för arbetsgivaravgifter. Sätt även arbetsgivaravgifterna till 0 kr.',
      path: ['avgifter_amount_override'],
    },
  )
  // The avgiftsunderlag override is a switch, not an amount: 0 (no underlag)
  // or nothing. A partial underlag above 0 has no field of its own in the
  // individuppgift (Bilaga Fältlista 1.1.18.1): the part left out would have
  // to go to FK131 (pay that is no underlag at all) or FK019 (utgifter i
  // arbetet by beslut or schablon), and a bare number says neither, so the
  // IU kept declaring the full pay while the booking and FK487 moved (#91).
  .refine(
    (data) => data.avgifter_basis_override == null || data.avgifter_basis_override === 0,
    {
      message:
        'Avgiftsunderlaget kan bara justeras till 0 kr, när ersättningen inte är underlag för arbetsgivaravgifter. ' +
        'Ett delvis underlag går inte att redovisa i arbetsgivardeklarationen.',
      path: ['avgifter_basis_override'],
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

const expenseCurrency = CurrencySchema

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
    /** Kostnadsställe/projekt for the claim's cost lines: the generated cost
     *  line, or each class 3-8 line of `lines` (a line's own bag wins per key). */
    dimensions: DimensionsBagSchema.optional().describe(
      'Dimensions bag {sie_dim_no: code}, e.g. {"6":"P001"}, for the cost line(s). With lines, it is the default for every class 3-8 line; per-line dimensions win per key.',
    ),
    /** Omvänd skattskyldighet on the generated lines (crm#1028). */
    reverse_charge: z.enum(EXPENSE_CLAIM_REVERSE_CHARGE_KINDS).optional().describe(
      'Omvänd skattskyldighet for a service under huvudregeln (SaaS, licences, ads, consulting) from a seller abroad that charged no VAT: eu_services (seller in another EU country, ruta 21) or non_eu_services (outside the EU, ruta 22). Never for hotel, restaurant, taxi, travel or event tickets abroad (taxed where performed) or a VAT-exempt service: those are booked gross without it. Adds the fiktiv moms 2645 D / 2614 K and the basis pair 4535|4531 D / 4598 K on the SEK amount (no pair when expense_account reports that ruta itself; an expense_account that reports another box, or carries a reverse-charge momskod without a 25/12/6 % rate, is refused). Needs vat_amount 0 and no lines.',
    ),
    /** Advanced booking: full verifikat lines in claim currency. Deep
     *  validation (balance, liability line) happens in the service. */
    lines: z
      .array(
        z.object({
          account_number: accountNumberSchema,
          debit_amount: z.number().nonnegative().default(0),
          credit_amount: z.number().nonnegative().default(0),
          line_description: z.string().trim().max(300).optional().nullable(),
          // Carried onto the posted line (the service always accepted it;
          // without it here the bag was silently stripped at the door).
          dimensions: DimensionsBagSchema.optional(),
        }).refine(isSingleSidedLine, SINGLE_SIDED_LINE_ISSUE),
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
    if (data.reverse_charge && data.vat_amount > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Vid omvänd skattskyldighet har kvittot ingen moms: ange momsen 0.',
        path: ['vat_amount'],
      })
    }
    if (data.reverse_charge && data.lines) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Omvänd skattskyldighet bokförs på de genererade raderna: skicka antingen reverse_charge eller lines.',
        path: ['reverse_charge'],
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
    // Omitted: the legal form's default for the trips (mileageCounterAccounts).
    counter_account: z.enum(MILEAGE_COUNTER_ACCOUNTS).optional(),
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
  /**
   * The ledger the rows will settle on, when the wizard already knows it (the
   * file's own account is a cash account here, crm#1204). With it the preview
   * applies execute's account guard; without it the guard never rejects.
   */
  // A 19xx bank ledger or a company card's liability ledger (execute's rule).
  settlement_account: z.string().regex(CASH_OR_CARD_LEDGER_PATTERN).optional(),
})

/**
 * The statement's own bank account as the parse route read it from the file
 * (BankFileAccountIdentity), sent back with the bank-file execute request.
 */
export const BankFileAccountIdentitySchema = z.object({
  iban: z.string().max(64).nullable(),
  clearing: z.string().max(32).nullable(),
  account_number: z.string().max(64).nullable(),
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
  // The attestation covers filings made on the basis of this company's
  // bookkeeping in Accounted, through any channel; filings a company made
  // from its previous system rest on that system's books (decision
  // 2026-10-18-migration-reset-attestation-reading).
  confirm_no_filed_declarations: z.literal(true, {
    error: 'Bekräfta att inga deklarationer eller årsredovisningar har lämnats in med den här bokföringen som underlag',
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
 * Owner reopen of a year closed with a bokslut (crm#1290): the year's name
 * restated, and the owner's statement that the årsredovisning was not signed,
 * adopted at a stämma or filed outside Accounted. A false statement is passed
 * on, not refused here: the database answers it with
 * FISCAL_YEAR_REOPEN_CONFIRMATION_REQUIRED.
 */
export const FiscalYearReopenSchema = z.object({
  confirm_name: z
    .string()
    .trim()
    .min(1, 'Ange räkenskapsårets namn exakt som det visas')
    .max(200, 'Räkenskapsårets namn får vara högst 200 tecken'),
  confirm_annual_report_not_adopted: z.boolean(),
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
  // Märkning for the order's invoices, the same 200 as on the invoice. Null
  // or blank leaves each invoice to the customer card's.
  invoice_marking: z.string().max(200).nullable().optional(),
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
  view: z.enum(['suggested', 'observed', 'all']).optional(),
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

/** GET /api/company/search: the onboarding picker's free-text query. */
export const CompanySearchQuerySchema = z.object({
  q: z.string().trim().min(3).max(120),
})

/**
 * POST /api/company/check-org-number: in the body, never the URL, because a
 * sole trader's org number is the owner's personnummer and a URL is copied
 * into request logs and error telemetry. Malformed numbers are answered by
 * the route (no match), so only presence is checked here.
 */
export const CheckOrgNumberBodySchema = z.object({
  org_number: z.string().trim().min(1).max(20),
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

// ── Parties (Motparter list + aliases) ────────────────────────────────────

export const PartiesListQuerySchema = z.object({
  q: z.string().max(120).optional(),
  period: z.enum(['12m', 'all']).optional(),
})

/**
 * POST /api/parties/aliases: what a person says about the bank strings the
 * resolver named. rename: these strings mean <name>. not_same: the reading
 * was wrong and nothing is known. Both supersede the live rows and stamp the
 * outcome on them, so the resolver's decision stays in the log.
 */
export const PartyAliasActionSchema = z
  .object({
    aliasKeys: z.array(z.string().min(1).max(300)).min(1).max(50),
    action: z.enum(['rename', 'not_same']),
    name: z.string().trim().min(1).max(200).optional(),
  })
  .refine((v) => v.action !== 'rename' || !!v.name, { message: 'name is required for rename', path: ['name'] })


/**
 * POST /api/packages/:packageId (the Anpassa page): switch a package on or
 * off. dry_run answers what the switch means (for switching off: what keeps
 * the package winding down) and stages nothing; otherwise the switch is
 * staged and the page approves it through /api/pending-operations/:id/commit.
 */
export const PackageSwitchBodySchema = z.object({
  enabled: z.boolean(),
  dry_run: z.boolean().optional(),
})
