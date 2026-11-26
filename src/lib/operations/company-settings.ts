/**
 * Company settings operations. The rules and side effects live in
 * lib/company/settings-service.ts, shared with the dashboard's
 * PUT /api/settings; these definitions only split the settings surface into
 * doors by consequence:
 *
 *   settings.get                         everything below, read
 *   settings.update                      contact, address, invoice layout and
 *                                        payment details, reminders, voucher
 *                                        series, feature toggles (medium: it
 *                                        routes customer payments)
 *   settings.update-tax-profile          VAT/moms, F-skatt, employer
 *                                        registration, fiscal year, accounting
 *                                        method, share capital, the deadline
 *                                        toggles (high: regenerates the tax
 *                                        deadlines, changes how the books are
 *                                        kept and declared)
 *   settings.update-bookkeeping-lock     bookkeeping_locked_through and
 *                                        auto_lock_period_days (high: moving
 *                                        the date back reopens closed dates)
 *
 * Every field in TAX_RELEVANT_FIELDS belongs to the tax profile, so a
 * settings.update never regenerates deadlines because of what it changed
 * (only the dashboard's self-heal of an empty deadline set, which every save
 * performs). Not writable over the API at all: entity_type and org_number
 * (the company's legal identity, fixed at creation), and the payroll fields,
 * which PATCH /api/v1/companies/:companyId/salary/settings owns.
 */
import { z } from 'zod'
import { UpdateSettingsSchema } from '@/lib/api/schemas'
import {
  getCompanySettings,
  updateCompanySettings,
  type CompanySettingsChanges,
  type UpdateCompanySettingsOptions,
} from '@/lib/company/settings-service'
import {
  refineInvoiceSettings,
  upgradeLegacyCompanySettingsParams,
} from '@/lib/pending-operations/schemas/company-settings'
import { defineOperation, type OperationContext, type OperationOutcome, type OperationWarning } from './types'
import { filedVatPeriodsReopenedBy } from '@/lib/vat/filed-periods-reopened'
import { parseEntityType, usesPersonnummerAsOrgNumber } from '@/lib/company/entity-type'
import { INVOICE_QR_MODES } from '@/types'
import { maskPersonnummer } from '@/lib/salary/personnummer-format'
import { vacationYearAgreementWarnings } from '@/lib/salary/vacation-year'
import { resolveInboxAddress } from '@/lib/documents/inbox-address'

const S = UpdateSettingsSchema.shape

function pickShape<T extends z.ZodRawShape, K extends keyof T & string>(shape: T, keys: readonly K[]): Pick<T, K> {
  return Object.fromEntries(keys.map((key) => [key, shape[key]])) as Pick<T, K>
}

/** settings.update: every column except the tax profile, the lock and the fixed identity. */
export const GENERAL_SETTINGS_FIELDS = [
  'company_name',
  'address_line1',
  'address_line2',
  'postal_code',
  'city',
  'registered_office',
  'country',
  'phone',
  'email',
  'website',
  'tax_contact_name',
  'tax_contact_phone',
  'tax_contact_email',
  'bank_name',
  'clearing_number',
  'account_number',
  'bankgiro',
  'plusgiro',
  'swish',
  'iban',
  'bic',
  'swedbank_signer_id',
  'swedbank_corporate_pay_id',
  'nordea_signer_id',
  'nordea_agreement_id',
  'invoice_payment_accounts',
  'invoice_prefix',
  'next_invoice_number',
  'next_arrival_number',
  'invoice_default_days',
  'invoice_default_notes',
  'ore_rounding',
  'invoice_show_ocr',
  'invoice_ocr_length_digit',
  'invoice_show_bankgiro',
  'invoice_show_plusgiro',
  'invoice_show_swish',
  'invoice_show_payment_qr',
  'invoice_qr_mode',
  'invoice_show_logo',
  'invoice_show_article_number',
  'invoice_show_company_name',
  'invoice_company_name_position',
  'invoice_late_fee_text',
  'invoice_credit_terms_text',
  'invoice_late_fee_text_en',
  'invoice_credit_terms_text_en',
  'invoice_payment_links_enabled',
  'invoice_send_order',
  'invoice_email_texts',
  'invoice_email_cc_addresses',
  'invoice_email_bcc_addresses',
  'invoice_email_reply_to',
  'invoice_primary_color',
  'invoice_accent_color',
  'invoice_font_family',
  'invoice_header_text',
  'invoice_footer_text',
  'send_invoice_reminders',
  'reminder_days_level_1',
  'reminder_days_level_2',
  'reminder_days_level_3',
  'reminder_text_overrides',
  'reminder_fee_enabled',
  'reminder_fee_amount',
  'reminder_interest_rate_override',
  'default_voucher_series',
  'default_voucher_series_per_source_type',
  'voucher_series_labels',
  'sector_slug',
  'dimensions_enabled',
  'mileage_enabled',
  'sales_orders_enabled',
  'quotes_enabled',
  'proforma_enabled',
  'recurring_invoices_enabled',
  'self_billing_enabled',
  'self_billing_prefix',
  'next_self_billing_number',
  'self_billing_acceptance_text',
  'salary_vacation_year_basis',
] as const

