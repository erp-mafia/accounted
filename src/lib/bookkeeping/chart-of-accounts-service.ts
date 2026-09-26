/**
 * Chart of accounts (kontoplan) writes: create, edit, delete, and the bulk
 * activate/deactivate verbs. One implementation behind the dashboard routes
 * (/api/bookkeeping/accounts/**), the v1 operations (lib/operations/accounts.ts)
 * and the MCP tools generated from them, so every door applies the same rules:
 *
 *   - account_class and account_group derive from the number, and the
 *     account_type must fit the class (accountClassTypeConflict), otherwise
 *     the account lands on the wrong side of every report;
 *   - a BAS 2026 number prefills name, type, normal balance, description and
 *     SRU code (resolve-don't-guess); explicit values win, and a number
 *     outside the catalogue must name all three core fields;
 *   - a VAT treatment must fit the class, and an omitted booking rate is
 *     derived from it; a momsruta override (vat_box) only sits on a 26xx VAT
 *     account other than 2650;
 *   - a number already in the chart is never created twice: a deactivated
 *     one answers ACCOUNT_EXISTS_INACTIVE, so the caller reactivates instead;
 *   - an account with journal lines in this company (any status) is never
 *     deleted, and a system account never: deactivate instead. Its verifikat
 *     are immutable under BFL and their lines must keep resolving;
 *   - bulk deactivation skips system accounts, and used accounts unless the
 *     caller opts in.
 *
 * A dry run reads but never writes: it runs every check the real call runs
 * and answers what would happen (it is also the MCP staging preview).
 */
import { getBASReference } from '@/lib/bookkeeping/bas-reference'
import {
  defaultRateForVatTreatment,
  isVatTreatmentAllowedForAccountClass,
  type AccountVatRate,
  type AccountVatTreatment,
} from '@/lib/vat/account-vat-treatment'
import { isVatBoxAccount, type AccountVatBox } from '@/lib/vat/account-vat-box'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'

export const ACCOUNT_TYPES = ['asset', 'equity', 'liability', 'revenue', 'expense', 'untaxed_reserves'] as const
export type ChartAccountType = (typeof ACCOUNT_TYPES)[number]
export type ChartNormalBalance = 'debit' | 'credit'

/** A chart row as every write answers it. */
export interface ChartAccountRow {
  id: string
  account_number: string
  account_name: string
  account_class: number
  account_group: string
  account_type: ChartAccountType
  normal_balance: ChartNormalBalance
  plan_type: string | null
  is_active: boolean
  is_system_account: boolean
  description: string | null
  default_vat_code: string | null
  default_vat_rate: number | null
  default_vat_treatment: AccountVatTreatment | null
  vat_box: AccountVatBox | null
  sru_code: string | null
  sort_order: number | null
}

/**
 * BAS class (first digit) to the account types that may live there, matching
 * the BAS 2026 catalogue in lib/bookkeeping/bas-data. Class 8 legitimately
 * holds both financial revenue (80xx-83xx) and financial expense (84xx-89xx).
 * Classes 0 and 9 are free-use per the BAS standard and stay unconstrained.
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

/** An English reason when account_type is illegal for the account's BAS class, else null. */
export function accountClassTypeConflict(accountNumber: string, accountType: string): string | null {
  // Obeskattade reserver are the 21xx group only: every BAS 2026 account of
  // that type is 21xx (periodiseringsfonder 211x-213x, överavskrivningar
  // 215x, ...). Elsewhere in class 2 the type would move a plain liability or
  // equity row into that section.
  if (accountType === 'untaxed_reserves' && !accountNumber.startsWith('21')) {
    return `Account ${accountNumber} is outside the 21xx group, the only one that can hold account_type 'untaxed_reserves'.`
  }
  const allowed = BAS_CLASS_ACCOUNT_TYPES[accountNumber[0]]
  if (!allowed || allowed.includes(accountType)) return null
  return `Account ${accountNumber} is in BAS class ${accountNumber[0]}, which cannot hold account_type '${accountType}' (allowed: ${allowed.join(', ')}).`
}

type Failure = Extract<OperationOutcome<never>, { ok: false }>

