import { describe, it, expect } from 'vitest'
import {
  countryRuleProblems,
  ossRevenueAccounts,
  vatAccountInSwedishDeclaration,
  type CountryRuleChartRow,
} from '../country-rule-checks'
import { NO_OSS_PRESET_RULES, OSS_PRESET_RULES } from '../country-routing'
import type { WebshopCountryAccountRule } from '@/types'

const row = (
  account_number: string,
  account_name: string,
  overrides: Partial<CountryRuleChartRow> = {},
): CountryRuleChartRow => ({
  account_number,
  account_name,
  account_class: Number(account_number.charAt(0)),
  is_active: true,
  default_vat_rate: null,
  default_vat_treatment: null,
  vat_box: null,
  ...overrides,
})

const chartOf = (...rows: CountryRuleChartRow[]) => new Map(rows.map((r) => [r.account_number, r]))

const BAS_CHART = chartOf(
  row('3001', 'Försäljning inom Sverige, 25 % moms'),
  row('3105', 'Försäljning varor till land utanför EU'),
  row('3106', 'Försäljning varor till annat EU-land, momspliktig', { default_vat_treatment: 'oss' }),
  row('3108', 'Försäljning varor till annat EU-land, momsfri'),
  row('2611', 'Utgående moms på försäljning inom Sverige, 25 %'),
  row('2670', 'Utgående moms på försäljning inom EU, OSS'),
  row('2890', 'Övriga kortfristiga skulder'),
  row('2690', 'Övriga skulder avseende punktskatter', { vat_box: '10' }),
  row('1930', 'Företagskonto'),
)

const accounts = (
  country: string,
  vat_rate: number | null,
  revenue_account: string,
  vat_account: string | null,
): WebshopCountryAccountRule => ({ country, vat_rate, mode: 'accounts', revenue_account, vat_account })