/** settings.update-tax-profile: the legally significant fields. */
export const TAX_PROFILE_FIELDS = [
  'f_skatt',
  'vat_registered',
  'vat_number',
  'moms_period',
  'vat_taxable_base_over_40m',
  'vat_has_eu_trade',
  'vat_filing_method',
  'periodisk_sammanstallning_enabled',
  'periodisk_sammanstallning_period',
  'periodisk_sammanstallning_filing_method',
  'kontrolluppgifter_enabled',
  'rot_rut_enabled',
  'oss_enabled',
  'ioss_enabled',
  'intrastat_enabled',
  'punktskatt_enabled',
  'fyllnadsinbetalning_enabled',
  'fiscal_year_start_month',
  'preliminary_tax_monthly',
  'pays_salaries',
  'employer_registered',
  'employer_seasonal',
  'accounting_method',
  'defer_invoice_booking',
  'aktiekapital',
  'antal_aktier',
] as const

/** settings.update-bookkeeping-lock: the company-wide lock. */
export const BOOKKEEPING_LOCK_FIELDS = ['bookkeeping_locked_through', 'auto_lock_period_days'] as const

/** Read-only in the resource: the legal identity and onboarding state. */
const IDENTITY_FIELDS = ['entity_type', 'org_number', 'onboarding_complete'] as const

const RESOURCE_FIELDS = [
  ...IDENTITY_FIELDS,
  ...GENERAL_SETTINGS_FIELDS,
  ...TAX_PROFILE_FIELDS,
  ...BOOKKEEPING_LOCK_FIELDS,
] as const

type SettingsRow = Record<string, unknown>

/**
 * The public settings resource: company_id, the reference under its public
 * name contact_person (column default_our_reference), and every field above,
 * null when unset. The 13 fields of the original resource keep their names.
 */
export function toSettingsResource(companyId: string, row: SettingsRow): Record<string, unknown> {
  const resource: Record<string, unknown> = { company_id: companyId, contact_person: row.default_our_reference ?? null }
  for (const field of RESOURCE_FIELDS) resource[field] = row[field] ?? null
  resource.org_number = minimizedOrgNumber(row.org_number, row.entity_type)
  return resource
}

/**
 * An enskild firma's org number is the owner's personnummer (GDPR Art. 5(1)(c)
 * data minimisation): this read also feeds MCP, i.e. an agent's context, so
 * the birth date is kept and the last four digits (sex and checksum) are
 * masked: maskPersonnummer, the one display form. An unknown legal form is
 * treated as a person. A legal person's org number is public.
 */
function minimizedOrgNumber(orgNumber: unknown, entityType: unknown): string | null {
  if (typeof orgNumber !== 'string' || orgNumber === '') return null
  const form = typeof entityType === 'string' ? parseEntityType(entityType) : null
  if (form && !usesPersonnummerAsOrgNumber(form)) return orgNumber
  return maskPersonnummer(orgNumber)
}

/** A column-keyed map under public names (default_our_reference is contact_person). */
function publicKeys(map: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries((map ?? {}) as Record<string, unknown>)) {
    out[key === 'default_our_reference' ? 'contact_person' : key] = value
  }
  return out
}

const nullableString = z.string().nullable()
const nullableBoolean = z.boolean().nullable()
const nullableNumber = z.number().nullable()
const json = z.unknown()