/** The VAT rules shared by create and update; null when both pass. */
function vatRuleFailure(
  accountNumber: string,
  treatment: AccountVatTreatment | null | undefined,
  vatBox: AccountVatBox | null | undefined,
): Failure | null {
  const accountClass = Number(accountNumber[0])
  if (treatment && !isVatTreatmentAllowedForAccountClass(treatment, accountClass)) {
    return {
      ok: false,
      code: 'ACCOUNT_VAT_TREATMENT_CLASS',
      details: { account_number: accountNumber, default_vat_treatment: treatment },
    }
  }
  if (vatBox && !isVatBoxAccount(accountNumber)) {
    return { ok: false, code: 'ACCOUNT_VAT_BOX_NOT_VAT_ACCOUNT', details: { account_number: accountNumber, vat_box: vatBox } }
  }
  return null
}

function existsFailure(accountNumber: string, isActive: boolean | undefined): Failure {
  if (isActive === false) {
    return {
      ok: false,
      code: 'ACCOUNT_EXISTS_INACTIVE',
      details: { account_number: accountNumber },
      messageSv: `Kontonummer ${accountNumber} finns redan i din kontoplan men är inaktiverat.`,
    }
  }
  return {
    ok: false,
    code: 'ACCOUNT_EXISTS',
    details: { account_number: accountNumber },
    messageSv: `Kontonummer ${accountNumber} finns redan i din kontoplan.`,
  }
}

const blank = (v: unknown) => v === undefined || (typeof v === 'string' && v.trim() === '')

/** Upper bounds on the free-text columns, checked here so every door shares them. */
const TEXT_LIMITS = { account_name: 200, description: 2000, default_vat_code: 32, sru_code: 16 } as const

function textLimitFailure(input: Partial<Record<keyof typeof TEXT_LIMITS, unknown>>): Failure | null {
  for (const [field, max] of Object.entries(TEXT_LIMITS) as [keyof typeof TEXT_LIMITS, number][]) {
    const value = input[field]
    if (typeof value === 'string' && value.length > max) {
      return {
        ok: false,
        code: 'VALIDATION_ERROR',
        details: { field, message: `${field} can be at most ${max} characters.` },
        messageSv: `Fältet ${field} får vara högst ${max} tecken.`,
      }
    }
  }
  return null
}

/**
 * An existing account's number: digits only. Four for BAS, but a chart
 * imported from another system can carry longer sub-accounts ('19301').
 */
function existingNumberFailure(accountNumber: string): Failure | null {
  if (/^\d{1,10}$/.test(accountNumber)) return null
  return {
    ok: false,
    code: 'VALIDATION_ERROR',
    details: { field: 'account_number', message: 'account_number must be digits, e.g. "5410".' },
    messageSv: 'Kontonummer får bara innehålla siffror.',
  }
}

export interface CreateAccountInput {
  account_number: string
  /** Optional for a BAS 2026 number (prefilled). */
  account_name?: string | null
  account_type?: ChartAccountType | null
  normal_balance?: ChartNormalBalance | null
  /** Omitted or '' takes the BAS description; null stores none. */
  description?: string | null
  default_vat_code?: string | null
  default_vat_rate?: AccountVatRate
  default_vat_treatment?: AccountVatTreatment | null
  vat_box?: AccountVatBox | null
  /** Omitted or '' takes the BAS SRU code; null stores none. */
  sru_code?: string | null
  /**
   * Label of where the account came from. Defaults to 'full_bas' for a BAS
   * number and 'k1' otherwise; the Kontoplan dialog passes 'k1', which keeps
   * a hand-added account out of the prune dialog's preselection.
   */
  plan_type?: 'k1' | 'full_bas'
}

