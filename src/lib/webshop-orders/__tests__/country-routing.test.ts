import { describe, it, expect } from 'vitest'
import {
  NO_OSS_PRESET_RULES,
  OSS_PRESET_RULES,
  alternativeAccountFor,
  isDestinationUnknown,
  isEuRuleCountry,
  isOssRule,
  presetAccountsFor,
  resolveCountryRule,
  routeOrderBuckets,
  routedCountryOf,
  sameCountryRules,
  servicesRevenueAccountOf,
  usesRevenueTemplate,
  usesSwedishAccounts,
} from '../country-routing'
import type { WebshopCountryAccountRule } from '@/types'

const shopify = (customer_country: string | null) => ({ platform: 'shopify' as const, customer_country })

const NO_VOEC: WebshopCountryAccountRule = {
  country: 'NO',
  vat_rate: 25,
  mode: 'accounts',
  revenue_account: '3105',
  vat_account: '2890',
}
const DE_OWN: WebshopCountryAccountRule = {
  country: 'DE',
  vat_rate: null,
  mode: 'accounts',
  revenue_account: '3013',
  vat_account: '2674',
}

describe('routedCountryOf', () => {
  it('applies to a Shopify order shipped to a known country outside Sweden', () => {
    expect(routedCountryOf(shopify('dk'))).toBe('DK')
  })

  it('does not apply to Sweden, a missing country or another platform', () => {
    expect(routedCountryOf(shopify('SE'))).toBeNull()
    expect(routedCountryOf(shopify(null))).toBeNull()
    expect(routedCountryOf(shopify('  '))).toBeNull()
    // WooCommerce stores the billing country, not where the goods went.
    expect(routedCountryOf({ platform: 'woocommerce', customer_country: 'DK' })).toBeNull()
  })
})

describe('isDestinationUnknown', () => {
  it('is unknown when a store with country rules sends a Shopify order without a country', () => {
    // Withheld addresses, a local pickup, or a row synced before the country
    // was stored: the store sells abroad, so this is not "Sweden".
    expect(isDestinationUnknown(shopify(null), OSS_PRESET_RULES)).toBe(true)
    expect(isDestinationUnknown(shopify('  '), NO_OSS_PRESET_RULES)).toBe(true)
  })

  it('keeps today\'s Swedish booking for a store without rules', () => {
    expect(isDestinationUnknown(shopify(null), [])).toBe(false)
    expect(isDestinationUnknown(shopify(null), null)).toBe(false)
    expect(isDestinationUnknown(shopify(null), undefined)).toBe(false)
  })

  it('is never unknown for an order with a country or from another platform', () => {
    expect(isDestinationUnknown(shopify('SE'), OSS_PRESET_RULES)).toBe(false)
    expect(isDestinationUnknown(shopify('DK'), OSS_PRESET_RULES)).toBe(false)
    expect(isDestinationUnknown({ platform: 'woocommerce', customer_country: null }, OSS_PRESET_RULES)).toBe(false)
  })
})

describe('resolveCountryRule', () => {
  const rules = [...OSS_PRESET_RULES, NO_VOEC, DE_OWN]

  it('prefers the country\'s own rule over the catch-all', () => {
    expect(resolveCountryRule(rules, 'DE', 19)).toBe(DE_OWN)
    expect(resolveCountryRule(rules, 'DK', 25)).toBe(OSS_PRESET_RULES[0])
  })

  it('prefers an exact rate over "every rate with VAT"', () => {
    const reduced: WebshopCountryAccountRule = { ...DE_OWN, vat_rate: 7, revenue_account: '3014' }
    expect(resolveCountryRule([...rules, reduced], 'DE', 7)).toBe(reduced)
    expect(resolveCountryRule([...rules, reduced], 'DE', 19)).toBe(DE_OWN)
  })

  it('matches decimal rates such as Finland\'s 25.5 %', () => {
    const fi: WebshopCountryAccountRule = { ...DE_OWN, country: 'FI', vat_rate: 25.5 }
    expect(resolveCountryRule([fi], 'FI', 25.5)).toBe(fi)
  })

  it('never lets "every rate with VAT" cover a 0 % bucket', () => {
    // A VAT-free sale to another EU country (B2B) is not an OSS sale.
    expect(resolveCountryRule(OSS_PRESET_RULES, 'DE', 0)).toBeNull()
  })

  it('sends a country outside the EU to the NON_EU catch-all', () => {
    expect(resolveCountryRule(rules, 'US', 0)).toBe(OSS_PRESET_RULES[1])
    // The 0 % export rule does not cover Norway's VOEC VAT; Norway's own rule does.
    expect(resolveCountryRule(OSS_PRESET_RULES, 'NO', 25)).toBeNull()
    expect(resolveCountryRule(rules, 'NO', 25)).toBe(NO_VOEC)
  })
})