const SettingsResource = z.object({
  company_id: z.string().uuid(),
  entity_type: nullableString,
  org_number: nullableString.describe('The company org number. For an enskild firma it is the owner\'s personnummer and the last four digits are masked.'),
  onboarding_complete: nullableBoolean,
  contact_person: nullableString.describe('Default "Vår referens" on new invoices (column default_our_reference).'),
  invoice_qr_mode: z
    .enum(INVOICE_QR_MODES)
    .nullable()
    .describe('The one payment QR code invoice PDFs print (auto, bank_app, swish, payment_link, none). invoice_show_payment_qr is superseded by it.'),
  ...Object.fromEntries(
    [
      'company_name', 'address_line1', 'address_line2', 'postal_code', 'city', 'registered_office', 'country', 'phone', 'email',
      'website', 'tax_contact_name', 'tax_contact_phone', 'tax_contact_email', 'bank_name', 'clearing_number',
      'account_number', 'bankgiro', 'plusgiro', 'swish', 'iban', 'bic', 'swedbank_signer_id',
      'swedbank_corporate_pay_id', 'nordea_signer_id', 'nordea_agreement_id', 'invoice_prefix', 'invoice_default_notes',
      'invoice_company_name_position', 'invoice_late_fee_text', 'invoice_credit_terms_text',
      'invoice_late_fee_text_en', 'invoice_credit_terms_text_en',
      'invoice_email_reply_to', 'invoice_primary_color', 'invoice_accent_color', 'invoice_font_family',
      'invoice_header_text', 'invoice_footer_text', 'default_voucher_series', 'sector_slug',
      'self_billing_prefix', 'self_billing_acceptance_text',
      'salary_vacation_year_basis', 'vat_number', 'moms_period', 'vat_filing_method',
      'periodisk_sammanstallning_period', 'periodisk_sammanstallning_filing_method', 'accounting_method',
      'bookkeeping_locked_through',
    ].map((key) => [key, nullableString]),
  ),
  ...Object.fromEntries(
    [
      'ore_rounding', 'invoice_show_ocr', 'invoice_ocr_length_digit', 'invoice_show_bankgiro', 'invoice_show_plusgiro', 'invoice_show_swish',
      'invoice_show_payment_qr', 'invoice_show_logo', 'invoice_show_article_number', 'invoice_show_company_name', 'invoice_payment_links_enabled', 'send_invoice_reminders',
      'reminder_fee_enabled', 'dimensions_enabled', 'mileage_enabled', 'sales_orders_enabled',
      'quotes_enabled', 'proforma_enabled', 'recurring_invoices_enabled', 'self_billing_enabled', 'f_skatt',
      'vat_registered', 'vat_taxable_base_over_40m', 'vat_has_eu_trade', 'periodisk_sammanstallning_enabled',
      'kontrolluppgifter_enabled', 'rot_rut_enabled', 'oss_enabled', 'ioss_enabled', 'intrastat_enabled',
      'punktskatt_enabled', 'fyllnadsinbetalning_enabled', 'pays_salaries', 'employer_registered',
      'employer_seasonal', 'defer_invoice_booking',
    ].map((key) => [key, nullableBoolean]),
  ),
  ...Object.fromEntries(
    [
      'next_invoice_number', 'next_arrival_number', 'invoice_default_days', 'reminder_days_level_1',
      'reminder_days_level_2', 'reminder_days_level_3', 'reminder_fee_amount', 'reminder_interest_rate_override',
      'fiscal_year_start_month', 'preliminary_tax_monthly', 'aktiekapital', 'antal_aktier', 'auto_lock_period_days',
      'next_self_billing_number',
    ].map((key) => [key, nullableNumber]),
  ),
  ...Object.fromEntries(
    [
      'invoice_payment_accounts', 'invoice_send_order', 'invoice_email_texts', 'invoice_email_cc_addresses', 'invoice_email_bcc_addresses',
      'reminder_text_overrides', 'default_voucher_series_per_source_type', 'voucher_series_labels',
    ].map((key) => [key, json]),
  ),
})

/** settings.get only: the update operations neither take nor return the inbox address. */
const SettingsReadResource = SettingsResource.extend({
  inbox_address: z.string().nullable().describe('The document inbox address: mail sent or forwarded here becomes an inbox item. Null when the company has no inbox.'),
})

const atLeastOneField = (value: Record<string, unknown>) =>
  Object.values(value).some((field) => field !== undefined)
const AT_LEAST_ONE = 'At least one company setting must be supplied'

/**
 * Runs a settings write through the shared service and maps its outcome to
 * public names. A dry run answers the proposed resource (so
 * `preview.<field>` reads like the resource), plus what changes, what it was,
 * whether the save will regenerate the tax deadlines and whether it turns
 * dimensions on (and so registers the codes already on journal lines).
 * A vacation-year basis that needs a kollektivavtal adds a warning saying
 * so: the settings page asks for the confirmation, these doors cannot.
 */