export async function createAccount(
  ctx: OperationContext,
  input: CreateAccountInput,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<ChartAccountRow>> {
  const { supabase, companyId, userId, log } = ctx
  const accountNumber = input.account_number.trim()
  if (!/^\d{4}$/.test(accountNumber)) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      details: { field: 'account_number', message: 'Account number must be exactly 4 digits.' },
      messageSv: 'Kontonummer måste vara 4 siffror.',
    }
  }

  const tooLong = textLimitFailure(input)
  if (tooLong) return tooLong

  const ref = getBASReference(accountNumber)
  const accountName = (input.account_name ?? '').trim() || ref?.account_name
  const accountType = input.account_type ?? ref?.account_type
  const normalBalance = input.normal_balance ?? ref?.normal_balance
  if (!accountName || !accountType || !normalBalance) {
    return {
      ok: false,
      code: 'ACCOUNT_DETAILS_REQUIRED',
      details: { account_number: accountNumber },
      messageSv: `Konto ${accountNumber} finns inte i BAS 2026: ange kontonamn, kontotyp och normal balans.`,
    }
  }

  const conflict = accountClassTypeConflict(accountNumber, accountType)
  if (conflict) {
    return {
      ok: false,
      code: 'ACCOUNT_TYPE_CLASS_CONFLICT',
      details: { account_number: accountNumber, account_type: accountType, reason: conflict },
    }
  }
  const vatFailure = vatRuleFailure(accountNumber, input.default_vat_treatment, input.vat_box)
  if (vatFailure) return vatFailure

  const accountClass = Number(accountNumber[0])
  const treatment = input.default_vat_treatment ?? null
  const defaultVatRate =
    treatment && input.default_vat_rate == null
      ? defaultRateForVatTreatment(treatment, accountClass)
      : (input.default_vat_rate ?? null)

  const row = {
    account_number: accountNumber,
    account_name: accountName,
    account_class: accountClass,
    account_group: accountNumber.substring(0, 2),
    account_type: accountType,
    normal_balance: normalBalance,
    plan_type: input.plan_type ?? (ref ? 'full_bas' : 'k1'),
    is_active: true,
    is_system_account: false,
    description: blank(input.description) ? (ref?.description || null) : (input.description?.trim() ?? null),
    default_vat_code: (input.default_vat_code ?? '').trim() || null,
    default_vat_rate: defaultVatRate,
    default_vat_treatment: treatment,
    vat_box: input.vat_box ?? null,
    sru_code: blank(input.sru_code) ? (ref?.sru_code ?? null) : (input.sru_code?.trim() ?? null),
    sort_order: parseInt(accountNumber, 10),
  }

  const lookupExisting = () =>
    supabase
      .from('chart_of_accounts')
      .select('account_number, account_name, is_active')
      .eq('company_id', companyId)
      .eq('account_number', accountNumber)
      .maybeSingle()

  if (options.dryRun) {
    const { data: existing, error: existingError } = await lookupExisting()
    if (existingError) {
      log.error('account lookup failed', existingError)
      return { ok: false, code: 'UNKNOWN_ERROR', error: existingError }
    }
    if (existing) return existsFailure(accountNumber, existing.is_active)
    return { ok: true, dryRun: true, preview: { ...row, source: ref ? 'bas_2026' : 'custom' } }
  }

  // The happy path is a single insert: the unique (company_id,
  // account_number) is the arbiter, and only a collision pays for the lookup
  // that tells a live duplicate from a deactivated one.
  const { data, error } = await supabase
    .from('chart_of_accounts')
    .insert({
      user_id: userId,
      company_id: companyId,
      account_number: row.account_number,
      account_name: row.account_name,
      account_class: row.account_class,
      account_group: row.account_group,
      account_type: row.account_type,
      normal_balance: row.normal_balance,
      plan_type: row.plan_type,
      is_active: true,
      is_system_account: false,
      description: row.description,
      default_vat_code: row.default_vat_code,
      default_vat_rate: row.default_vat_rate,
      default_vat_treatment: row.default_vat_treatment,
      vat_box: row.vat_box,
      sru_code: row.sru_code,
      sort_order: row.sort_order,
    })
    .select(
      'id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_active, is_system_account, description, default_vat_code, default_vat_rate, default_vat_treatment, vat_box, sru_code, sort_order',
    )
    .single()

  if (error) {
    if (error.code === '23505') {
      const { data: existing } = await lookupExisting()
      return existsFailure(accountNumber, existing?.is_active)
    }
    log.error('account create failed', error)
    return { ok: false, code: 'UNKNOWN_ERROR', error }
  }
  return { ok: true, data: data as ChartAccountRow, created: true }
}

export interface UpdateAccountInput {
  account_name?: string
  /** '' and null both clear. */
  description?: string | null
  default_vat_code?: string | null
  default_vat_rate?: AccountVatRate
  /** null restores the BAS fallback. */
  default_vat_treatment?: AccountVatTreatment | null
  /** null restores the BAS momsruta. */
  vat_box?: AccountVatBox | null
  sru_code?: string | null
  /** false deactivates: history and balances stay, new verifikat cannot use it. */
  is_active?: boolean
}

const UPDATABLE_FIELDS = [
  'account_name',
  'description',
  'default_vat_code',
  'default_vat_rate',
  'default_vat_treatment',
  'vat_box',
  'sru_code',
  'is_active',
] as const
const CLEARABLE_TEXT = new Set(['description', 'default_vat_code', 'sru_code'])

/**
 * Sparse update: only the fields the caller sent reach the row. The number,
 * class, type and normal balance are immutable here: an account that should
 * be something else is a new account.
 */