describe('routeOrderBuckets', () => {
  it('routes every bucket of a covered order and reports none unrouted', () => {
    const routing = routeOrderBuckets(
      shopify('DE'),
      [
        { rate: 19, net: 100, tax: 19 },
        { rate: 7, net: 50, tax: 3.5 },
      ],
      OSS_PRESET_RULES,
    )
    expect(routing.country).toBe('DE')
    expect(routing.unroutedRates).toEqual([])
    expect(routing.buckets.every((route) => route.rule === OSS_PRESET_RULES[0])).toBe(true)
  })

  it('reports the rates no rule covers', () => {
    const routing = routeOrderBuckets(
      shopify('NO'),
      [
        { rate: 25, net: 100, tax: 25 },
        { rate: 0, net: 40, tax: 0 },
      ],
      OSS_PRESET_RULES,
    )
    expect(routing.unroutedRates).toEqual([25])
    expect(routing.buckets[0].rule).toBeNull()
    expect(routing.buckets[1].rule).toBe(OSS_PRESET_RULES[1])
  })

  it('does not route a bucket with tax to a rule without a VAT account', () => {
    const zeroRateOnly: WebshopCountryAccountRule = {
      country: 'US',
      vat_rate: 10,
      mode: 'accounts',
      revenue_account: '3105',
      vat_account: null,
    }
    const routing = routeOrderBuckets(shopify('US'), [{ rate: 10, net: 100, tax: 10 }], [zeroRateOnly])
    expect(routing.unroutedRates).toEqual([10])
  })

  it('keeps an order the rules do not apply to on the Swedish accounts', () => {
    const routing = routeOrderBuckets(shopify('SE'), [{ rate: 25, net: 100, tax: 25 }], OSS_PRESET_RULES)
    expect(routing.country).toBeNull()
    expect(routing.unroutedRates).toEqual([])
    expect(routing.destinationUnknown).toBe(false)
    expect(routing.buckets.every(usesSwedishAccounts)).toBe(true)
  })

  it('reports an order without a country as unknown only when the store has rules', () => {
    const breakdown = [{ rate: 25, net: 100, tax: 25 }]
    const withRules = routeOrderBuckets(shopify(null), breakdown, OSS_PRESET_RULES)
    expect(withRules.country).toBeNull()
    expect(withRules.unroutedRates).toEqual([])
    expect(withRules.destinationUnknown).toBe(true)
    // The prefill still shows the Swedish accounts for the user to change.
    expect(withRules.buckets.every(usesSwedishAccounts)).toBe(true)

    expect(routeOrderBuckets(shopify(null), breakdown, []).destinationUnknown).toBe(false)
    expect(routeOrderBuckets(shopify('DE'), breakdown, OSS_PRESET_RULES).destinationUnknown).toBe(false)
  })

  it('treats a "Swedish VAT" rule as the Swedish accounts', () => {
    const routing = routeOrderBuckets(shopify('DK'), [{ rate: 25, net: 100, tax: 25 }], NO_OSS_PRESET_RULES)
    expect(routing.unroutedRates).toEqual([])
    expect(usesSwedishAccounts(routing.buckets[0])).toBe(true)
    expect(usesRevenueTemplate(routing.buckets[0])).toBe(true)
  })

  it('keeps the revenue template off a "Swedish VAT" rule with its own account (crm#1449)', () => {
    const rules: WebshopCountryAccountRule[] = [{ country: 'EU', vat_rate: null, mode: 'swedish', revenue_account: '3012' }]
    const routing = routeOrderBuckets(shopify('DK'), [{ rate: 25, net: 100, tax: 25 }], rules)
    expect(usesSwedishAccounts(routing.buckets[0])).toBe(true)
    expect(usesRevenueTemplate(routing.buckets[0])).toBe(false)
    expect(usesRevenueTemplate({ bucket: routing.buckets[0].bucket, rule: null })).toBe(true)
  })
})

