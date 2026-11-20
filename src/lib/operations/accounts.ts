/**
 * Chart of accounts (kontoplan) write operations. The list stays a
 * hand-written v1 route (GET /accounts) and the MCP gnubok_list_accounts
 * tool. Rules live in lib/bookkeeping/chart-of-accounts-service.ts, shared
 * with the dashboard routes under /api/bookkeeping/accounts.
 *
 * accounts.create and accounts.update keep the MCP names, the pending types
 * (create_account, update_account) and the argument names of the tools they
 * replaced, so rows staged before the move still commit and existing agents'
 * calls still validate. The input schemas are kept terse on purpose: both
 * tools are in the default tools/list catalogue, whose size is budgeted
 * (payload-size.bench.test.ts).
 */
import { z } from 'zod'
import { getBASReference } from '@/lib/bookkeeping/bas-reference'
import {
  ACCOUNT_TYPES,
  activateAccounts,
  createAccount,
  deactivateAccounts,
  deleteAccount,
  updateAccount,
} from '@/lib/bookkeeping/chart-of-accounts-service'
import { ACCOUNT_VAT_TREATMENTS } from '@/lib/vat/account-vat-treatment'
import { ACCOUNT_VAT_BOXES } from '@/lib/vat/account-vat-box'
import { defineOperation } from './types'

const Account = z.object({
  id: z.string().uuid(),
  account_number: z.string(),
  account_name: z.string(),
  account_class: z.number().int().min(0).max(9),
  account_group: z.string(),
  account_type: z.enum(ACCOUNT_TYPES),
  normal_balance: z.enum(['debit', 'credit']),
  plan_type: z.string().nullable(),
  is_active: z.boolean(),
  is_system_account: z.boolean(),
  description: z.string().nullable(),
  default_vat_code: z.string().nullable(),
  default_vat_rate: z.number().nullable(),
  default_vat_treatment: z.enum(ACCOUNT_VAT_TREATMENTS).nullable(),
  vat_box: z.enum(ACCOUNT_VAT_BOXES).nullable(),
  sru_code: z.string().nullable(),
  sort_order: z.number().int().nullable(),
})

/*
 * Terse on purpose (tools/list budget): lengths, digit formats and every
 * business rule are checked in the service, where all doors share them. A
 * multi-value literal serializes as a compact `enum`, not an anyOf; text
 * fields take '' to clear rather than null for the same reason.
 */
const VAT_RATE = z.literal([0, 0.06, 0.12, 0.25, null]).optional()
const VAT_TREATMENT = z.literal([...ACCOUNT_VAT_TREATMENTS, null]).optional()
const VAT_BOX = z.literal([...ACCOUNT_VAT_BOXES, null]).optional()
const TEXT = z.string().optional()
const NUMBERS = z.array(z.string().min(1).max(10)).min(1).max(2000)

const ACCOUNT_EXAMPLE = {
  id: '8d0e…',
  account_number: '5410',
  account_name: 'Förbrukningsinventarier',
  account_class: 5,
  account_group: '54',
  account_type: 'expense',
  normal_balance: 'debit',
  plan_type: 'full_bas',
  is_active: true,
  is_system_account: false,
  description: null,
  default_vat_code: null,
  default_vat_rate: null,
  default_vat_treatment: null,
  vat_box: null,
  sru_code: '7321',
  sort_order: 5410,
}
const META = { request_id: 'req_…', api_version: '2026-05-12' }