export async function updateAccount(
  ctx: OperationContext,
  accountNumber: string,
  input: UpdateAccountInput,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<ChartAccountRow>> {
  const { supabase, companyId, log } = ctx
  const badNumber = existingNumberFailure(accountNumber)
  if (badNumber) return badNumber
  const tooLong = textLimitFailure(input)
  if (tooLong) return tooLong

  const changes: Record<string, unknown> = {}
  for (const key of UPDATABLE_FIELDS) {
    let value: unknown = input[key]
    if (value === undefined) continue
    if (CLEARABLE_TEXT.has(key) && typeof value === 'string') value = value.trim() === '' ? null : value.trim()
    if (key === 'account_name') {
      value = String(value).trim()
      if (value === '') {
        return {
          ok: false,
          code: 'VALIDATION_ERROR',
          details: { field: 'account_name', message: 'Account name cannot be empty.' },
          messageSv: 'Kontonamn krävs.',
        }
      }
    }
    changes[key] = value
  }

  const vatFailure = vatRuleFailure(accountNumber, input.default_vat_treatment, input.vat_box)
  if (vatFailure) return vatFailure
  if (Object.keys(changes).length === 0) return { ok: false, code: 'ACCOUNT_NOTHING_TO_UPDATE' }

  const accountClass = Number(accountNumber[0])
  const treatment = input.default_vat_treatment
  const needsStoredRate = Boolean(treatment) && input.default_vat_rate === undefined

  let current: Record<string, unknown> | null = null
  if (options.dryRun || needsStoredRate) {
    const { data, error } = await supabase
      .from('chart_of_accounts')
      .select('account_number, account_name, description, default_vat_code, default_vat_rate, default_vat_treatment, vat_box, sru_code, is_active')
      .eq('company_id', companyId)
      .eq('account_number', accountNumber)
      .maybeSingle()
    if (error) {
      if (error.code === 'PGRST116') return { ok: false, code: 'ACCOUNT_NOT_FOUND', details: { account_number: accountNumber } }
      log.error('account fetch failed', error)
      return { ok: false, code: 'UNKNOWN_ERROR', error }
    }
    if (!data) return { ok: false, code: 'ACCOUNT_NOT_FOUND', details: { account_number: accountNumber } }
    current = data as Record<string, unknown>
  }

  // A treatment without a rate derives the booking rate only when none is
  // stored, so an existing deliberate rate survives a treatment change. An
  // explicit null rate next to a treatment asks for the derived one.
  if (treatment && needsStoredRate && current?.default_vat_rate == null) {
    changes.default_vat_rate = defaultRateForVatTreatment(treatment, accountClass)
  } else if (treatment && input.default_vat_rate === null) {
    changes.default_vat_rate = defaultRateForVatTreatment(treatment, accountClass)
  }

  if (options.dryRun) {
    return { ok: true, dryRun: true, preview: { account_number: accountNumber, current, changes } }
  }

  const { data, error } = await supabase
    .from('chart_of_accounts')
    .update(changes)
    .eq('company_id', companyId)
    .eq('account_number', accountNumber)
    .select(
      'id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_active, is_system_account, description, default_vat_code, default_vat_rate, default_vat_treatment, vat_box, sru_code, sort_order',
    )
    .single()
  if (error) {
    // PGRST116 = zero rows: the account is not in this company's chart.
    if (error.code === 'PGRST116') return { ok: false, code: 'ACCOUNT_NOT_FOUND', details: { account_number: accountNumber } }
    log.error('account update failed', error)
    return { ok: false, code: 'UNKNOWN_ERROR', error }
  }
  return { ok: true, data: data as ChartAccountRow }
}

/** This company's journal-line count per account (all entry statuses). */
async function usageCounts(ctx: OperationContext): Promise<{ counts: Map<string, number> } | { failure: Failure }> {
  // journal_entry_lines has no company_id; get_account_usage_counts is the
  // company-scoped aggregate the kontoplan usage column and the prune dialog
  // run (migration 20260704110000). Another company's use of the same BAS
  // number never counts here.
  const { data, error } = await ctx.supabase.rpc('get_account_usage_counts', { p_company_id: ctx.companyId })
  if (error) {
    ctx.log.error('account usage counts failed', error)
    return { failure: { ok: false, code: 'UNKNOWN_ERROR', error } }
  }
  const counts = new Map<string, number>()
  for (const row of (data ?? []) as { account_number: string; usage_count: number }[]) {
    counts.set(row.account_number, Number(row.usage_count) || 0)
  }
  return { counts }
}

/**
 * Hard-delete an unused, non-system account. There is a small window between
 * the usage check and the delete where a concurrent posting could slip in;
 * journal lines reference accounts by number (account_id is ON DELETE SET
 * NULL), so the entry itself is never damaged.
 */
export async function deleteAccount(
  ctx: OperationContext,
  accountNumber: string,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<{ deleted: true; account_number: string }>> {
  const { supabase, companyId, log } = ctx
  const badNumber = existingNumberFailure(accountNumber)
  if (badNumber) return badNumber
  const { data: account, error: fetchError } = await supabase
    .from('chart_of_accounts')
    .select('id, account_number, account_name, is_system_account')
    .eq('company_id', companyId)
    .eq('account_number', accountNumber)
    .maybeSingle()
  if (fetchError && fetchError.code !== 'PGRST116') {
    log.error('account fetch failed', fetchError)
    return { ok: false, code: 'UNKNOWN_ERROR', error: fetchError }
  }
  if (!account) return { ok: false, code: 'ACCOUNT_NOT_FOUND', details: { account_number: accountNumber } }
  if (account.is_system_account) {
    return { ok: false, code: 'ACCOUNT_SYSTEM_DELETE', details: { account_number: accountNumber } }
  }

  const usage = await usageCounts(ctx)
  if ('failure' in usage) return usage.failure
  const usageCount = usage.counts.get(accountNumber) ?? 0
  if (usageCount > 0) {
    return { ok: false, code: 'ACCOUNT_IN_USE', details: { account_number: accountNumber, usage_count: usageCount } }
  }

  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      preview: { account_number: accountNumber, account_name: account.account_name, usage_count: 0 },
    }
  }

  const { error: deleteError } = await supabase
    .from('chart_of_accounts')
    .delete()
    .eq('id', account.id)
    .eq('company_id', companyId)
  if (deleteError) {
    log.error('account delete failed', deleteError)
    return { ok: false, code: 'UNKNOWN_ERROR', error: deleteError }
  }
  return { ok: true, data: { deleted: true, account_number: accountNumber } }
}