describe('an order with nothing to ship (#88)', () => {
  const digital = (customer_country: string | null) => ({ ...shopify(customer_country), ships_nothing: true })
  const EU_ZERO_GOODS: WebshopCountryAccountRule = {
    country: 'EU',
    vat_rate: 0,
    mode: 'accounts',
    revenue_account: '3108',
    vat_account: null,
  }

  it('maps the goods accounts of a sale abroad to the services accounts and leaves the rest', () => {
    expect(servicesRevenueAccountOf('3105')).toBe('3305')
    expect(servicesRevenueAccountOf('3108')).toBe('3308')
    expect(servicesRevenueAccountOf('3106')).toBe('3106')
    expect(servicesRevenueAccountOf('3013')).toBe('3013')
  })

  it('books a VAT-free sale outside the EU on 3305 (ruta 40), not as export of goods on 3105', () => {
    const routing = routeOrderBuckets(digital('US'), [{ rate: 0, net: 100, tax: 0 }], OSS_PRESET_RULES)
    expect(routing.unroutedRates).toEqual([])
    expect(routing.buckets[0].rule).toEqual({ ...OSS_PRESET_RULES[1], revenue_account: '3305' })
    // The store's saved rule is not changed.
    expect(OSS_PRESET_RULES[1]).toMatchObject({ revenue_account: '3105' })
  })

  it('keeps export of goods on 3105 for an order that ships, or that does not say', () => {
    const breakdown = [{ rate: 0, net: 100, tax: 0 }]
    expect(routeOrderBuckets(shopify('US'), breakdown, OSS_PRESET_RULES).buckets[0].rule).toBe(OSS_PRESET_RULES[1])
    expect(
      routeOrderBuckets({ ...shopify('US'), ships_nothing: false }, breakdown, OSS_PRESET_RULES).buckets[0].rule,
    ).toBe(OSS_PRESET_RULES[1])
  })

  it('keeps OSS on 3106/2670 for an EU sale with VAT', () => {
    const routing = routeOrderBuckets(digital('DE'), [{ rate: 19, net: 100, tax: 19 }], OSS_PRESET_RULES)
    expect(routing.buckets[0].rule).toBe(OSS_PRESET_RULES[0])
  })

  it('books a VAT-free EU sale a rule puts on 3108 (ruta 35) on 3308 (ruta 39)', () => {
    const routing = routeOrderBuckets(digital('DE'), [{ rate: 0, net: 100, tax: 0 }], [EU_ZERO_GOODS])
    expect(routing.buckets[0].rule).toEqual({ ...EU_ZERO_GOODS, revenue_account: '3308' })
  })

  it('books a Norwegian VOEC sale on 3305 with its VAT account unchanged', () => {
    const routing = routeOrderBuckets(digital('NO'), [{ rate: 25, net: 100, tax: 25 }], [NO_VOEC])
    expect(routing.buckets[0].rule).toEqual({ ...NO_VOEC, revenue_account: '3305' })
  })

  it("keeps a rule's own account and a Sverige row as they are", () => {
    expect(routeOrderBuckets(digital('DE'), [{ rate: 19, net: 100, tax: 19 }], [DE_OWN]).buckets[0].rule).toBe(DE_OWN)
    const sweden: WebshopCountryAccountRule = { country: 'SE', vat_rate: null, mode: 'swedish', revenue_account: '3011' }
    expect(routeOrderBuckets(digital('SE'), [{ rate: 25, net: 100, tax: 25 }], [sweden]).buckets[0].rule).toBe(sweden)
  })
})

