import { z } from 'zod'
import { normalizeOrgNumber } from '@/lib/invariants/org-number'
import { isSaneDateString } from '@/lib/invariants/iso-date'
import { expandPersonnummerTo12, validatePersonnummer } from '@/lib/salary/personnummer-format'

/**
 * The activation form for collections (settings page, build spec 3.2), shared
 * by the browser and the routes: the request schemas, the validation rules
 * behind them, and the payout choices derived from the company's bank
 * accounts. No server imports: the stepper validates each step with the
 * same rules the route enforces.
 *
 * Validation answers an error KEY per field (settings_collections.error_*),
 * never a sentence, so the browser words it in the viewer's language and
 * the route's zod issues carry the same key as their message.
 */

export const PAYOUT_KINDS = ['bankgiro', 'plusgiro', 'bank_account'] as const
export type PayoutKind = (typeof PAYOUT_KINDS)[number]

export const LADDER_MODES = ['off', 'staged'] as const
export const START_STEPS = ['reminder', 'collection'] as const

export type ActivationErrorKey =
  | 'required'
  | 'invalid_email'
  | 'invalid_postal_code'
  | 'invalid_personal_number'
  | 'invalid_vat_number'
  | 'invalid_amount'
  | 'invalid_percent'
  | 'invalid_date'
  | 'date_in_future'
  | 'too_long'

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
/** Swedish postal code: five digits, optionally "123 45". */
const POSTAL_CODE_RE = /^\d{3} ?\d{2}$/
/** SE + ten-digit org number + "01". */
const VAT_NUMBER_RE = /^SE\d{12}$/
const TWO_DECIMALS_RE = /^\d+(\.\d{1,2})?$/

export function isEmail(value: string): boolean {
  return value.length <= 254 && EMAIL_RE.test(value)
}

export function isSwedishPostalCode(value: string): boolean {
  return POSTAL_CODE_RE.test(value.trim())
}

export function normalizeVatNumber(value: string): string {
  return value.replace(/[\s-]/g, '').toUpperCase()
}

export function isSwedishVatNumber(value: string): boolean {
  return VAT_NUMBER_RE.test(normalizeVatNumber(value))
}

/** A date someone states as already in force: a real date, not after today. */
export function pastDateError(value: string, today: string): ActivationErrorKey | null {
  if (!isSaneDateString(value)) return 'invalid_date'
  return value > today ? 'date_in_future' : null
}

/** Twelve digits with the century, Luhn-checked, samordningsnummer allowed; null when it is not one. */
export function normalizeOwnerPersonalNumber(value: string, now: Date = new Date()): string | null {
  const twelve = expandPersonnummerTo12(value, now)
  if (!twelve) return null
  return validatePersonnummer(twelve).valid ? twelve : null
}

/**
 * The owner's personnummer prefilled for an enskild firma, whose org number
 * IS that personnummer (ten digits). The century is the most recent one
 * that does not put the birth date in the future; an owner aged 100 or more
 * edits it.
 */
export function ownerPersonalNumberFromOrgNumber(orgNumber: string | null, now: Date = new Date()): string | null {
  const ten = normalizeOrgNumber(orgNumber)
  return ten ? normalizeOwnerPersonalNumber(ten, now) : null
}

/** An amount typed as kronor, at most two decimals. */
export function isAmount(value: number, max = 1_000_000_000): boolean {
  return Number.isFinite(value) && value >= 0 && value <= max && TWO_DECIMALS_RE.test(String(value))
}

// ---------------------------------------------------------------------------
// Payout choices
// ---------------------------------------------------------------------------

/** The bank-account fields a payout can be made to (cash_accounts). */
export interface PayoutSourceAccount {
  id: string
  name: string | null
  ledger_account: string
  enabled: boolean
  bankgiro: string | null
  plusgiro: string | null
  clearing_number: string | null
  account_number: string | null
}

export interface PayoutOption {
  cashAccountId: string
  kind: PayoutKind
  /** What is sent: digits, with one hyphen between clearing and account number. */
  number: string
  /** The BAS account the payout lands on: collection_connections.payout_account. */
  ledgerAccount: string
  accountName: string | null
}

const digits = (value: string | null): string => (value ?? '').replace(/\D/g, '')

/** Bank accounts only (BAS 1920-1999): a payout never lands in a till or a PSP clearing account. */
function isBankLedgerAccount(account: string): boolean {
  return /^19[2-9]\d$/.test(account)
}

/**
 * Every number a payout could be made to, per enabled bank account, in the
 * order bankgiro, plusgiro, bank account. A number shorter than five digits
 * cannot be sent and is left out.
 */
