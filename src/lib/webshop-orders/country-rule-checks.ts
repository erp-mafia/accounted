import { isAssignedCountryCode } from '@/lib/vat/country-codes'
import { PINNED_JURISDICTION, resolveAccountRole } from '@/lib/bookkeeping/account-roles'
import { isAccountVatBox } from '@/lib/vat/account-vat-box'
import { getBoxForAccount, type MomsBox } from '@/lib/vat/moms-box-mapping'
import { resolveEffectiveVatRate, resolveRevenueDeclarationBox } from '@/lib/reports/vat-revenue-accounts'
import type { WebshopCountryAccountRule } from '@/types'
import {
  COUNTRY_SCOPE_EU,
  COUNTRY_SCOPE_NON_EU,
  SWEDISH_RULE_RATES,
  isEuRuleCountry,
  isOssRule,
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
  | 'swedish_revenue_zero_rate'
  | 'swedish_revenue_vat_code'
  | 'account_unknown'
  | 'revenue_account_class'
  | 'revenue_counts_as_swedish'
  | 'revenue_in_declaration'
  | 'revenue_swedish_vat_on_eu'
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
 * What is wrong with the own revenue account of a 'swedish' rule, or null.
 * The sale keeps Swedish VAT (the output VAT account follows the rate), so
 * its net must land where a Swedish sale does: ruta 05. A rule for one rate
 * also needs an account whose momssats is that rate, the bulk revenue
 * template's guard (resolveEffectiveVatRate). A rule for every rate takes any
 * ruta 05 account: ruta 05 holds the base of all three rates, and rutor 10-12
 * follow the VAT lines.
 */
function swedishRevenueProblem(
  rule: Pick<WebshopCountryAccountRule, 'vat_rate'>,
  account: string,
  chart: ReadonlyMap<string, CountryRuleChartRow>,
): Pick<CountryRuleProblem, 'code' | 'box'> | null {
  if (!ruleCoversVat(rule)) return { code: 'swedish_revenue_zero_rate' }
  const revenue = chart.get(account)
  if (!revenue || !revenue.is_active) return { code: 'account_unknown' }
  if (revenue.account_class !== 3 || account === ROUNDING_ACCOUNT) return { code: 'revenue_account_class' }
  const box = resolveRevenueDeclarationBox(revenue)
  const rate = resolveEffectiveVatRate(revenue)
  const rateFits = rule.vat_rate === null || (rate !== null && sameVatRate(rate * 100, rule.vat_rate))
  if (box !== '05' || !rateFits) return box ? { code: 'swedish_revenue_vat_code', box } : { code: 'swedish_revenue_vat_code' }
  return null
}

/**
 * Everything wrong with a rule set, against the company's chart (active rows,
 * keyed by account number). The checks keep each rule inside what the
 * momsdeklaration expects: a sale taxed abroad never feeds a Swedish sales
 * box, OSS sales stay out of the declaration entirely, VAT owed abroad never
 * sits on an account the declaration reads, and a sale with Swedish VAT
 * (a 'swedish' rule) lands in ruta 05.
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
      if (rule.revenue_account) {
        const problem = swedishRevenueProblem(rule, rule.revenue_account, chart)
        if (problem) problems.push({ index, field: 'revenue_account', account: rule.revenue_account, ...problem })
      }
      return
    }

    // A Swedish VAT sale written as an 'accounts' rule (below).
    let swedishVatSale = false

    const revenue = chart.get(rule.revenue_account)
    if (!revenue || !revenue.is_active) {
      problems.push({ index, field: 'revenue_account', code: 'account_unknown', account: rule.revenue_account })
    } else if (revenue.account_class !== 3 || rule.revenue_account === ROUNDING_ACCOUNT) {
      problems.push({ index, field: 'revenue_account', code: 'revenue_account_class', account: rule.revenue_account })
    } else {
      const box = resolveRevenueDeclarationBox(revenue)
      if (box === '05' && isOssRule(rule)) {
        // Swedish VAT on an EU sale (crm#1449): a distance seller below the
        // threshold books EU consumer sales like Swedish ones, ruta 05 and
        // 2611. That is a 'swedish' rule, which keeps this account. An
        // 'accounts' rule for an EU country with VAT is read as OSS (VAT code
        // OSS on its account, the OSS underlag), so it must not carry the
        // sale. The copy names both ways out: Svensk moms, or VAT code OSS.
        swedishVatSale = true
        problems.push({ index, field: 'revenue_account', code: 'revenue_swedish_vat_on_eu', account: rule.revenue_account, box })
      } else if (box && isOssRule(rule)) {
        // OSS: the sale is declared in the OSS return, never in a ruta, so an
        // OSS rule gets this one code, whose copy can point at VAT code OSS.
        // The codes below are for rules OSS does not cover, where that advice
        // would be wrong.
        problems.push({ index, field: 'revenue_account', code: 'revenue_in_declaration', account: rule.revenue_account, box })
      } else if (box && DOMESTIC_SALES_BOXES.includes(box)) {
        problems.push({ index, field: 'revenue_account', code: 'revenue_counts_as_swedish', account: rule.revenue_account, box })
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
    } else if (vatAccountInSwedishDeclaration(vat) && !swedishVatSale) {
      // On a Swedish VAT sale the Swedish VAT account is right; the revenue
      // problem already sends the row to a 'swedish' rule, which books it.
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
    if (rule.mode === 'accounts' && isOssRule(rule)) {
      accounts.add(rule.revenue_account)
    }
  }
  return Array.from(accounts)
}
