import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'
import { getBASReference } from '@/lib/bookkeeping/bas-reference'
import { resolveRevenueDeclarationBox } from '@/lib/reports/vat-revenue-accounts'
import { ACCOUNT_TO_BOX } from '@/lib/vat/moms-box-mapping'
import type { WebshopCountryAccountRule, WebshopPlatform } from '@/types'
import { COUNTRY_PRESET_ACCOUNTS, OSS_REVENUE_ACCOUNT } from './country-routing'
import {
  countryRuleProblems,
  ossRevenueAccounts,
  type CountryRuleChartRow,
  type CountryRuleProblem,
} from './country-rule-checks'
import { ensureCountryPresetAccounts } from './ensure-accounts'

export type PrepareCountryRulesOutcome =
  | { ok: true }
  | { ok: false; kind: 'invalid'; problems: CountryRuleProblem[] }
  | { ok: false; kind: 'db_error'; error: unknown }

/**
 * Check a store's country rules against the company's chart and get the
 * chart ready for them, before the settings route stores them:
 *
 * - every account a rule names must exist and fit the rule
 *   (country-rule-checks.ts); a preset account the chart lacks is checked as
 *   the row ensureCountryPresetAccounts is about to create;
 * - the preset accounts (3106 with VAT code OSS, 2670, 3105) are added when
 *   missing;
 * - an OSS revenue account without a VAT code gets 'oss', so the
 *   momsdeklaration keeps it out of every ruta on purpose instead of listing
 *   it as revenue without one;
 * - the preset OSS account (3106) whose VAT code puts it in a ruta gets 'oss'
 *   too, but only when the company has never booked on it
 *   (unusedPresetOssAccount).
 *
 * Shopify only: WooCommerce rows store the billing country.
 */
export async function prepareCountryRules(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  platform: WebshopPlatform,
  rules: readonly WebshopCountryAccountRule[],
  log: Logger,
): Promise<PrepareCountryRulesOutcome> {
  if (rules.length > 0 && platform !== 'shopify') {
    return {
      ok: false,
      kind: 'invalid',
      problems: [{ index: 0, field: 'country', code: 'platform_unsupported' }],
    }
  }

  const accounts = new Set<string>()
  // A 'swedish' rule's own revenue account is read for the checks only, never
  // created: it is the user's account, not a preset one.
  const lookup = new Set<string>()
  for (const rule of rules) {
    if (rule.mode === 'swedish') {
      if (rule.revenue_account) lookup.add(rule.revenue_account)
      continue
    }
    accounts.add(rule.revenue_account)
    if (rule.vat_account) accounts.add(rule.vat_account)
  }
  for (const account of accounts) lookup.add(account)

  const chart = new Map<string, CountryRuleChartRow>()
  if (lookup.size > 0) {
    const { data, error } = await supabase
      .from('chart_of_accounts')
      .select(
        'account_number, account_name, account_class, is_active, default_vat_rate, default_vat_treatment, vat_box',
      )
      .eq('company_id', companyId)
      .in('account_number', Array.from(lookup))
    if (error) return { ok: false, kind: 'db_error', error }
    for (const row of (data ?? []) as CountryRuleChartRow[]) chart.set(row.account_number, row)
  }

  const toCreate: string[] = []
  for (const account of accounts) {
    const existing = chart.get(account)
    if (existing?.is_active || !COUNTRY_PRESET_ACCOUNTS.includes(account)) continue
    const bas = getBASReference(account)
    if (!bas) continue
    toCreate.push(account)
    chart.set(account, {
      account_number: account,
      account_name: existing?.account_name ?? bas.account_name,
      account_class: existing?.account_class ?? bas.account_class,
      is_active: true,
      default_vat_rate: existing?.default_vat_rate ?? null,
      default_vat_treatment: existing
        ? existing.default_vat_treatment
        : account === OSS_REVENUE_ACCOUNT
          ? 'oss'
          : null,
      vat_box: existing?.vat_box ?? null,
    })
  }

  const ossAccounts = ossRevenueAccounts(rules)
  const preset = await unusedPresetOssAccount(supabase, companyId, ossAccounts, chart)
  if (!preset.ok) return { ok: false, kind: 'db_error', error: preset.error }
  const presetToOss = preset.row
  if (presetToOss) chart.set(presetToOss.account_number, presetToOss)

  const problems = countryRuleProblems(rules, chart)
  if (problems.length > 0) return { ok: false, kind: 'invalid', problems }

  await ensureCountryPresetAccounts(supabase, companyId, userId, toCreate, log)

  if (presetToOss) {
    // The same row ensureCountryPresetAccounts creates: VAT code OSS and no
    // Swedish momssats (an OSS sale carries the destination country's rate).
    const { error } = await supabase
      .from('chart_of_accounts')
      .update({ default_vat_treatment: 'oss', default_vat_rate: null })
      .eq('company_id', companyId)
      .eq('account_number', presetToOss.account_number)
    // Fatal, unlike the update below: the rules passed only as if the account
    // had VAT code OSS. Stored without it, they would book OSS sales into the
    // ruta its old code names.
    if (error) return { ok: false, kind: 'db_error', error }
  }

  const untreated = ossAccounts.filter((account) => {
    const row = chart.get(account)
    return !!row && !row.default_vat_treatment && !ACCOUNT_TO_BOX[account]
  })
  if (untreated.length > 0) {
    const { error } = await supabase
      .from('chart_of_accounts')
      .update({ default_vat_treatment: 'oss' })
      .eq('company_id', companyId)
      .in('account_number', untreated)
      .is('default_vat_treatment', null)
    // Not fatal: the rule still keeps the sale out of ruta 05, the
    // declaration only lists the account as revenue without a ruta.
    if (error) log.warn('could not set VAT code OSS on revenue accounts', { error: error.message })
  }

  return { ok: true }
}