describe('countryRuleProblems', () => {
  it('accepts both presets and a VOEC row on the BAS chart', () => {
    expect(countryRuleProblems(OSS_PRESET_RULES, BAS_CHART)).toEqual([])
    expect(countryRuleProblems(NO_OSS_PRESET_RULES, BAS_CHART)).toEqual([])
    expect(countryRuleProblems([accounts('NO', 25, '3105', '2890')], BAS_CHART)).toEqual([])
  })

  it('refuses a foreign sale OSS does not cover on an account the declaration counts as Swedish sales', () => {
    expect(countryRuleProblems([accounts('NON_EU', 0, '3001', null)], BAS_CHART)).toEqual([
      { index: 0, field: 'revenue_account', code: 'revenue_counts_as_swedish', account: '3001', box: '05' },
    ])
    expect(countryRuleProblems([accounts('DE', 0, '3001', null)], BAS_CHART)).toEqual([
      { index: 0, field: 'revenue_account', code: 'revenue_counts_as_swedish', account: '3001', box: '05' },
    ])
  })

  it('refuses an OSS sale on an account that lands in any ruta, ruta 05 included', () => {
    // 3108 is ruta 35 (EU B2B, VAT-free): right for 0 %, wrong for OSS.
    expect(countryRuleProblems([accounts('EU', null, '3108', '2670')], BAS_CHART)).toEqual([
      { index: 0, field: 'revenue_account', code: 'revenue_in_declaration', account: '3108', box: '35' },
    ])
    expect(countryRuleProblems([accounts('EU', 0, '3108', null)], BAS_CHART)).toEqual([])
    // An OSS rule gets the OSS code even for ruta 05: its copy is the one
    // that can point at VAT code OSS.
    expect(countryRuleProblems([accounts('DK', null, '3001', '2670')], BAS_CHART)).toEqual([
      { index: 0, field: 'revenue_account', code: 'revenue_in_declaration', account: '3001', box: '05' },
    ])
  })

  it('refuses the preset 3106 when its VAT code puts it in a ruta', () => {
    // The VAT codes 3106 carries in production charts besides OSS.
    const cases: Array<[string, string]> = [
      ['reverse_charge_eu_goods', '35'],
      ['standard_25', '05'],
      ['exempt', '42'],
    ]
    for (const [treatment, box] of cases) {
      const chart = chartOf(
        ...BAS_CHART.values(),
        row('3106', 'Försäljning varor till annat EU-land, momspliktig', { default_vat_treatment: treatment }),
      )
      expect(countryRuleProblems(OSS_PRESET_RULES, chart)).toEqual([
        { index: 0, field: 'revenue_account', code: 'revenue_in_declaration', account: '3106', box },
      ])
    }
  })

  it('refuses a box for the wrong side of the EU border', () => {
    expect(countryRuleProblems([accounts('NON_EU', 0, '3108', null)], BAS_CHART)).toEqual([
      { index: 0, field: 'revenue_account', code: 'revenue_box_wrong_region', account: '3108', box: '35' },
    ])
    expect(countryRuleProblems([accounts('DE', 0, '3105', null)], BAS_CHART)).toEqual([
      { index: 0, field: 'revenue_account', code: 'revenue_box_wrong_region', account: '3105', box: '36' },
    ])
  })

  it('keeps VAT owed abroad off every account the Swedish declaration reads', () => {
    const problems = countryRuleProblems(
      [accounts('DK', null, '3106', '2611'), accounts('NO', 25, '3105', '2690'), accounts('FI', null, '3106', '2650')],
      chartOf(...BAS_CHART.values(), row('2650', 'Redovisningskonto för moms')),
    )
    expect(problems.map((p) => [p.index, p.code])).toEqual([
      [0, 'vat_account_in_declaration'],
      [1, 'vat_account_in_declaration'],
      [2, 'vat_account_in_declaration'],
    ])
  })

  it('needs a VAT account when the rule covers VAT, and a class 2 one', () => {
    expect(countryRuleProblems([accounts('NO', 25, '3105', null)], BAS_CHART)).toEqual([
      { index: 0, field: 'vat_account', code: 'vat_account_required' },
    ])
    expect(countryRuleProblems([accounts('NO', 25, '3105', '1930')], BAS_CHART)).toEqual([
      { index: 0, field: 'vat_account', code: 'vat_account_class', account: '1930' },
    ])
  })

  it('names accounts that are missing or inactive', () => {
    const chart = chartOf(...BAS_CHART.values(), row('3013', 'Försäljning OSS Tyskland', { is_active: false }))
    expect(countryRuleProblems([accounts('DE', null, '3013', '2674')], chart)).toEqual([
      { index: 0, field: 'revenue_account', code: 'account_unknown', account: '3013' },
      { index: 0, field: 'vat_account', code: 'account_unknown', account: '2674' },
    ])
  })

  it('checks the country, Sweden and duplicates', () => {
    const problems = countryRuleProblems(
      [
        accounts('XX', null, '3106', '2670'),
        accounts('SE', null, '3106', '2670'),
        accounts('DK', null, '3106', '2670'),
        accounts('DK', null, '3106', '2670'),
      ],
      BAS_CHART,
    )
    expect(problems.map((p) => [p.index, p.code])).toEqual([
      [0, 'country_invalid'],
      [1, 'country_sweden'],
      [3, 'duplicate'],
    ])
  })

  it('allows Swedish accounts only for the EU and Swedish rates', () => {
    const problems = countryRuleProblems(
      [
        { country: 'NO', vat_rate: null, mode: 'swedish' },
        { country: 'DE', vat_rate: 19, mode: 'swedish' },
      ],
      BAS_CHART,
    )
    expect(problems.map((p) => [p.index, p.code])).toEqual([
      [0, 'swedish_outside_eu'],
      [1, 'swedish_rate'],
    ])
  })
})

describe('vatAccountInSwedishDeclaration', () => {
  it('reads the BAS ruta map, an override and the clearing account', () => {
    expect(vatAccountInSwedishDeclaration({ account_number: '2611', vat_box: null })).toBe(true)
    expect(vatAccountInSwedishDeclaration({ account_number: '2699', vat_box: '30' })).toBe(true)
    expect(vatAccountInSwedishDeclaration({ account_number: '2650', vat_box: null })).toBe(true)
    expect(vatAccountInSwedishDeclaration({ account_number: '2670', vat_box: null })).toBe(false)
  })
})

describe('ossRevenueAccounts', () => {
  it('lists the sales accounts of EU rules that cover VAT', () => {
    expect(
      ossRevenueAccounts([
        ...OSS_PRESET_RULES,
        accounts('DE', null, '3013', '2674'),
        accounts('EU', 0, '3108', null),
        { country: 'DK', vat_rate: null, mode: 'swedish' },
      ]),
    ).toEqual(['3106', '3013'])
  })
})