export const accountsCreate = defineOperation({
  id: 'accounts.create',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'low',
  reversible: true,
  docs: {
    summary: 'Add an account to the chart of accounts (kontoplan).',
    description:
      'Adds an account to the company\'s kontoplan. A BAS 2026 number needs nothing but the number: name, account_type, normal_balance, description and SRU code are prefilled from the catalogue, and anything you send wins. A number outside BAS 2026 must name account_name, account_type and normal_balance. account_class and account_group derive from the number. A default_vat_treatment without a default_vat_rate derives the booking rate. Idempotent. Dry-runnable.',
    useWhen:
      'A verifikat needs an account the chart does not carry: a company-specific sub-account, or a BAS account the company has not used yet.',
    doNotUseFor:
      'Reactivating a deactivated account (PATCH is_active=true, or POST /accounts/activate) or bulk-adding standard BAS accounts (POST /accounts/activate).',
    pitfalls: [
      'account_number is a STRING of exactly 4 digits: "5410", not 5410.',
      'The account_type must fit the class, the first digit: 1 asset; 2 equity, liability or untaxed_reserves (21xx only); 3 revenue; 4-7 expense; 8 revenue or expense. A mismatch returns 400 ACCOUNT_TYPE_CLASS_CONFLICT.',
      'A number already in the chart returns 409 ACCOUNT_EXISTS, or ACCOUNT_EXISTS_INACTIVE when it was deactivated: reactivate it instead.',
      'default_vat_rate is a fraction (0, 0.06, 0.12, 0.25), not a percentage.',
      'vat_box (momsruta override) only fits 26xx VAT accounts other than 2650.',
    ],
    example: {
      request: { account_number: '5410' },
      response: { data: ACCOUNT_EXAMPLE, meta: META },
    },
  },
  input: z.object({
    account_number: z.string().describe('4-digit number, e.g. "5410".'),
    account_name: TEXT,
    account_type: z.enum(ACCOUNT_TYPES).optional().describe('untaxed_reserves only for 21xx.'),
    normal_balance: z.enum(['debit', 'credit']).optional(),
    description: TEXT,
    default_vat_code: TEXT,
    default_vat_rate: VAT_RATE.describe(
      'Fraction (0.25 = 25%). Livsmedel 0.06 from 2026-04-01 through 2027-12-31, then 0.12.',
    ),
    default_vat_treatment: VAT_TREATMENT,
    vat_box: VAT_BOX,
    sru_code: TEXT,
  }),
  output: Account,
  errorCodes: [
    'ACCOUNT_EXISTS',
    'ACCOUNT_EXISTS_INACTIVE',
    'ACCOUNT_DETAILS_REQUIRED',
    'ACCOUNT_TYPE_CLASS_CONFLICT',
    'ACCOUNT_VAT_TREATMENT_CLASS',
    'ACCOUNT_VAT_BOX_NOT_VAT_ACCOUNT',
  ],
  http: { method: 'POST', path: '/api/v1/companies/:companyId/accounts' },
  mcp: {
    name: 'gnubok_create_account',
    title: 'Create Account (Kontoplan)',
    description:
      'Stage a new kontoplan account. BAS 2026 numbers prefill name/type/SRU (overrides win); custom numbers need account_name, account_type, normal_balance. Inactive account? Use gnubok_update_account.',
    visibility: 'default',
    keywords: ['kontoplan', 'nytt konto', 'baskonto'],
    stage: {
      pendingType: 'create_account',
      title: (input) => {
        const number = String(input.account_number)
        const name = String(input.account_name ?? '').trim() || getBASReference(number)?.account_name || ''
        return `Nytt konto: ${number} ${name}`.trim()
      },
    },
  },
  run: (ctx, input, { dryRun }) => createAccount(ctx, input, { dryRun }),
})