async function runSettingsWrite(
  ctx: OperationContext,
  changes: CompanySettingsChanges,
  dryRun: boolean,
  options: Pick<UpdateCompanySettingsOptions, 'refuseReopeningFiledVat'> = {},
): Promise<OperationOutcome<{ resource: Record<string, unknown>; deadlines_regenerated: boolean }>> {
  // A staged change (MCP, ?stage=true) runs here when it is approved.
  const via = ctx.pendingOperationId ? 'approval' : 'api'
  const outcome = await updateCompanySettings(ctx, changes, {
    ...options,
    dryRun,
    via,
    findReopenedFiledVatPeriods: filedVatPeriodsReopenedBy,
  })
  if (!outcome.ok) return outcome
  const agreementWarnings = vacationYearAgreementWarnings(changes.salary_vacation_year_basis)
  if (outcome.dryRun) {
    const preview = outcome.preview
    return {
      ok: true,
      dryRun: true,
      preview: {
        ...toSettingsResource(ctx.companyId, preview.proposed as SettingsRow),
        changes: publicKeys(preview.changes),
        previous: publicKeys(preview.previous),
        deadlines_will_regenerate: preview.deadlines_will_regenerate,
        dimension_codes_will_import: preview.dimension_codes_will_import,
        warnings: [...((preview.warnings as OperationWarning[] | undefined) ?? []), ...agreementWarnings],
      },
    }
  }
  const warnings = [...(outcome.warnings ?? []), ...agreementWarnings]
  return {
    ok: true,
    data: {
      resource: toSettingsResource(ctx.companyId, outcome.data.settings),
      deadlines_regenerated: outcome.data.deadlines_regenerated,
    },
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}

const SETTINGS_PATH = '/api/v1/companies/:companyId/settings'

export const settingsGet = defineOperation({
  id: 'settings.get',
  kind: 'read',
  scope: 'companies:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Read the company settings.',
    description:
      'Returns every company setting the API can write: contact and address, invoice payment details and layout, invoice email texts and recipients, reminders, voucher series, feature toggles, the tax profile (VAT/moms, F-skatt, employer registration, fiscal year, accounting method, share capital) and the bookkeeping lock, plus the fixed legal identity (entity_type, org_number) and the document inbox address (inbox_address). contact_person is the default "Vår referens" on new invoices.',
    useWhen:
      'Before creating invoices (payment details must exist), before any settings change, or to learn how the books are kept (accounting_method: accrual = faktureringsmetoden, cash = kontantmetoden; moms_period).',
    doNotUseFor:
      'Payroll settings (GET /salary/settings) or fiscal periods and their locks (GET /fiscal-periods).',
    pitfalls: [
      'Fields that were never set read null, not a default.',
      'bookkeeping_locked_through is the company-wide lock: nothing on or before that date can be booked or changed.',
    ],
    example: {
      response: {
        data: {
          company_id: 'aaaa1111-2222-4333-8444-555566667777',
          entity_type: 'aktiebolag',
          company_name: 'Acme AB',
          contact_person: 'Anna Andersson',
          bankgiro: '991-2346',
          vat_registered: true,
          moms_period: 'quarterly',
          accounting_method: 'accrual',
          bookkeeping_locked_through: '2026-06-30',
        },
        meta: { request_id: 'req_...', api_version: '2026-05-12' },
      },
    },
  },
  input: z.object({}),
  output: SettingsReadResource,
  errorCodes: ['NOT_FOUND'],
  http: { method: 'GET', path: SETTINGS_PATH },
  mcp: {
    name: 'gnubok_get_company_settings',
    title: 'Get Company Settings',
    description:
      'Get the company settings: payment and contact details on invoices, invoice email texts, reminders, voucher series, the tax profile (moms, F-skatt, accounting method, fiscal year) and the bookkeeping lock. Use before creating invoices or staging a settings change.',
    keywords: ['inställningar', 'företagsinställningar', 'momsperiod', 'bokföringsmetod', 'bankgiro'],
  },
  run: async (ctx) => {
    // The inbox address rides along: the MCP briefing has carried it since
    // crm#1174, and a partner portal that shows it to the customer had no
    // read of it. A failed address read is null, never a failed settings read.
    const [outcome, inboxAddress] = await Promise.all([
      getCompanySettings(ctx),
      resolveInboxAddress(ctx.supabase, ctx.companyId),
    ])
    if (!outcome.ok || outcome.dryRun) return outcome
    return { ok: true, data: { ...toSettingsResource(ctx.companyId, outcome.data), inbox_address: inboxAddress } }
  },
})