export function payoutOptions(accounts: readonly PayoutSourceAccount[]): PayoutOption[] {
  const options: PayoutOption[] = []
  for (const a of accounts) {
    if (!a.enabled || !isBankLedgerAccount(a.ledger_account)) continue
    const base = { cashAccountId: a.id, ledgerAccount: a.ledger_account, accountName: a.name }
    const bankgiro = digits(a.bankgiro)
    if (bankgiro.length >= 7 && bankgiro.length <= 8) options.push({ ...base, kind: 'bankgiro', number: bankgiro })
    const plusgiro = digits(a.plusgiro)
    if (plusgiro.length >= 5 && plusgiro.length <= 8) options.push({ ...base, kind: 'plusgiro', number: plusgiro })
    const clearing = digits(a.clearing_number)
    const account = digits(a.account_number)
    if (clearing.length >= 4 && clearing.length <= 5 && account.length >= 1 && clearing.length + account.length <= 33) {
      options.push({ ...base, kind: 'bank_account', number: `${clearing}-${account}` })
    }
  }
  return options
}

export function findPayoutOption(
  options: readonly PayoutOption[],
  choice: { cashAccountId: string; kind: PayoutKind },
): PayoutOption | null {
  return options.find((o) => o.cashAccountId === choice.cashAccountId && o.kind === choice.kind) ?? null
}

// ---------------------------------------------------------------------------
// Step validation (browser and route)
// ---------------------------------------------------------------------------

export interface CompanyStepInput {
  name: string
  addressLine1: string
  addressLine2: string | null
  postalCode: string
  city: string
  email: string
  phone: string | null
  vatRegistered: boolean
  vatNumber: string | null
  /** Required for an enskild firma, ignored otherwise. */
  ownerPersonalNumber: string | null
  payout: { cashAccountId: string; kind: PayoutKind } | null
}

export interface KycStepInput {
  businessDescription: string
  invoicesAbroad: boolean
  invoicesAbroadDescription: string | null
  pep: boolean
  pepDescription: string | null
  sanctions: boolean
  sanctionsDescription: string | null
}

export interface RulesStepInput {
  minimumAmount: number
  defaultStartStep: (typeof START_STEPS)[number]
  reminderFeeTermsSince: string | null
  lateInterest: { percent: number; agreedSince: string } | null
  ladderMode: (typeof LADDER_MODES)[number] | null
}

export type FieldErrors<T> = Partial<Record<keyof T | string, ActivationErrorKey>>

const blank = (value: string | null | undefined): boolean => !value || value.trim().length === 0

export function validateCompanyStep(input: CompanyStepInput, ctx: { soleTrader: boolean; now?: Date }): FieldErrors<CompanyStepInput> {
  const errors: FieldErrors<CompanyStepInput> = {}
  if (blank(input.name)) errors.name = 'required'
  else if (input.name.trim().length > 100) errors.name = 'too_long'
  if (blank(input.addressLine1)) errors.addressLine1 = 'required'
  else if (input.addressLine1.trim().length > 100) errors.addressLine1 = 'too_long'
  if ((input.addressLine2 ?? '').length > 100) errors.addressLine2 = 'too_long'
  if (blank(input.postalCode)) errors.postalCode = 'required'
  else if (!isSwedishPostalCode(input.postalCode)) errors.postalCode = 'invalid_postal_code'
  if (blank(input.city)) errors.city = 'required'
  else if (input.city.trim().length > 60) errors.city = 'too_long'
  if (blank(input.email)) errors.email = 'required'
  else if (!isEmail(input.email.trim())) errors.email = 'invalid_email'
  if ((input.phone ?? '').trim().length > 30) errors.phone = 'too_long'
  if (input.vatRegistered) {
    if (blank(input.vatNumber)) errors.vatNumber = 'required'
    else if (!isSwedishVatNumber(input.vatNumber!)) errors.vatNumber = 'invalid_vat_number'
  }
  if (ctx.soleTrader) {
    if (blank(input.ownerPersonalNumber)) errors.ownerPersonalNumber = 'required'
    else if (!normalizeOwnerPersonalNumber(input.ownerPersonalNumber!, ctx.now)) errors.ownerPersonalNumber = 'invalid_personal_number'
  }
  if (!input.payout) errors.payout = 'required'
  return errors
}

export function validateKycStep(input: KycStepInput): FieldErrors<KycStepInput> {
  const errors: FieldErrors<KycStepInput> = {}
  const text = input.businessDescription.trim()
  if (text.length < 2) errors.businessDescription = 'required'
  else if (text.length > 500) errors.businessDescription = 'too_long'
  const pairs = [
    ['invoicesAbroad', 'invoicesAbroadDescription'],
    ['pep', 'pepDescription'],
    ['sanctions', 'sanctionsDescription'],
  ] as const
  for (const [flag, description] of pairs) {
    const value = input[description] ?? ''
    if (input[flag] && blank(value)) errors[description] = 'required'
    else if (value.length > 500) errors[description] = 'too_long'
  }
  return errors
}