/**
 * The preset OSS account (3106) as it will be once it gets VAT code OSS, when
 * that change is safe to make on the user's behalf; null otherwise.
 *
 * Safe means all of: an OSS rule names it (the user chose OSS for it); its
 * current VAT code puts it in a ruta, so the rule would otherwise be refused;
 * and the company has no journal line on it at all, in any entry status,
 * drafts included (get_account_usage_counts, the count the kontoplan's
 * Verifikat column shows). With no line on the account, no momsdeklaration
 * has ever read its VAT code, so changing it moves nothing that was declared.
 * An account with history is never changed here: the refusal stands, and the
 * user decides in Kontoplanen.
 *
 * Only the preset account, never one the user typed: its VAT code may carry
 * a meaning this flow cannot see. A line booked between this read and the
 * update can only be a new, undeclared one.
 */
async function unusedPresetOssAccount(
  supabase: SupabaseClient,
  companyId: string,
  ossAccounts: readonly string[],
  chart: ReadonlyMap<string, CountryRuleChartRow>,
): Promise<{ ok: true; row: CountryRuleChartRow | null } | { ok: false; error: unknown }> {
  const none = { ok: true, row: null } as const
  if (!ossAccounts.includes(OSS_REVENUE_ACCOUNT)) return none
  const row = chart.get(OSS_REVENUE_ACCOUNT)
  if (!row || row.default_vat_treatment === 'oss' || resolveRevenueDeclarationBox(row) === null) {
    return none
  }

  // Filtered to 3106 by PostgREST, not in JS. The RPC returns one row per
  // used account, and an unfiltered read stops at PostgREST's 1,000-row cap,
  // so on a large chart 3106 could fall outside the page and read as unused.
  const { data, error } = await supabase
    .rpc('get_account_usage_counts', { p_company_id: companyId })
    .eq('account_number', OSS_REVENUE_ACCOUNT)
  if (error) return { ok: false, error }
  // Fails closed: only an empty answer, or 3106 with a count of zero, means
  // unused. A row for any other account says the filter did not hold, so the
  // answer cannot vouch for 3106 and the refusal stands.
  const unused = ((data ?? []) as { account_number: string; usage_count: number | string }[]).every(
    (usage) => usage.account_number === OSS_REVENUE_ACCOUNT && Number(usage.usage_count) === 0,
  )
  if (!unused) return none
  return { ok: true, row: { ...row, default_vat_treatment: 'oss', default_vat_rate: null } }
}