const GeneralSettingsInput = z
  .object({
    ...pickShape(S, GENERAL_SETTINGS_FIELDS),
    contact_person: S.default_our_reference.describe('Default "Vår referens" on new invoices. Null clears it.'),
    bankgiro: S.bankgiro.describe('7-8 digit Bankgiro with a valid Luhn check digit. Null or empty string clears it.'),
    plusgiro: S.plusgiro.describe('Plusgiro with hyphen and a valid Luhn check digit. Null or empty string clears it.'),
    swedbank_signer_id: S.swedbank_signer_id.describe(
      'Swedbank SignerID, format 123456789ORI0001, assigned by Swedbank. Written as the initiating party of the pain.001 payment files (supplier payments, tax payments, salaries) of a company whose bank is Swedbank or a savings bank; Swedbank refuses such a file without it. Null or empty string clears it.',
    ),
    swedbank_corporate_pay_id: S.swedbank_corporate_pay_id.describe(
      'Swedbank Corporate Pay agreement id, format 123456789CPO0001, assigned by Swedbank. Written as the debtor id of the pain.001 payment files of a Swedbank company; required together with swedbank_signer_id. Null or empty string clears it.',
    ),
    nordea_signer_id: S.nordea_signer_id.describe(
      'Nordea Signer ID, letters and digits (for example NB10000123456), agreed with or assigned by Nordea; Nordea shows it when it refuses a file for the wrong Signer ID. Written as the initiating party (SchmeNm CUST) of the pain.001 payment files (supplier payments, tax payments, salaries) of a company whose bank is Nordea; Nordea refuses such a file without it. Spaces and hyphens are dropped and letters upper-cased. Null or empty string clears it.',
    ),
    nordea_agreement_id: S.nordea_agreement_id.describe(
      'Nordea CCM (Corporate Cash Management) agreement id, letters and digits, assigned by Nordea: at Nordea Business it starts with NB (for example NB123456). Written as the debtor id (SchmeNm BANK) of the pain.001 payment files of a company whose bank is Nordea; required together with nordea_signer_id, and Nordea rejects a file without it. Spaces and hyphens are dropped and letters upper-cased. Null or empty string clears it.',
    ),
    invoice_email_texts: S.invoice_email_texts.describe(
      'Per-language (sv, en) overrides of subject, greeting, body, signoff. Placeholders: {fakturanummer} {kundnamn} {förnamn} {företag} {förfallodatum} {belopp}. Null clears every override.',
    ),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!atLeastOneField(value)) ctx.addIssue({ code: 'custom', message: AT_LEAST_ONE })
    refineInvoiceSettings(value, ctx)
  })