export interface ActivateAccountsResult {
  accounts: { account_number: string }[]
  activated: number
  reactivated: number
  skipped: number
  unknown: string[]
}

/**
 * Batch-activate accounts: standard BAS 2026 numbers missing from the chart
 * are inserted from the catalogue, deactivated rows are reactivated, active
 * ones are skipped. Numbers that are neither in the chart nor in BAS 2026
 * are reported in `unknown`, not refused, so activate-and-retry flows can
 * surface them.
 */
export async function activateAccounts(
  ctx: OperationContext,
  accountNumbers: string[],
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<ActivateAccountsResult>> {
  const { supabase, companyId, userId, log } = ctx
  const uniqueNumbers = [...new Set(accountNumbers)]

  const { data: existing, error: fetchError } = await supabase
    .from('chart_of_accounts')
    .select('account_number, is_active')
    .eq('company_id', companyId)
    .in('account_number', uniqueNumbers)
  if (fetchError) {
    log.error('account activation lookup failed', fetchError)
    return { ok: false, code: 'UNKNOWN_ERROR', error: fetchError }
  }
  const activeByNumber = new Map<string, boolean>(
    ((existing ?? []) as { account_number: string; is_active: boolean }[]).map((a) => [a.account_number, a.is_active]),
  )

  const toReactivate: string[] = []
  const toInsert: NonNullable<ReturnType<typeof basInsertRow>>[] = []
  const unknown: string[] = []
  let skipped = 0
  for (const num of uniqueNumbers) {
    if (activeByNumber.has(num)) {
      if (activeByNumber.get(num) === true) skipped += 1
      else toReactivate.push(num)
      continue
    }
    const row = basInsertRow(num, userId, companyId)
    if (row) toInsert.push(row)
    else unknown.push(num)
  }

  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      preview: {
        to_insert: toInsert.map((r) => ({ account_number: r.account_number, account_name: r.account_name })),
        to_reactivate: toReactivate,
        skipped,
        unknown,
      },
    }
  }

  let reactivated: { account_number: string }[] = []
  if (toReactivate.length > 0) {
    const { data, error } = await supabase
      .from('chart_of_accounts')
      .update({ is_active: true })
      .eq('company_id', companyId)
      .in('account_number', toReactivate)
      .select('account_number')
    if (error) {
      log.error('account reactivation failed', error)
      return { ok: false, code: 'UNKNOWN_ERROR', error }
    }
    reactivated = (data ?? []) as { account_number: string }[]
  }

  let inserted: { account_number: string }[] = []
  if (toInsert.length > 0) {
    const { data, error } = await supabase.from('chart_of_accounts').insert(toInsert).select('account_number')
    if (error) {
      log.error('account activation insert failed', error)
      return { ok: false, code: 'UNKNOWN_ERROR', error }
    }
    inserted = (data ?? []) as { account_number: string }[]
  }

  return {
    ok: true,
    data: {
      accounts: [...inserted, ...reactivated],
      activated: inserted.length,
      reactivated: reactivated.length,
      skipped,
      unknown,
    },
  }
}