export const accountsUpdate = defineOperation({
  id: 'accounts.update',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'low',
  reversible: true,
  docs: {
    summary: 'Edit or deactivate an account in the chart of accounts.',
    description:
      'Sparse update of one kontoplan account: name, description, VAT defaults (code, booking rate, treatment), momsruta override (vat_box), SRU code and is_active (false deactivates it: history and balances stay, new verifikat cannot use it). An empty string or null clears a text field. The number, class, type and normal balance are fixed: an account that should be something else is a new account. A treatment without a rate derives the booking rate only when none is stored. Idempotent. Dry-runnable.',
    useWhen: 'An account needs a clearer name, other VAT defaults or SRU mapping, or should stop (or start again) being offered for bookings.',
    doNotUseFor: 'Removing an unused account (DELETE) or deactivating many at once (POST /accounts/deactivate).',
    pitfalls: [
      'The path takes the account number as a STRING, e.g. /accounts/5410.',
      'At least one field must be sent: an empty body returns 400 ACCOUNT_NOTHING_TO_UPDATE.',
      'default_vat_treatment must fit the class (400 ACCOUNT_VAT_TREATMENT_CLASS); null restores the BAS mapping.',
      'vat_box only fits 26xx VAT accounts other than 2650; null restores the BAS momsruta.',
    ],
    example: {
      request: { account_name: 'Verktyg och inventarier' },
      response: { data: { ...ACCOUNT_EXAMPLE, account_name: 'Verktyg och inventarier' }, meta: META },
    },
  },
  input: z.object({
    account_number: z.string(),
    account_name: TEXT,
    description: TEXT,
    default_vat_code: TEXT,
    default_vat_rate: VAT_RATE,
    default_vat_treatment: VAT_TREATMENT,
    vat_box: VAT_BOX,
    sru_code: TEXT,
    is_active: z.boolean().optional(),
  }),
  output: Account,
  errorCodes: [
    'ACCOUNT_NOT_FOUND',
    'ACCOUNT_NOTHING_TO_UPDATE',
    'ACCOUNT_VAT_TREATMENT_CLASS',
    'ACCOUNT_VAT_BOX_NOT_VAT_ACCOUNT',
  ],
  http: {
    method: 'PATCH',
    path: '/api/v1/companies/:companyId/accounts/:number',
    pathParams: { number: 'account_number' },
  },
  mcp: {
    name: 'gnubok_update_account',
    title: 'Update Account (Kontoplan)',
    description:
      'Stage an edit to a kontoplan account (name, description, VAT, vat_box, SRU, is_active).',
    visibility: 'default',
    keywords: ['kontoplan', 'ändra konto', 'baskonto'],
    stage: { pendingType: 'update_account', title: (input) => `Uppdatera konto ${String(input.account_number)}` },
  },
  run: (ctx, { account_number, ...changes }, { dryRun }) => updateAccount(ctx, account_number, changes, { dryRun }),
})

export const accountsDelete = defineOperation({
  id: 'accounts.delete',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'medium',
  reversible: false,
  docs: {
    summary: 'Delete an account nothing has been booked on.',
    description:
      'Removes an account from the kontoplan. Refused for system accounts and for any account with journal lines in this company, on any entry status including drafts (BFL: a verifikat is immutable and its lines must keep resolving to an account). Deactivate those with PATCH is_active=false instead. Idempotent. Dry-runnable.',
    useWhen: 'An account was added by mistake, or an imported chart carries accounts the company never used.',
    doNotUseFor: 'Retiring an account that has been used: deactivate it (PATCH is_active=false).',
    pitfalls: [
      'An account with any journal line returns 409 ACCOUNT_IN_USE with details.usage_count.',
      'System accounts (seeded at company creation) return 400 ACCOUNT_SYSTEM_DELETE.',
      'A standard BAS account can be re-added later with POST /accounts or POST /accounts/activate.',
    ],
    example: {
      response: { data: { deleted: true, account_number: '5410' }, meta: META },
    },
  },
  input: z.object({ account_number: z.string() }),
  output: z.object({ deleted: z.literal(true), account_number: z.string() }),
  errorCodes: ['ACCOUNT_NOT_FOUND', 'ACCOUNT_SYSTEM_DELETE', 'ACCOUNT_IN_USE'],
  http: {
    method: 'DELETE',
    path: '/api/v1/companies/:companyId/accounts/:number',
    pathParams: { number: 'account_number' },
  },
  mcp: {
    name: 'gnubok_delete_account',
    title: 'Delete Account (Kontoplan)',
    description:
      'Stage deleting a kontoplan account nothing is booked on. Refused for system accounts and any account with journal lines: deactivate it with gnubok_update_account (is_active=false) instead.',
    keywords: ['ta bort konto', 'radera konto', 'kontoplan'],
    stage: { pendingType: 'delete_account', title: (input) => `Ta bort konto ${String(input.account_number)}` },
  },
  run: (ctx, { account_number }, { dryRun }) => deleteAccount(ctx, account_number, { dryRun }),
})