export const settingsUpdate = defineOperation({
  id: 'settings.update',
  kind: 'write',
  scope: 'companies:write',
  // Payment settings decide where customers send money on future invoices.
  risk: 'medium',
  reversible: true,
  docs: {
    summary: 'Partially update company settings (contact, invoicing, reminders, voucher series, toggles).',
    description:
      'Patches any subset of the non-legal company settings: contact and address, invoice payment details (bank account, Bankgiro, Plusgiro, Swish, IBAN/BIC, per-currency payment accounts), the Swedbank SignerID and Corporate Pay id for payment files, invoice numbering, layout and branding, invoice email texts and fixed copy recipients, reminders, voucher series, feature toggles and the vacation-year basis. Same rules as the settings page. Owner or admin only. Idempotent (mandatory Idempotency-Key). Dry-runnable.',
    useWhen:
      'The payment or contact details on invoices change, invoice texts or reminders should be adjusted, or a feature should be switched on or off.',
    doNotUseFor:
      'VAT, F-skatt, fiscal year, accounting method or share capital (PATCH /settings/tax-profile), the bookkeeping lock (PATCH /settings/bookkeeping-lock), payroll settings (PATCH /salary/settings). entity_type and org_number are fixed.',
    pitfalls: [
      'Only an owner or admin of the company may change settings: other members get 403 FORBIDDEN.',
      'contact_person is stored as default_our_reference: the default "Vår referens" on new invoices.',
      'bankgiro and plusgiro must carry a valid Luhn check digit; null or empty string clears them.',
      'iban and bic are what SEK invoices print. The salary, supplier and tax payment files pay from the account the salary is booked on (the primary bank account) with that account\'s own IBAN; they use iban and bic from here only when that account has no IBAN and is the company\'s only SEK bank account, or the company has no bank accounts. The bankgiro here is the sender of a Bankgirot LB file.',
      'invoice_email_texts only accepts the placeholders {fakturanummer} {kundnamn} {förnamn} {företag} {förfallodatum} {belopp}.',
      'reminder_days_level_1 < _2 < _3 must hold after the change (stored values fill in the ones not sent).',
      'The booking engine reads default_voucher_series_per_source_type, not default_voucher_series: send the map to move bookings to another series.',
      'salary_vacation_year_basis cannot change while open vacation balances exist.',
      'Turning dimensions_enabled on also registers the dimension codes already on journal lines as archived registry values, as the settings page does; the warning DIMENSION_CODES_IMPORTED says how many.',
    ],
    example: {
      request: { bankgiro: '991-2346', contact_person: 'Anna Andersson' },
      response: {
        data: {
          company_id: 'aaaa1111-2222-4333-8444-555566667777',
          bankgiro: '991-2346',
          contact_person: 'Anna Andersson',
          email: 'faktura@acme.example',
        },
        meta: { request_id: 'req_...', api_version: '2026-05-12' },
      },
    },
  },
  input: GeneralSettingsInput,
  output: SettingsResource,
  errorCodes: [
    'FORBIDDEN',
    'NOT_FOUND',
    'SETTINGS_REMINDER_DAYS_ORDER',
    'SETTINGS_VACATION_BASIS_OPEN_BALANCES',
  ],
  http: { method: 'PATCH', path: SETTINGS_PATH },
  mcp: {
    name: 'gnubok_update_company_settings',
    title: 'Update Company Settings',
    description:
      'Stage changes to company settings: invoice payment and contact details, invoice texts and layout, reminders, voucher series, feature toggles. VAT, fiscal year and accounting method: gnubok_update_company_tax_profile. Owner/admin only.',
    keywords: ['inställningar', 'företagsinställningar', 'bankgiro', 'påminnelser', 'fakturainställningar'],
    stage: {
      pendingType: 'update_company_settings',
      title: () => 'Uppdatera företagsinställningar',
      upgradeParams: upgradeLegacyCompanySettingsParams,
    },
  },
  run: async (ctx, { contact_person, ...fields }, { dryRun }) => {
    const outcome = await runSettingsWrite(ctx, { ...fields, default_our_reference: contact_person }, dryRun)
    if (!outcome.ok || outcome.dryRun) return outcome
    return { ok: true, data: outcome.data.resource, ...(outcome.warnings ? { warnings: outcome.warnings } : {}) }
  },
})

const TaxProfileInput = z
  .object({
    ...pickShape(S, TAX_PROFILE_FIELDS),
    accounting_method_correction_reason: S.accounting_method_correction_reason.describe(
      'Needed to change accounting_method in a fiscal year with posted verifikat: why the setting was wrong (a correction, recorded in the behandlingshistorik).',
    ),
  })
  .strict()
  .superRefine((value, ctx) => {
    const { accounting_method_correction_reason: _reason, ...fields } = value
    if (!atLeastOneField(fields)) ctx.addIssue({ code: 'custom', message: AT_LEAST_ONE })
  })