describe('a Sverige row (crm#1449)', () => {
  const SE_OWN: WebshopCountryAccountRule = { country: 'SE', vat_rate: null, mode: 'swedish', revenue_account: '3011' }
  // The rules the reporting store saved (Swedish VAT on EU sales, export
  // outside the EU) plus the Sverige row it asked for.
  const STORE_RULES: WebshopCountryAccountRule[] = [
    { country: 'EU', vat_rate: null, mode: 'swedish', revenue_account: '3011' },
    OSS_PRESET_RULES[1],
    SE_OWN,
  ]
  const order25 = [{ rate: 25, net: 75.6, tax: 18.9 }]

  it("books an order to Sweden on the store's own sales account", () => {
    const routing = routeOrderBuckets(shopify('SE'), order25, STORE_RULES)
    expect(routing.country).toBe('SE')
    expect(routing.unroutedRates).toEqual([])
    expect(routing.destinationUnknown).toBe(false)
    expect(routing.buckets[0].rule).toBe(SE_OWN)
    expect(usesSwedishAccounts(routing.buckets[0])).toBe(true)
    expect(usesRevenueTemplate(routing.buckets[0])).toBe(false)
  })

  it('never lets the EU catch-all book an order to Sweden', () => {
    // isEuMemberCountry counts Sweden as a member; the OSS preset must not take it.
    expect(resolveCountryRule(OSS_PRESET_RULES, 'SE', 25)).toBeNull()
    expect(resolveCountryRule(NO_OSS_PRESET_RULES, 'SE', 25)).toBeNull()
    const routing = routeOrderBuckets(shopify('SE'), order25, NO_OSS_PRESET_RULES)
    expect(routing.country).toBeNull()
    expect(routing.buckets[0].rule).toBeNull()
  })

  it('keeps a rate the row does not cover on the default Swedish accounts, never unrouted', () => {
    const se25: WebshopCountryAccountRule = { country: 'SE', vat_rate: 25, mode: 'swedish', revenue_account: '3011' }
    const routing = routeOrderBuckets(
      shopify('se'),
      [
        { rate: 25, net: 100, tax: 25 },
        { rate: 12, net: 50, tax: 6 },
        { rate: 0, net: 20, tax: 0 },
      ],
      [se25],
    )
    expect(routing.country).toBe('SE')
    expect(routing.unroutedRates).toEqual([])
    expect(routing.buckets.map((route) => route.rule)).toEqual([se25, null, null])
  })

  it('books an order without a country on the row: it books as Swedish', () => {
    // Only the row: the store has said nothing about abroad, so the order is Swedish.
    const domestic = routeOrderBuckets(shopify(null), order25, [SE_OWN])
    expect(domestic.destinationUnknown).toBe(false)
    expect(domestic.buckets[0].rule).toBe(SE_OWN)
    // With rules for abroad it stays unknown (the sweep refuses it); the
    // dialog's editable guess is still the store's Swedish booking.
    const sellsAbroad = routeOrderBuckets(shopify(null), order25, STORE_RULES)
    expect(sellsAbroad.destinationUnknown).toBe(true)
    expect(sellsAbroad.buckets[0].rule).toBe(SE_OWN)
  })

  it('ignores a Sverige row that is not Swedish VAT, and another platform', () => {
    // The settings route refuses such a row: a sale in Sweden never books on own accounts.
    const seAccounts: WebshopCountryAccountRule = {
      country: 'SE',
      vat_rate: null,
      mode: 'accounts',
      revenue_account: '3106',
      vat_account: '2670',
    }
    const routing = routeOrderBuckets(shopify('SE'), order25, [seAccounts])
    expect(routing.country).toBeNull()
    expect(routing.buckets[0].rule).toBeNull()
    expect(routeOrderBuckets({ platform: 'woocommerce', customer_country: 'SE' }, order25, [SE_OWN]).buckets[0].rule).toBeNull()
  })

  it('is not a rule for abroad: neither EU, OSS nor a preset', () => {
    expect(isDestinationUnknown(shopify(null), [SE_OWN])).toBe(false)
    expect(isEuRuleCountry('SE')).toBe(false)
    expect(isEuRuleCountry('DK')).toBe(true)
    expect(isOssRule(SE_OWN)).toBe(false)
    expect(presetAccountsFor('SE', null)).toEqual({ revenue: null, vat: null })
    expect(presetAccountsFor('SE', 25)).toEqual({ revenue: null, vat: null })
  })
})

