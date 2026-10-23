import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'
import { getBASReference } from '@/lib/bookkeeping/bas-reference'
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
 *   it as revenue without one.
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
  for (const rule of rules) {
    if (rule.mode !== 'accounts') continue
    accounts.add(rule.revenue_account)
    if (rule.vat_account) accounts.add(rule.vat_account)
  }

  const chart = new Map<string, CountryRuleChartRow>()
  if (accounts.size > 0) {
    const { data, error } = await supabase
      .from('chart_of_accounts')
      .select(
        'account_number, account_name, account_class, is_active, default_vat_rate, default_vat_treatment, vat_box',
      )
      .eq('company_id', companyId)
      .in('account_number', Array.from(accounts))
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

  const problems = countryRuleProblems(rules, chart)
  if (problems.length > 0) return { ok: false, kind: 'invalid', problems }

  await ensureCountryPresetAccounts(supabase, companyId, userId, toCreate, log)

  const untreated = ossRevenueAccounts(rules).filter((account) => {
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