export const settingsUpdateTaxProfile = defineOperation({
  id: 'settings.update-tax-profile',
  kind: 'write',
  scope: 'companies:write',
  risk: 'high',
  reversible: true,
  docs: {
    summary: 'Change the tax and legal profile: VAT, F-skatt, employer registration, fiscal year, accounting method.',
    description:
      'Patches the settings that decide how the books are kept and declared: VAT registration, VAT number and moms period, EU trade and periodisk sammanställning, F-skatt, preliminary tax, employer registration, fiscal year start month, accounting method (faktureringsmetoden/kontantmetoden), deferred invoice booking, share capital and the optional deadline reminders. Runs the settings page rules and, like it, regenerates the tax deadlines. Owner or admin only. Idempotent (mandatory Idempotency-Key). Dry-runnable.',
    useWhen:
      'The company registered or deregistered for VAT or as an employer, Skatteverket changed its moms period, the fiscal year or accounting method was changed with the authorities, or an accounting method set wrong at onboarding is corrected.',
    doNotUseFor:
      'Invoice, contact or payment details (PATCH /settings), the bookkeeping lock (PATCH /settings/bookkeeping-lock), entity type or org number (fixed).',
    pitfalls: [
      'Only an owner or admin of the company may change settings: other members get 403 FORBIDDEN.',
      'Saving regenerates the system tax deadlines for this year and next; completed deadlines keep their status.',
      'vat_registered=true needs vat_number (SE + 12 digits) and moms_period, stored or sent.',
      'vat_registered=false also turns off vat_taxable_base_over_40m, vat_has_eu_trade and periodisk_sammanstallning_enabled.',
      'vat_taxable_base_over_40m requires moms_period=monthly; periodisk sammanställning requires VAT registration and EU trade.',
      'An enskild firma must keep fiscal_year_start_month=1 (BFL 3 kap.).',
      'aktiekapital and antal_aktier are set or cleared together.',
      'accounting_method=cash turns defer_invoice_booking off (deferred booking is accrual only).',
      'defer_invoice_booking=true: sent customer invoices and registered supplier invoices get no verifikat until they are booked with POST /invoices/{id}/book (or /invoices/bulk-book) and POST /supplier-invoices/{id}/book.',
      'accounting_method never changes while an open invoice has no verifikat of its own (409 ACCOUNTING_METHOD_CHANGE_OPEN_INVOICES). Otherwise it changes freely only while the current fiscal year has no posted verifikat; later it is a correction of a wrong setting: send accounting_method_correction_reason (else 409 ACCOUNTING_METHOD_CHANGE_MID_YEAR). The method governs the whole year (BFL 5 kap 2 §); a real move to bokslutsmetoden needs Skatteverket first (ML 7 kap 17 §).',
    ],
    example: {
      request: { vat_registered: true, vat_number: 'SE556677889901', moms_period: 'quarterly' },
      response: {
        data: {
          company_id: 'aaaa1111-2222-4333-8444-555566667777',
          vat_registered: true,
          vat_number: 'SE556677889901',
          moms_period: 'quarterly',
          deadlines_regenerated: true,
        },
        meta: { request_id: 'req_...', api_version: '2026-05-12' },
      },
    },
  },
  input: TaxProfileInput,
  output: SettingsResource.extend({
    deadlines_regenerated: z.boolean().describe('Whether this save regenerated the tax deadlines.'),
  }),
  errorCodes: [
    'FORBIDDEN',
    'NOT_FOUND',
    'SETTINGS_EF_CALENDAR_YEAR',
    'SETTINGS_SHARE_CAPITAL_PAIR',
    'SETTINGS_VAT_NUMBER_REQUIRED',
    'SETTINGS_MOMS_PERIOD_REQUIRED',
    'SETTINGS_VAT_40M_REQUIRES_MONTHLY',
    'SETTINGS_PS_REQUIRES_VAT_AND_EU_TRADE',
    'ACCOUNTING_METHOD_CHANGE_MID_YEAR',
    'ACCOUNTING_METHOD_CHANGE_OPEN_INVOICES',
  ],
  http: { method: 'PATCH', path: `${SETTINGS_PATH}/tax-profile` },
  mcp: {
    name: 'gnubok_update_company_tax_profile',
    title: 'Update Company Tax Profile',
    description:
      'Stage a change to the tax profile: VAT registration and moms period, F-skatt, employer registration, fiscal year start, accounting method, share capital. Approval regenerates the tax deadlines. Owner/admin only.',
    keywords: ['momsperiod', 'momsregistrering', 'f-skatt', 'kontantmetoden', 'faktureringsmetoden', 'räkenskapsår', 'arbetsgivarregistrering', 'aktiekapital'],
    stage: { pendingType: 'update_company_tax_profile', title: () => 'Ändra skatte- och momsuppgifter' },
  },
  run: async (ctx, input, { dryRun }) => {
    const outcome = await runSettingsWrite(ctx, input, dryRun)
    if (!outcome.ok || outcome.dryRun) return outcome
    return {
      ok: true,
      data: { ...outcome.data.resource, deadlines_regenerated: outcome.data.deadlines_regenerated },
      ...(outcome.warnings ? { warnings: outcome.warnings } : {}),
    }
  },
})

const BookkeepingLockInput = z
  .object({
    bookkeeping_locked_through: S.bookkeeping_locked_through.describe(
      'Lock every date on or before this one (YYYY-MM-DD). Null removes the lock.',
    ),
    auto_lock_period_days: S.auto_lock_period_days.describe(
      'Lock each calendar month automatically this many days after it ends (the settings page offers 30, 60, 90): every night bookkeeping_locked_through is moved forward to the newest month end that many days back, never back. A number above 36500 is stored and locks nothing. Null turns it off.',
    ),
    acknowledge_filed_vat_periods: z
      .boolean()
      .optional()
      .describe(
        'Required as true when the move reopens a momsdeklaration period already filed: the refusal names those periods.',
      ),
  })
  .strict()
  .superRefine((value, ctx) => {
    const { acknowledge_filed_vat_periods: _acknowledged, ...fields } = value
    if (!atLeastOneField(fields)) ctx.addIssue({ code: 'custom', message: AT_LEAST_ONE })
  })