export const accountsActivate = defineOperation({
  id: 'accounts.activate',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'low',
  reversible: true,
  docs: {
    summary: 'Activate BAS accounts in bulk.',
    description:
      'Makes each listed account bookable: a standard BAS 2026 number missing from the chart is added from the catalogue, a deactivated account is reactivated, an active one is skipped. Numbers that are neither in the chart nor in BAS 2026 are reported in `unknown`, not refused: add those one at a time with POST /accounts. Idempotent. Dry-runnable.',
    useWhen: 'A booking failed with ACCOUNTS_NOT_IN_CHART, or you want a set of standard BAS accounts available before importing or booking.',
    doNotUseFor: 'A company-specific account outside BAS 2026 (POST /accounts with name, type and normal balance).',
    pitfalls: [
      'account_numbers are STRINGS: ["5410", "6570"].',
      'Up to 2000 numbers per call; duplicates are counted once.',
      'Check `unknown` in the answer: those numbers were not added.',
    ],
    example: {
      request: { account_numbers: ['5410', '6570'] },
      response: {
        data: { accounts: [{ account_number: '5410' }], activated: 1, reactivated: 0, skipped: 1, unknown: [] },
        meta: META,
      },
    },
  },
  input: z.object({ account_numbers: NUMBERS }),
  output: z.object({
    accounts: z.array(z.object({ account_number: z.string() })),
    activated: z.number().int(),
    reactivated: z.number().int(),
    skipped: z.number().int(),
    unknown: z.array(z.string()),
  }),
  http: { method: 'POST', path: '/api/v1/companies/:companyId/accounts/activate' },
  mcp: {
    name: 'gnubok_activate_accounts',
    title: 'Activate Accounts (Kontoplan)',
    description:
      'Stage activating kontoplan accounts in bulk: BAS 2026 numbers missing from the chart are added from the catalogue, deactivated ones reactivated. Numbers outside BAS come back in unknown.',
    keywords: ['aktivera konton', 'lägg till baskonton', 'kontoplan'],
    stage: {
      pendingType: 'activate_accounts',
      title: (input) => `Aktivera konton: ${(input.account_numbers as string[]).join(', ')}`.slice(0, 200),
    },
  },
  run: (ctx, { account_numbers }, { dryRun }) => activateAccounts(ctx, account_numbers, { dryRun }),
})

export const accountsDeactivate = defineOperation({
  id: 'accounts.deactivate',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'low',
  reversible: true,
  docs: {
    summary: 'Deactivate accounts in bulk.',
    description:
      'Deactivates each listed account so it stops being offered for new bookings; history and balances stay. System accounts are always skipped, and accounts with journal lines are skipped unless include_used=true (deactivating a used account hides its balance from the kontoplan). Already inactive numbers are counted, numbers not in the chart reported in `unknown`. Idempotent. Dry-runnable.',
    useWhen: 'Tidying a chart imported from a previous system, where hundreds of accounts were never posted to.',
    doNotUseFor: 'Removing accounts for good (DELETE /accounts/{number}, unused accounts only).',
    pitfalls: [
      'account_numbers are STRINGS.',
      'include_used defaults to false: used accounts come back in skipped_used.',
      'Reactivate with POST /accounts/activate or PATCH is_active=true.',
    ],
    example: {
      request: { account_numbers: ['6991', '7699'] },
      response: {
        data: {
          accounts: [{ account_number: '6991' }],
          deactivated: 1,
          skipped_system: [],
          skipped_used: ['7699'],
          skipped_inactive: 0,
          unknown: [],
        },
        meta: META,
      },
    },
  },
  input: z.object({
    account_numbers: NUMBERS,
    include_used: z.boolean().optional().describe('Also deactivate accounts with journal lines. Default false.'),
  }),
  output: z.object({
    accounts: z.array(z.object({ account_number: z.string() })),
    deactivated: z.number().int(),
    skipped_system: z.array(z.string()),
    skipped_used: z.array(z.string()),
    skipped_inactive: z.number().int(),
    unknown: z.array(z.string()),
  }),
  http: { method: 'POST', path: '/api/v1/companies/:companyId/accounts/deactivate' },
  mcp: {
    name: 'gnubok_deactivate_accounts',
    title: 'Deactivate Accounts (Kontoplan)',
    description:
      'Stage deactivating kontoplan accounts in bulk. System accounts are skipped, and used accounts unless include_used=true. History and balances stay.',
    keywords: ['inaktivera konton', 'rensa kontoplan', 'kontoplan'],
    stage: {
      pendingType: 'deactivate_accounts',
      title: (input) => `Inaktivera konton: ${(input.account_numbers as string[]).join(', ')}`.slice(0, 200),
    },
  },
  run: (ctx, { account_numbers, include_used }, { dryRun }) =>
    deactivateAccounts(ctx, account_numbers, include_used ?? false, { dryRun }),
})