describe('sameCountryRules', () => {
  // What Postgres jsonb hands back for the OSS preset plus a Swedish row:
  // keys sorted by length (mode, country, vat_rate, vat_account,
  // revenue_account), not the order the form writes them in.
  const FROM_JSONB = JSON.parse(
    '[{"mode": "accounts", "country": "EU", "vat_rate": null, "vat_account": "2670", "revenue_account": "3106"}, ' +
      '{"mode": "accounts", "country": "NON_EU", "vat_rate": 0, "vat_account": null, "revenue_account": "3105"}, ' +
      '{"mode": "swedish", "country": "FI", "vat_rate": 25.5}]',
  ) as WebshopCountryAccountRule[]
  const FROM_FORM: WebshopCountryAccountRule[] = [
    ...OSS_PRESET_RULES,
    { country: 'FI', vat_rate: 25.5, mode: 'swedish' },
  ]

  it('treats the stored rules and the form\'s copy of them as equal whatever the key order', () => {
    // The bug: the form compared with JSON.stringify and never saw these as equal.
    expect(JSON.stringify(FROM_JSONB)).not.toBe(JSON.stringify(FROM_FORM))
    expect(sameCountryRules(FROM_FORM, FROM_JSONB)).toBe(true)
    expect(sameCountryRules(FROM_JSONB, FROM_FORM)).toBe(true)
    expect(sameCountryRules([], [])).toBe(true)
  })

  it('reads a missing VAT account as none', () => {
    const withoutKey = JSON.parse(
      '[{"mode": "accounts", "country": "NON_EU", "vat_rate": 0, "revenue_account": "3105"}]',
    ) as WebshopCountryAccountRule[]
    expect(sameCountryRules([OSS_PRESET_RULES[1]], withoutKey)).toBe(true)
  })

  it('tells apart any change to a field, a mode, the count or the order', () => {
    const edited = (patch: Partial<Extract<WebshopCountryAccountRule, { mode: 'accounts' }>>) => [
      { ...(FROM_FORM[0] as Extract<WebshopCountryAccountRule, { mode: 'accounts' }>), ...patch },
      ...FROM_FORM.slice(1),
    ]
    expect(sameCountryRules(edited({ revenue_account: '3013' }), FROM_JSONB)).toBe(false)
    expect(sameCountryRules(edited({ vat_account: '2674' }), FROM_JSONB)).toBe(false)
    expect(sameCountryRules(edited({ vat_rate: 25 }), FROM_JSONB)).toBe(false)
    expect(sameCountryRules(edited({ country: 'DE' }), FROM_JSONB)).toBe(false)
    expect(
      sameCountryRules([{ country: 'EU', vat_rate: null, mode: 'swedish' }, ...FROM_FORM.slice(1)], FROM_JSONB),
    ).toBe(false)
    expect(sameCountryRules(FROM_FORM.slice(1), FROM_JSONB)).toBe(false)
    expect(sameCountryRules([...FROM_FORM].reverse(), FROM_JSONB)).toBe(false)
  })

  it("compares a 'swedish' rule's own revenue account, a missing one read as none", () => {
    const plain: WebshopCountryAccountRule[] = [{ country: 'EU', vat_rate: null, mode: 'swedish' }]
    const nullAccount: WebshopCountryAccountRule[] = [
      { country: 'EU', vat_rate: null, mode: 'swedish', revenue_account: null },
    ]
    const own: WebshopCountryAccountRule[] = [{ country: 'EU', vat_rate: null, mode: 'swedish', revenue_account: '3012' }]
    expect(sameCountryRules(plain, nullAccount)).toBe(true)
    expect(sameCountryRules(plain, own)).toBe(false)
    expect(sameCountryRules(own, [{ ...own[0] }])).toBe(true)
  })
})

describe('presetAccountsFor and alternativeAccountFor', () => {
  it('gives the OSS pair for the EU with VAT, export outside the EU, nothing for a 0 % EU sale', () => {
    expect(presetAccountsFor('EU', null)).toEqual({ revenue: '3106', vat: '2670' })
    expect(presetAccountsFor('DE', 19)).toEqual({ revenue: '3106', vat: '2670' })
    expect(presetAccountsFor('NON_EU', 0)).toEqual({ revenue: '3105', vat: null })
    expect(presetAccountsFor('NO', 25)).toEqual({ revenue: '3105', vat: null })
    expect(presetAccountsFor('EU', 0)).toEqual({ revenue: null, vat: null })
  })

  it('names the preset account instead of the refused one', () => {
    expect(alternativeAccountFor({ country: 'EU', vat_rate: null }, 'revenue_account', '3001')).toBe('3106')
    expect(alternativeAccountFor({ country: 'EU', vat_rate: null }, 'vat_account', '2611')).toBe('2670')
    expect(alternativeAccountFor({ country: 'NON_EU', vat_rate: 0 }, 'revenue_account', '3001')).toBe('3105')
  })

  it('never names the account that was refused', () => {
    expect(alternativeAccountFor({ country: 'EU', vat_rate: null }, 'revenue_account', '3106')).toBeNull()
    expect(alternativeAccountFor({ country: 'DK', vat_rate: 25 }, 'vat_account', '2670')).toBeNull()
    expect(alternativeAccountFor({ country: 'NON_EU', vat_rate: 0 }, 'revenue_account', '3105')).toBeNull()
  })

  it('names nothing where the presets have no account', () => {
    expect(alternativeAccountFor({ country: 'EU', vat_rate: 0 }, 'revenue_account', '3001')).toBeNull()
    expect(alternativeAccountFor({ country: 'NO', vat_rate: 25 }, 'vat_account', '2611')).toBeNull()
  })
})

describe('isOssRule', () => {
  it('is an EU country or the EU catch-all, with VAT', () => {
    expect(isOssRule({ country: 'EU', vat_rate: null })).toBe(true)
    expect(isOssRule({ country: 'FI', vat_rate: 25.5 })).toBe(true)
    expect(isOssRule({ country: 'EU', vat_rate: 0 })).toBe(false)
    expect(isOssRule({ country: 'NO', vat_rate: 25 })).toBe(false)
    expect(isOssRule({ country: 'NON_EU', vat_rate: null })).toBe(false)
  })
})