export const settingsUpdateBookkeepingLock = defineOperation({
  id: 'settings.update-bookkeeping-lock',
  kind: 'write',
  scope: 'companies:write',
  risk: 'high',
  reversible: true,
  docs: {
    summary: 'Set, move or remove the company-wide bookkeeping lock date.',
    description:
      'Sets bookkeeping_locked_through (nothing dated on or before it can be booked, corrected or attached) and auto_lock_period_days. Moving the date back or clearing it reopens those dates, exactly as the settings page allows; the response then carries the warning BOOKKEEPING_LOCK_MOVED_BACKWARDS. A change of the stored date emits the period.lock_date_changed webhook. Owner or admin only. Idempotent (mandatory Idempotency-Key). Dry-runnable.',
    useWhen: 'A period is reconciled and filed and should be protected, or a locked date must be reopened for a correction.',
    doNotUseFor:
      'Locking or closing a single fiscal period (POST /fiscal-periods/{id}/lock, /close), or correcting a posted verifikat (storno or rättelse).',
    pitfalls: [
      'Only an owner or admin of the company may change settings: other members get 403 FORBIDDEN.',
      'Locking more (a first lock date, or a later one) is refused while an SIE import is still holding a fiscal period (finish the import first). Moving the date back or removing it is always allowed: that is how an SIE undo stopped by the lock date continues.',
      'A backwards move is allowed but high risk. When it reopens a filed momsdeklaration period it is refused with 409 BOOKKEEPING_LOCK_REOPENS_FILED_VAT (details.filed_periods) unless acknowledge_filed_vat_periods is true: reopen a filed period only to book a correction and file a corrected declaration for it.',
      'While auto_lock_period_days is set, a lock date moved back is moved forward again the next night (the automatic lock is a floor). Set auto_lock_period_days to null first to keep the dates open longer.',
    ],
    example: {
      request: { bookkeeping_locked_through: '2026-06-30' },
      response: {
        data: {
          company_id: 'aaaa1111-2222-4333-8444-555566667777',
          bookkeeping_locked_through: '2026-06-30',
          auto_lock_period_days: null,
        },
        meta: { request_id: 'req_...', api_version: '2026-05-12' },
      },
    },
  },
  input: BookkeepingLockInput,
  output: SettingsResource,
  errorCodes: ['FORBIDDEN', 'NOT_FOUND', 'BOOKKEEPING_LOCK_REOPENS_FILED_VAT'],
  http: { method: 'PATCH', path: `${SETTINGS_PATH}/bookkeeping-lock` },
  mcp: {
    name: 'gnubok_update_bookkeeping_lock',
    title: 'Update Bookkeeping Lock',
    description:
      'Stage setting, moving or removing the company-wide lock date (bookkeeping_locked_through) and auto-lock days. Reopening a filed VAT period needs acknowledge_filed_vat_periods. For one fiscal period use gnubok_lock_period. Owner/admin only.',
    keywords: ['låsdatum', 'lås bokföringen', 'bokföringslås', 'låst till och med', 'automatisk låsning'],
    stage: {
      pendingType: 'update_bookkeeping_lock',
      title: (input) =>
        input.bookkeeping_locked_through === null
          ? 'Ta bort bokföringslåset'
          : typeof input.bookkeeping_locked_through === 'string'
            ? `Lås bokföringen till och med ${input.bookkeeping_locked_through}`
            : 'Ändra automatisk låsning',
    },
  },
  run: async (ctx, { acknowledge_filed_vat_periods: acknowledged, ...input }, { dryRun }) => {
    // The service works out the filed periods a move reopens; this door
    // refuses them until the caller acknowledges them.
    const outcome = await runSettingsWrite(ctx, input, dryRun, { refuseReopeningFiledVat: acknowledged !== true })
    if (!outcome.ok) return outcome
    if (outcome.dryRun) {
      const reopened = (outcome.preview.warnings as OperationWarning[] | undefined)?.find(
        (warning) => warning.code === 'BOOKKEEPING_LOCK_REOPENED_FILED_VAT',
      )
      return reopened
        ? { ...outcome, preview: { ...outcome.preview, reopened_filed_vat_periods: reopened.message_en } }
        : outcome
    }
    return { ok: true, data: outcome.data.resource, ...(outcome.warnings ? { warnings: outcome.warnings } : {}) }
  },
})
