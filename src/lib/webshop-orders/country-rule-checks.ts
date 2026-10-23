import { isAssignedCountryCode } from '@/lib/vat/country-codes'
import { PINNED_JURISDICTION, resolveAccountRole } from '@/lib/bookkeeping/account-roles'
import { isAccountVatBox } from '@/lib/vat/account-vat-box'
import { getBoxForAccount, type MomsBox } from '@/lib/vat/moms-box-mapping'
import { resolveRevenueDeclarationBox } from '@/lib/reports/vat-revenue-accounts'
import type { WebshopCountryAccountRule } from '@/types'
import {
  COUNTRY_SCOPE_EU,
  COUNTRY_SCOPE_NON_EU,
  SWEDISH_RULE_RATES,
  isEuRuleCountry,
  ruleCoversVat,
  sameVatRate,
} from './country-routing'

/**
 * Server-side checks for webshop country rules (the settings route), kept
 * apart from country-routing.ts so the browser bundle that routes orders
 * never pulls in the VAT report helpers.
 */


/** The chart_of_accounts columns the checks read. */
export interface CountryRuleChartRow {
  account_number: string
  account_name: string
  account_class: number
  is_active: boolean
  default_vat_rate: number | string | null
  default_vat_treatment: string | null
  vat_box: string | null
}

export type CountryRuleProblemCode =
  | 'platform_unsupported'
  | 'country_invalid'
  | 'country_sweden'
  | 'duplicate'
  | 'swedish_outside_eu'
  | 'swedish_rate'
  | 'account_unknown'
  | 'revenue_account_class'
  | 'revenue_counts_as_swedish'
  | 'revenue_in_declaration'
  | 'revenue_box_wrong_region'
  | 'vat_account_required'
  | 'vat_account_class'
  | 'vat_account_in_declaration'

export interface CountryRuleProblem {
  /** Index of the rule in the submitted array. */
  index: number
  field: 'country' | 'vat_rate' | 'revenue_account' | 'vat_account'
  code: CountryRuleProblemCode
  account?: string
  box?: MomsBox
}

/** Öresavrundning: the residual line the bulk guard finds structurally. */
const ROUNDING_ACCOUNT = resolveAccountRole(PINNED_JURISDICTION, 'rounding')
/** The momsredovisning clearing account; it nets the declaration. */
const VAT_CLEARING_ACCOUNT = resolveAccountRole(PINNED_JURISDICTION, 'vat_settlement')
/** Boxes that hold the base of sales taxed in Sweden. */
const DOMESTIC_SALES_BOXES: readonly MomsBox[] = ['05', '06', '07', '08']
/** Boxes for goods and services sold to other EU countries. */
const EU_SALES_BOXES: readonly MomsBox[] = ['35', '38', '39']
/** Boxes for sales outside the EU. */
const NON_EU_SALES_BOXES: readonly MomsBox[] = ['36', '40']

/**
 * Whether the Swedish momsdeklaration reads a VAT account: a 26xx account in
 * the BAS ruta map (2611, 2614, 2615, ...), one with a momsruta override, or
 * the 2650 clearing account. VAT owed abroad (OSS, VOEC) must sit on an
 * account it does not read, or the declaration and the VAT settlement would
 * treat it as Swedish VAT.
 */
export function vatAccountInSwedishDeclaration(
  row: Pick<CountryRuleChartRow, 'account_number' | 'vat_box'>,
): boolean {
  return (
    row.account_number === VAT_CLEARING_ACCOUNT ||
    isAccountVatBox(row.vat_box) ||
    getBoxForAccount(row.account_number) !== undefined
  )
}

/**
 * Everything wrong with a rule set, against the company's chart (active rows,
 * keyed by account number). The checks keep each rule inside what the
 * momsdeklaration expects: a sale taxed abroad never feeds a Swedish sales
 * box, OSS sales stay out of the declaration entirely, and VAT owed abroad
 * never sits on an account the declaration reads.
 */