function basInsertRow(accountNumber: string, userId: string, companyId: string) {
  const ref = getBASReference(accountNumber)
  if (!ref) return null
  return {
    user_id: userId,
    company_id: companyId,
    account_number: ref.account_number,
    account_name: ref.account_name,
    account_class: ref.account_class,
    account_group: ref.account_group,
    account_type: ref.account_type,
    normal_balance: ref.normal_balance,
    plan_type: 'full_bas' as const,
    is_active: true,
    is_system_account: false,
    description: ref.description,
    sru_code: ref.sru_code,
    sort_order: parseInt(ref.account_number, 10),
  }
}

export interface DeactivateAccountsResult {
  accounts: { account_number: string }[]
  deactivated: number
  skipped_system: string[]
  skipped_used: string[]
  skipped_inactive: number
  unknown: string[]
}

/**
 * Batch-deactivate accounts (the post-migration sweep, #2186). System
 * accounts are never deactivated here; accounts with postings are skipped
 * unless includeUsed, because deactivating a used account hides its balances
 * from the kontoplan. Already-inactive numbers are counted, numbers not in
 * the chart reported in `unknown`.
 */
export async function deactivateAccounts(
  ctx: OperationContext,
  accountNumbers: string[],
  includeUsed: boolean,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<DeactivateAccountsResult>> {
  const { supabase, companyId, log } = ctx
  const uniqueNumbers = [...new Set(accountNumbers)]

  const { data: existing, error: fetchError } = await supabase
    .from('chart_of_accounts')
    .select('account_number, is_active, is_system_account')
    .eq('company_id', companyId)
    .in('account_number', uniqueNumbers)
  if (fetchError) {
    log.error('account deactivation lookup failed', fetchError)
    return { ok: false, code: 'UNKNOWN_ERROR', error: fetchError }
  }

  const usage = await usageCounts(ctx)
  if ('failure' in usage) return usage.failure

  const byNumber = new Map(
    ((existing ?? []) as { account_number: string; is_active: boolean; is_system_account: boolean }[]).map((a) => [
      a.account_number,
      a,
    ]),
  )
  const toDeactivate: string[] = []
  const skippedSystem: string[] = []
  const skippedUsed: string[] = []
  const unknown: string[] = []
  let skippedInactive = 0
  for (const num of uniqueNumbers) {
    const row = byNumber.get(num)
    if (!row) {
      unknown.push(num)
      continue
    }
    if (!row.is_active) {
      skippedInactive += 1
      continue
    }
    if (row.is_system_account) {
      skippedSystem.push(num)
      continue
    }
    // Accounts never posted to are absent from the usage result.
    if (usage.counts.has(num) && !includeUsed) {
      skippedUsed.push(num)
      continue
    }
    toDeactivate.push(num)
  }

  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      preview: {
        to_deactivate: toDeactivate,
        skipped_system: skippedSystem,
        skipped_used: skippedUsed,
        skipped_inactive: skippedInactive,
        unknown,
      },
    }
  }

  let deactivated: { account_number: string }[] = []
  if (toDeactivate.length > 0) {
    const { data, error } = await supabase
      .from('chart_of_accounts')
      .update({ is_active: false })
      .eq('company_id', companyId)
      .in('account_number', toDeactivate)
      .select('account_number')
    if (error) {
      log.error('account deactivation failed', error)
      return { ok: false, code: 'UNKNOWN_ERROR', error }
    }
    deactivated = (data ?? []) as { account_number: string }[]
  }

  return {
    ok: true,
    data: {
      accounts: deactivated,
      deactivated: deactivated.length,
      skipped_system: skippedSystem,
      skipped_used: skippedUsed,
      skipped_inactive: skippedInactive,
      unknown,
    },
  }
}