export function validateRulesStep(input: RulesStepInput, ctx: { today: string; requireLadderChoice: boolean }): FieldErrors<RulesStepInput> {
  const errors: FieldErrors<RulesStepInput> = {}
  if (!isAmount(input.minimumAmount)) errors.minimumAmount = 'invalid_amount'
  if (input.reminderFeeTermsSince !== null) {
    const e = pastDateError(input.reminderFeeTermsSince, ctx.today)
    if (e) errors.reminderFeeTermsSince = e
  }
  if (input.lateInterest) {
    const { percent, agreedSince } = input.lateInterest
    if (!(Number.isFinite(percent) && percent > 0 && percent <= 100 && TWO_DECIMALS_RE.test(String(percent)))) {
      errors.lateInterestPercent = 'invalid_percent'
    }
    const e = pastDateError(agreedSince, ctx.today)
    if (e) errors.lateInterestAgreedSince = e
  }
  if (ctx.requireLadderChoice && input.ladderMode === null) errors.ladderMode = 'required'
  return errors
}

// ---------------------------------------------------------------------------
// Request schemas (routes)
// ---------------------------------------------------------------------------

/** Adds each field error as a zod issue whose message is the error key. */
function addErrors(ctx: z.RefinementCtx, errors: Record<string, ActivationErrorKey | undefined>, prefix: string[]): void {
  for (const [field, key] of Object.entries(errors)) {
    if (key) ctx.addIssue({ code: 'custom', message: key, path: [...prefix, field] })
  }
}

const nullableText = (max: number) =>
  z
    .string()
    .max(max)
    .nullable()
    .transform((v) => (v === null || v.trim() === '' ? null : v.trim()))

export const ConsentBodySchema = z.object({
  /** The terms version the admin read (the catalogue's). */
  termsVersion: z.string().trim().min(1).max(64),
  dpaVersion: z.string().trim().min(1).max(64).nullable(),
  acceptTerms: z.literal(true),
  acceptDataSharing: z.literal(true),
})
export type ConsentBody = z.infer<typeof ConsentBodySchema>

export const CompanyStepSchema = z.object({
  name: z.string().max(200),
  addressLine1: z.string().max(200),
  addressLine2: z.string().max(200).nullable(),
  postalCode: z.string().max(20),
  city: z.string().max(100),
  email: z.string().max(254),
  phone: z.string().max(60).nullable(),
  vatRegistered: z.boolean(),
  vatNumber: z.string().max(40).nullable(),
  ownerPersonalNumber: z.string().max(20).nullable(),
  payout: z.object({ cashAccountId: z.string().uuid(), kind: z.enum(PAYOUT_KINDS) }).nullable(),
})

export const KycStepSchema = z
  .object({
    businessDescription: z.string().max(1000),
    invoicesAbroad: z.boolean(),
    invoicesAbroadDescription: nullableText(1000),
    pep: z.boolean(),
    pepDescription: nullableText(1000),
    sanctions: z.boolean(),
    sanctionsDescription: nullableText(1000),
  })
  .superRefine((kyc, ctx) => addErrors(ctx, validateKycStep(kyc), []))

const LateInterestSchema = z.object({ percent: z.number(), agreedSince: z.string().max(10) })

export const RulesStepSchema = z.object({
  minimumAmount: z.number(),
  defaultStartStep: z.enum(START_STEPS),
  reminderFeeTermsSince: z.string().max(10).nullable(),
  lateInterest: LateInterestSchema.nullable(),
  ladderMode: z.enum(LADDER_MODES).nullable(),
})

export const OnboardingBodySchema = z.object({
  company: CompanyStepSchema,
  kyc: KycStepSchema,
  rules: RulesStepSchema,
})
export type OnboardingBody = z.infer<typeof OnboardingBodySchema>

export const TermsBodySchema = z.object({
  termsVersion: z.string().trim().min(1).max(64),
  accept: z.literal(true),
})
export type TermsBody = z.infer<typeof TermsBodySchema>

export const SignatureBodySchema = z
  .object({
    /** true: the provider mails the signing link to signerEmail; false: the admin signs now in a new tab. */
    sendToSigner: z.boolean(),
    signerEmail: z.string().trim().max(254).nullable(),
    /** The signing page's language: the viewer's. */
    language: z.enum(['sv', 'en']).default('sv'),
  })
  .superRefine((body, ctx) => {
    if (body.sendToSigner && (!body.signerEmail || !isEmail(body.signerEmail))) {
      ctx.addIssue({ code: 'custom', message: body.signerEmail ? 'invalid_email' : 'required', path: ['signerEmail'] })
    }
  })
export type SignatureBody = z.infer<typeof SignatureBodySchema>

/** PATCH /api/settings/collections: the rules a live connection may change. Every key optional, at least one. */
export const SettingsPatchSchema = z
  .object({
    minimumAmount: z.number().optional(),
    defaultStartStep: z.enum(START_STEPS).optional(),
    reminderFeeTermsSince: z.string().max(10).nullable().optional(),
    lateInterest: LateInterestSchema.nullable().optional(),
    distributionEnabled: z.boolean().optional(),
  })
  .refine((patch) => Object.values(patch).some((v) => v !== undefined), { message: 'required' })
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>