export function countryRuleProblems(
  rules: readonly WebshopCountryAccountRule[],
  chart: ReadonlyMap<string, CountryRuleChartRow>,
): CountryRuleProblem[] {
  const problems: CountryRuleProblem[] = []
  const seen = new Set<string>()

  rules.forEach((rule, index) => {
    const country = rule.country
    const scopeOk =
      country === COUNTRY_SCOPE_EU || country === COUNTRY_SCOPE_NON_EU || isAssignedCountryCode(country)
    if (!scopeOk) {
      problems.push({ index, field: 'country', code: 'country_invalid' })
      return
    }
    if (country === 'SE') {
      problems.push({ index, field: 'country', code: 'country_sweden' })
      return
    }
    const key = `${country}|${rule.vat_rate === null ? 'any' : rule.vat_rate}`
    if (seen.has(key)) {
      problems.push({ index, field: 'vat_rate', code: 'duplicate' })
      return
    }
    seen.add(key)

    const eu = isEuRuleCountry(country)
    if (rule.mode === 'swedish') {
      if (!eu) problems.push({ index, field: 'country', code: 'swedish_outside_eu' })
      if (rule.vat_rate !== null && !SWEDISH_RULE_RATES.some((r) => sameVatRate(r, rule.vat_rate as number))) {
        problems.push({ index, field: 'vat_rate', code: 'swedish_rate' })
      }
      return
    }

    const revenue = chart.get(rule.revenue_account)
    if (!revenue || !revenue.is_active) {
      problems.push({ index, field: 'revenue_account', code: 'account_unknown', account: rule.revenue_account })
    } else if (revenue.account_class !== 3 || rule.revenue_account === ROUNDING_ACCOUNT) {
      problems.push({ index, field: 'revenue_account', code: 'revenue_account_class', account: rule.revenue_account })
    } else {
      const box = resolveRevenueDeclarationBox(revenue)
      if (box && DOMESTIC_SALES_BOXES.includes(box)) {
        problems.push({ index, field: 'revenue_account', code: 'revenue_counts_as_swedish', account: rule.revenue_account, box })
      } else if (eu && ruleCoversVat(rule) && box) {
        // OSS: the sale is declared in the OSS return, never in a ruta.
        problems.push({ index, field: 'revenue_account', code: 'revenue_in_declaration', account: rule.revenue_account, box })
      } else if (box && (eu ? NON_EU_SALES_BOXES : EU_SALES_BOXES).includes(box)) {
        problems.push({ index, field: 'revenue_account', code: 'revenue_box_wrong_region', account: rule.revenue_account, box })
      }
    }

    if (!rule.vat_account) {
      if (ruleCoversVat(rule)) problems.push({ index, field: 'vat_account', code: 'vat_account_required' })
      return
    }
    const vat = chart.get(rule.vat_account)
    if (!vat || !vat.is_active) {
      problems.push({ index, field: 'vat_account', code: 'account_unknown', account: rule.vat_account })
    } else if (vat.account_class !== 2) {
      problems.push({ index, field: 'vat_account', code: 'vat_account_class', account: rule.vat_account })
    } else if (vatAccountInSwedishDeclaration(vat)) {
      problems.push({ index, field: 'vat_account', code: 'vat_account_in_declaration', account: rule.vat_account })
    }
  })

  return problems
}

/**
 * The revenue accounts that should carry VAT code OSS: those of 'accounts'
 * rules for EU countries that cover VAT. Setting it keeps the momsdeklaration
 * from listing them as revenue without a ruta.
 */
export function ossRevenueAccounts(rules: readonly WebshopCountryAccountRule[]): string[] {
  const accounts = new Set<string>()
  for (const rule of rules) {
    if (rule.mode === 'accounts' && isEuRuleCountry(rule.country) && ruleCoversVat(rule)) {
      accounts.add(rule.revenue_account)
    }
  }
  return Array.from(accounts)
}
