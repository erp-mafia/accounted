import { z } from 'zod'
import {
  ACCOUNT_VAT_TREATMENTS,
  isVatTreatmentAllowedForAccountClass,
} from '@/lib/vat/account-vat-treatment'

// Commit-boundary re-validation for staged chart-of-accounts operations
// (gnubok_create_account / gnubok_update_account). A staged
// pending_operations row is re-parsed here before it touches
// chart_of_accounts so a tampered row cannot inject unexpected fields
// (defense in depth, ASVS V4.5): mirrors lib/pending-operations/schemas/article.ts.
//
// account_type includes 'untaxed_reserves' beyond the web UI's five values:
// BAS 2026 carries it for the 21xx group and the batch-activate route already
// inserts it, so a BAS-prefilled staged create must round-trip it too.

const accountNumber = z
  .string()
  .regex(/^\d{4}$/, 'Account number must be exactly 4 digits')

const accountType = z.enum([
  'asset', 'equity', 'liability', 'revenue', 'expense', 'untaxed_reserves',
])

const normalBalance = z.enum(['debit', 'credit'])

// Same shape as defaultVatRate in lib/api/schemas.ts (the dashboard route):
// fraction-of-one, not percent, so the two write paths cannot drift.
const defaultVatRate = z
  .union([z.literal(0), z.literal(0.06), z.literal(0.12), z.literal(0.25)])
  .nullable()
  .optional()

const defaultVatTreatment = z.enum(ACCOUNT_VAT_TREATMENTS).nullable().optional()

/** Empty string / null → undefined, then bounded string. */
const optString = (max: number) =>
  z.preprocess((v) => (v == null || v === '' ? undefined : v), z.string().max(max).optional())

/**
 * Update-side variant: empty string → null so an agent can CLEAR a stored
 * value ('' and null both mean "remove"); undefined still means "unchanged".
 * The executor copies null through to the UPDATE payload.
 */
const clearableString = (max: number) =>
  z.preprocess((v) => (v === '' ? null : v), z.string().max(max).nullable().optional())

const trimmedName = z.preprocess(
  (v) => (typeof v === 'string' ? v.trim() : v),
  z.string().min(1, 'Account name is required').max(200),
)

/**
 * BAS class (first digit) → account types that may live there, matching the
 * BAS 2026 catalog in lib/bookkeeping/bas-data. Class 8 legitimately holds
 * both financial revenue (80xx-83xx) and financial expense (84xx-89xx).
 * Classes 0 and 9 are free-use per the BAS standard and stay unconstrained.
 * Without this guard a custom account like 2999+expense would be inserted
 * with account_class 2, an internally contradictory row that misclassifies
 * balance sheet vs income statement in every report.
 */
const BAS_CLASS_ACCOUNT_TYPES: Record<string, readonly string[]> = {
  '1': ['asset'],
  '2': ['equity', 'liability', 'untaxed_reserves'],
  '3': ['revenue'],
  '4': ['expense'],
  '5': ['expense'],
  '6': ['expense'],
  '7': ['expense'],
  '8': ['revenue', 'expense'],
}

/** Returns an error message when account_type is illegal for the account's BAS class, else null. */
export function accountClassTypeConflict(
  accountNumber: string,
  accountType: string,
): string | null {
  const allowed = BAS_CLASS_ACCOUNT_TYPES[accountNumber[0]]
  if (!allowed || allowed.includes(accountType)) return null
  return `Account ${accountNumber} is in BAS class ${accountNumber[0]}, which cannot hold account_type '${accountType}' (allowed: ${allowed.join(', ')}).`
}

export const CreateAccountParamsSchema = z
  .object({
    account_number: accountNumber,
    account_name: trimmedName,
    account_type: accountType,
    normal_balance: normalBalance,
    plan_type: z.enum(['k1', 'full_bas']).default('k1'),
    description: optString(2000),
    default_vat_code: optString(32),
    default_vat_rate: defaultVatRate,
    default_vat_treatment: defaultVatTreatment,
    sru_code: optString(16),
  })
  .superRefine((v, ctx) => {
    const conflict = accountClassTypeConflict(v.account_number, v.account_type)
    if (conflict) {
      ctx.addIssue({ code: 'custom', message: conflict, path: ['account_type'] })
    }
    if (
      v.default_vat_treatment &&
      !isVatTreatmentAllowedForAccountClass(
        v.default_vat_treatment,
        Number(v.account_number[0]),
      )
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'VAT treatment is not valid for this account class',
        path: ['default_vat_treatment'],
      })
    }
  })

export const UpdateAccountParamsSchema = z.object({
  account_number: accountNumber,
  account_name: trimmedName.optional(),
  description: clearableString(2000),
  default_vat_code: clearableString(32),
  default_vat_rate: defaultVatRate,
  default_vat_treatment: defaultVatTreatment,
  sru_code: clearableString(16),
  is_active: z.boolean().optional(),
}).superRefine((v, ctx) => {
  if (
    v.default_vat_treatment &&
    !isVatTreatmentAllowedForAccountClass(
      v.default_vat_treatment,
      Number(v.account_number[0]),
    )
  ) {
    ctx.addIssue({
      code: 'custom',
      message: 'VAT treatment is not valid for this account class',
      path: ['default_vat_treatment'],
    })
  }
})

export type CreateAccountParams = z.infer<typeof CreateAccountParamsSchema>
export type UpdateAccountParams = z.infer<typeof UpdateAccountParamsSchema>
