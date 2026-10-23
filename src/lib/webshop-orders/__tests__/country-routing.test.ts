import { describe, it, expect } from 'vitest'
import {
  NO_OSS_PRESET_RULES,
  OSS_PRESET_RULES,
  isDestinationUnknown,
  resolveCountryRule,
  routeOrderBuckets,
  routedCountryOf,
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
  })
})
