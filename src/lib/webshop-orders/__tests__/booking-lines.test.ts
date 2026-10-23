import { describe, it, expect } from 'vitest'
import {
  buildOrderBookingLines,
  fallbackVatBreakdown,
  orderBookingDescription,
  resolveBookingWarnings,
  resolvePaymentAccount,
  DEFAULT_PAYMENT_ACCOUNT,
  WEBSHOP_PREFILL_ACCOUNTS,
} from '../booking-lines'
import type { CreateJournalEntryLineInput, WebshopStoreSettings } from '@/types'

import { roundOre as round } from '@/lib/money'

function sumDebits(lines: CreateJournalEntryLineInput[]): number {
  return round(lines.reduce((sum, l) => sum + l.debit_amount, 0))
}
function sumCredits(lines: CreateJournalEntryLineInput[]): number {
  return round(lines.reduce((sum, l) => sum + l.credit_amount, 0))
}
function lineFor(lines: CreateJournalEntryLineInput[], account: string) {
  return lines.find((l) => l.account_number === account)
}

const settings: WebshopStoreSettings = {
  id: 's1',
  company_id: 'c1',
  user_id: 'u1',
  platform: 'woocommerce',
  store_scope: 'butik.example.se',
  payment_method_account_map: {
    swish: { mode: 'book', account: '1930' },
    klarna_payments: { mode: 'book', account: '1580' },
    bacs: { mode: 'invoice' },
  },
  country_account_rules: [],
  created_at: '',
  updated_at: '',
}

function makeOrder(overrides: Record<string, unknown> = {}) {
  return {
    row_type: 'order' as const,
    order_number: '1042',
    payment_method: 'swish',
    payment_method_title: 'Swish',
    currency: 'SEK',
    total: 500,
    total_tax: 100,
    total_sek: 500,
    exchange_rate: 1,
    vat_breakdown: [{ rate: 25, net: 400, tax: 100 }],
    ...overrides,
  }
}

describe('resolvePaymentAccount', () => {
  it('resolves a mapped book-mode account', () => {
    expect(resolvePaymentAccount(makeOrder(), settings)).toEqual({
      account: '1930',
      invoiceMode: false,
      mapped: true,
    })
  })

  it('flags invoice-mode methods', () => {
    const result = resolvePaymentAccount(makeOrder({ payment_method: 'bacs' }), settings)
    expect(result.invoiceMode).toBe(true)
  })

  it('falls back to the 1686 clearing account when unmapped or without settings', () => {
    expect(resolvePaymentAccount(makeOrder({ payment_method: 'stripe' }), settings).account).toBe(
      DEFAULT_PAYMENT_ACCOUNT,
    )
    expect(resolvePaymentAccount(makeOrder(), null).account).toBe(DEFAULT_PAYMENT_ACCOUNT)
    expect(resolvePaymentAccount(makeOrder({ payment_method: null }), settings).mapped).toBe(false)
  })

  it('defaults to BAS 1686, the card/PSP receivable, not the 1680 parent', () => {
    expect(DEFAULT_PAYMENT_ACCOUNT).toBe('1686')
  })
})

describe('WEBSHOP_PREFILL_ACCOUNTS', () => {
  it('covers every account the builder can emit', () => {
    // Guards the ensure-accounts contract: an account the prefill emits but
    // this set omits would resurface as AccountsNotInChartError in booking.
    const emitted = new Set<string>()
    for (const rate of [25, 12, 6, 0]) {
      for (const lineSet of [
        buildOrderBookingLines({
          order: makeOrder({
            total: 100.01,
            total_tax: rate === 0 ? 0 : 20,
            vat_breakdown: [{ rate, net: 80, tax: rate === 0 ? 0 : 20 }],
          }),
          settings: null,
        }),
      ]) {
        for (const line of lineSet) emitted.add(line.account_number)
      }
    }
    for (const account of emitted) {
      expect(WEBSHOP_PREFILL_ACCOUNTS).toContain(account)
    }
    // The residual account is only reachable through rounding drift; assert
    // it explicitly so the set never silently loses it.
    expect(WEBSHOP_PREFILL_ACCOUNTS).toContain('3740')
    expect(WEBSHOP_PREFILL_ACCOUNTS).toContain('3004')
  })
})

describe('fallbackVatBreakdown', () => {
  it('infers 25/12/6 from the tax-to-net ratio', () => {
    expect(fallbackVatBreakdown(500, 100)).toEqual([{ rate: 25, net: 400, tax: 100 }])
    expect(fallbackVatBreakdown(112, 12)).toEqual([{ rate: 12, net: 100, tax: 12 }])
    expect(fallbackVatBreakdown(106, 6)).toEqual([{ rate: 6, net: 100, tax: 6 }])
  })

  it('returns a 0% bucket for tax-free totals', () => {
    expect(fallbackVatBreakdown(300, 0)).toEqual([{ rate: 0, net: 300, tax: 0 }])
  })

  it('falls back to a 25% bucket for unrecognizable mixes', () => {
    expect(fallbackVatBreakdown(500, 50)).toEqual([{ rate: 25, net: 450, tax: 50 }])
  })
})

describe('buildOrderBookingLines', () => {
  it('books a SEK 25% order: gross to mapped account, net to 3001, VAT to 2611', () => {
    const lines = buildOrderBookingLines({ order: makeOrder(), settings })
    expect(lines).toHaveLength(3)
    expect(lineFor(lines, '1930')).toMatchObject({ debit_amount: 500, credit_amount: 0 })
    expect(lineFor(lines, '3001')).toMatchObject({ debit_amount: 0, credit_amount: 400 })
    expect(lineFor(lines, '2611')).toMatchObject({ debit_amount: 0, credit_amount: 100 })
    expect(sumDebits(lines)).toBe(sumCredits(lines))
  })

  it('splits mixed VAT rates across 3001/3002/3003 + 2611/2621/2631', () => {
    const lines = buildOrderBookingLines({
      order: makeOrder({
        total: 723,
        total_tax: 87,
        total_sek: 723,
        vat_breakdown: [
          { rate: 25, net: 300, tax: 75 },
          { rate: 12, net: 100, tax: 12 },
          { rate: 6, net: 200, tax: 12 },
          { rate: 0, net: 24, tax: 0 },
        ],
      }),
      settings,
    })
    expect(lineFor(lines, '3001')?.credit_amount).toBe(300)
    expect(lineFor(lines, '3002')?.credit_amount).toBe(100)
    expect(lineFor(lines, '3003')?.credit_amount).toBe(200)
    expect(lineFor(lines, '3004')?.credit_amount).toBe(24)
    expect(lineFor(lines, '2611')?.credit_amount).toBe(75)
    expect(lineFor(lines, '2621')?.credit_amount).toBe(12)
    expect(lineFor(lines, '2631')?.credit_amount).toBe(12)
    expect(sumDebits(lines)).toBe(sumCredits(lines))
  })

  it('sends rounding residual to 3740 and stays balanced', () => {
    const lines = buildOrderBookingLines({
      order: makeOrder({
        total: 500.05,
        total_sek: 500.05,
        vat_breakdown: [{ rate: 25, net: 400, tax: 100 }],
      }),
      settings,
    })
    expect(lineFor(lines, '3740')?.credit_amount).toBe(0.05)
    expect(sumDebits(lines)).toBe(sumCredits(lines))
  })

  it('mirrors refund rows: credit the payment account, debit revenue and VAT', () => {
    const lines = buildOrderBookingLines({
      order: makeOrder({
        row_type: 'refund',
        total: -500,
        total_tax: -100,
        total_sek: -500,
        vat_breakdown: [{ rate: 25, net: 400, tax: 100 }],
      }),
      settings,
    })
    expect(lineFor(lines, '1930')).toMatchObject({ debit_amount: 0, credit_amount: 500 })
    expect(lineFor(lines, '3001')).toMatchObject({ debit_amount: 400, credit_amount: 0 })
    expect(lineFor(lines, '2611')).toMatchObject({ debit_amount: 100, credit_amount: 0 })
    expect(sumDebits(lines)).toBe(sumCredits(lines))
  })

  it('books non-SEK orders in SEK with currency metadata on money lines only', () => {
    const lines = buildOrderBookingLines({
      order: makeOrder({
        currency: 'EUR',
        total: 100,
        total_tax: 20,
        total_sek: 1153,
        exchange_rate: 11.53,
        vat_breakdown: [{ rate: 25, net: 80, tax: 20 }],
      }),
      settings,
    })
    const gross = lineFor(lines, '1930')
    expect(gross).toMatchObject({
      debit_amount: 1153,
      currency: 'EUR',
      amount_in_currency: 100,
      exchange_rate: 11.53,
    })
    expect(lineFor(lines, '3001')).toMatchObject({
      credit_amount: round(80 * 11.53),
      amount_in_currency: 80,
    })
    const rounding = lineFor(lines, '3740')
    if (rounding) expect(rounding.currency).toBeUndefined()
    expect(sumDebits(lines)).toBe(sumCredits(lines))
  })

  it('honors an explicit payment-account override from the dialog', () => {
    const lines = buildOrderBookingLines({
      order: makeOrder(),
      settings,
      paymentAccount: '1686',
    })
    expect(lineFor(lines, '1686')?.debit_amount).toBe(500)
  })

  it('uses the fallback breakdown when the sync produced none', () => {
    const lines = buildOrderBookingLines({
      order: makeOrder({ vat_breakdown: [] }),
      settings,
    })
    expect(lineFor(lines, '3001')?.credit_amount).toBe(400)
    expect(lineFor(lines, '2611')?.credit_amount).toBe(100)
    expect(sumDebits(lines)).toBe(sumCredits(lines))
  })

  it('books a NEGATIVE discount bucket on the opposite side, never abs-flipped', () => {
    // Gift-card/discount plugin: 25% product 500+125, 0% discount -100.
    // The old abs() logic booked C 3004 100 + D 3740 200: balanced, wrong.
    const lines = buildOrderBookingLines({
      order: makeOrder({
        total: 525,
        total_tax: 125,
        total_sek: 525,
        vat_breakdown: [
          { rate: 25, net: 500, tax: 125 },
          { rate: 0, net: -100, tax: 0 },
        ],
      }),
      settings,
    })
    expect(lineFor(lines, '1930')).toMatchObject({ debit_amount: 525 })
    expect(lineFor(lines, '3001')).toMatchObject({ credit_amount: 500 })
    expect(lineFor(lines, '2611')).toMatchObject({ credit_amount: 125 })
    expect(lineFor(lines, '3004')).toMatchObject({ debit_amount: 100, credit_amount: 0 })
    expect(lineFor(lines, '3740')).toBeUndefined()
    expect(sumDebits(lines)).toBe(sumCredits(lines))
  })

  it('routes revenue per rate through a revenue template, VAT untouched', () => {
    const lines = buildOrderBookingLines({
      order: makeOrder({
        total: 612,
        total_tax: 87,
        total_sek: 612,
        vat_breakdown: [
          { rate: 25, net: 300, tax: 75 },
          { rate: 12, net: 100, tax: 12 },
          { rate: 6, net: 100, tax: 6 },
          { rate: 0, net: 19, tax: 0 },
        ],
      }),
      settings,
      revenueAccounts: { 25: '3041', 12: '3042', 6: '3043', 0: '3100' },
    })
    expect(lineFor(lines, '3041')?.credit_amount).toBe(300)
    expect(lineFor(lines, '3042')?.credit_amount).toBe(100)
    expect(lineFor(lines, '3043')?.credit_amount).toBe(100)
    expect(lineFor(lines, '3100')?.credit_amount).toBe(19)
    // The default accounts must not appear when every rate is templated.
    for (const account of ['3001', '3002', '3003', '3004']) {
      expect(lineFor(lines, account)).toBeUndefined()
    }
    // VAT accounts are always derived from the rate, never templated.
    expect(lineFor(lines, '2611')?.credit_amount).toBe(75)
    expect(lineFor(lines, '2621')?.credit_amount).toBe(12)
    expect(lineFor(lines, '2631')?.credit_amount).toBe(6)
    expect(sumDebits(lines)).toBe(sumCredits(lines))
  })

  it('falls back to the default revenue account for rates not in the template', () => {
    const lines = buildOrderBookingLines({
      order: makeOrder({
        total: 537,
        total_tax: 87,
        total_sek: 537,
        vat_breakdown: [
          { rate: 25, net: 300, tax: 75 },
          { rate: 12, net: 100, tax: 12 },
        ],
      }),
      settings,
      revenueAccounts: { 25: '3041' },
    })
    expect(lineFor(lines, '3041')?.credit_amount).toBe(300)
    expect(lineFor(lines, '3002')?.credit_amount).toBe(100)
    expect(sumDebits(lines)).toBe(sumCredits(lines))
  })

  it('mirrors refunds through the revenue template (debit the chosen account)', () => {
    const lines = buildOrderBookingLines({
      order: makeOrder({
        row_type: 'refund',
        total: -500,
        total_tax: -100,
        total_sek: -500,
        vat_breakdown: [{ rate: 25, net: 400, tax: 100 }],
      }),
      settings,
      revenueAccounts: { 25: '3041' },
    })
    expect(lineFor(lines, '1930')).toMatchObject({ debit_amount: 0, credit_amount: 500 })
    expect(lineFor(lines, '3041')).toMatchObject({ debit_amount: 400, credit_amount: 0 })
    expect(lineFor(lines, '2611')).toMatchObject({ debit_amount: 100, credit_amount: 0 })
    expect(sumDebits(lines)).toBe(sumCredits(lines))
  })

  it('throws when a non-SEK order has no resolved SEK amount', () => {
    expect(() =>
      buildOrderBookingLines({
        order: makeOrder({ currency: 'EUR', total_sek: null, exchange_rate: null }),
        settings,
      }),
    ).toThrow(/exchange rate/i)
  })
})

describe('buildOrderBookingLines with country rules (crm#1032)', () => {
  const shopifySettings: WebshopStoreSettings = {
    ...settings,
    platform: 'shopify',
    store_scope: 'minbutik.myshopify.com',
    payment_method_account_map: {},
    country_account_rules: [
      { country: 'EU', vat_rate: null, mode: 'accounts', revenue_account: '3106', vat_account: '2670' },
      { country: 'NON_EU', vat_rate: 0, mode: 'accounts', revenue_account: '3105', vat_account: null },
    ],
  }
  const toCountry = (customer_country: string, overrides: Record<string, unknown> = {}) => ({
    ...makeOrder({ payment_method: 'shopify_payments', ...overrides }),
    platform: 'shopify',
    customer_country,
  })

  it('books each bucket of an order shipped abroad on the rule\'s accounts', () => {
    const lines = buildOrderBookingLines({
      order: toCountry('DE', {
        total: 160,
        total_sek: 160,
        total_tax: 21,
        vat_breakdown: [
          { rate: 19, net: 100, tax: 19 },
          { rate: 7, net: 39, tax: 2 },
        ],
      }),
      settings: shopifySettings,
    })
    expect(lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])).toEqual([
      ['1686', 160, 0],
      ['3106', 0, 100],
      ['2670', 0, 19],
      ['3106', 0, 39],
      ['2670', 0, 2],
    ])
    expect(sumDebits(lines)).toBe(sumCredits(lines))
  })

  it('never applies the revenue template to a bucket a rule books', () => {
    const lines = buildOrderBookingLines({
      order: toCountry('DK'),
      settings: shopifySettings,
      revenueAccounts: { 25: '3011' },
    })
    expect(lineFor(lines, '3011')).toBeUndefined()
    expect(lineFor(lines, '3106')?.credit_amount).toBe(400)
  })

  it('keeps the Swedish prefill for a bucket no rule covers, for the user to change', () => {
    // Norway at 25 %: only the 0 % export rule exists.
    const lines = buildOrderBookingLines({ order: toCountry('NO'), settings: shopifySettings })
    expect(lineFor(lines, '3001')?.credit_amount).toBe(400)
    expect(lineFor(lines, '2611')?.credit_amount).toBe(100)
  })

  it('books a VAT-free order outside the EU as export without a VAT line', () => {
    const lines = buildOrderBookingLines({
      order: toCountry('US', { total_tax: 0, vat_breakdown: [{ rate: 0, net: 500, tax: 0 }] }),
      settings: shopifySettings,
    })
    expect(lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])).toEqual([
      ['1686', 500, 0],
      ['3105', 0, 500],
    ])
  })

  it('ignores the rules for a WooCommerce order (billing country)', () => {
    const lines = buildOrderBookingLines({
      order: makeOrder({ platform: 'woocommerce', customer_country: 'DK' }),
      settings: { ...shopifySettings, platform: 'woocommerce' },
    })
    expect(lineFor(lines, '3001')?.credit_amount).toBe(400)
  })

  it('drops the advisories a rule answers', () => {
    const zeroRateUs = toCountry('US', { total_tax: 0, vat_breakdown: [{ rate: 0, net: 500, tax: 0 }] })
    expect(resolveBookingWarnings(zeroRateUs)).toEqual(['country_not_routed', 'zero_rate_foreign'])
    expect(resolveBookingWarnings(zeroRateUs, shopifySettings)).toEqual([])
    const eurDk = toCountry('DK', { currency: 'EUR' })
    expect(resolveBookingWarnings(eurDk)).toEqual(['country_not_routed', 'foreign_vat'])
    expect(resolveBookingWarnings(eurDk, shopifySettings)).toEqual([])
  })

  it('warns first when a bucket of an order shipped abroad has no rule', () => {
    // Norway at 25 % in SEK: no currency or 0 % hint would fire, so without
    // this the dialog would show Swedish accounts in silence.
    expect(resolveBookingWarnings(toCountry('NO'), shopifySettings)).toEqual(['country_not_routed'])
  })

  it('warns about an order without a VAT breakdown the same as the prefill books it', () => {
    // No breakdown from the store: the prefill books the ratio-inferred 25 %
    // bucket on 3001/2611, so the warning must route that bucket too.
    const noSplit = toCountry('NO', { vat_breakdown: [] })
    const lines = buildOrderBookingLines({ order: noSplit, settings: shopifySettings })
    expect(lineFor(lines, '3001')?.credit_amount).toBe(400)
    expect(lineFor(lines, '2611')?.credit_amount).toBe(100)
    expect(resolveBookingWarnings(noSplit, shopifySettings)).toEqual(['country_not_routed'])
    expect(resolveBookingWarnings(noSplit)).toEqual(['country_not_routed'])

    // The inferred bucket a rule covers books on the rule's accounts: no hint.
    const dkNoSplit = toCountry('DK', { vat_breakdown: [] })
    expect(lineFor(buildOrderBookingLines({ order: dkNoSplit, settings: shopifySettings }), '3106')?.credit_amount).toBe(400)
    expect(resolveBookingWarnings(dkNoSplit, shopifySettings)).toEqual([])
  })

  it('flags a 0 % prefill on an order without a breakdown shipped abroad', () => {
    const usNoSplit = toCountry('US', { total_tax: 0, vat_breakdown: [] })
    // Prefilled on 3004 without rules: both hints apply.
    expect(lineFor(buildOrderBookingLines({ order: usNoSplit }), '3004')?.credit_amount).toBe(500)
    expect(resolveBookingWarnings(usNoSplit)).toEqual(['country_not_routed', 'zero_rate_foreign'])
    // The export rule books it on 3105: neither applies.
    expect(resolveBookingWarnings(usNoSplit, shopifySettings)).toEqual([])
  })

  it('keeps foreign_vat on a non-SEK order without a breakdown even when a rule routes it', () => {
    // The rate is inferred, so the user must check it whatever account it lands on.
    const eurDkNoSplit = toCountry('DK', { currency: 'EUR', vat_breakdown: [] })
    expect(resolveBookingWarnings(eurDkNoSplit, shopifySettings)).toEqual(['foreign_vat'])
  })

  describe('order without a destination country', () => {
    const noCountry = (overrides: Record<string, unknown> = {}) => ({
      ...makeOrder({ payment_method: 'shopify_payments', ...overrides }),
      platform: 'shopify',
      customer_country: null,
    })

    it('warns when the store has country rules, and still prefills the Swedish accounts', () => {
      const order = noCountry()
      expect(resolveBookingWarnings(order, shopifySettings)).toEqual(['country_unknown'])
      const lines = buildOrderBookingLines({ order, settings: shopifySettings })
      expect(lineFor(lines, '3001')?.credit_amount).toBe(400)
      expect(lineFor(lines, '2611')?.credit_amount).toBe(100)
    })

    it('ranks the unknown country before the currency hint', () => {
      expect(resolveBookingWarnings(noCountry({ currency: 'EUR' }), shopifySettings)).toEqual([
        'country_unknown',
        'foreign_vat',
      ])
    })

    it('also warns for an order without a breakdown', () => {
      expect(resolveBookingWarnings(noCountry({ vat_breakdown: [] }), shopifySettings)).toEqual([
        'country_unknown',
      ])
    })

    it('stays quiet for a store without rules or another platform', () => {
      expect(resolveBookingWarnings(noCountry())).toEqual([])
      expect(resolveBookingWarnings(noCountry(), { country_account_rules: [] })).toEqual([])
      expect(
        resolveBookingWarnings({ ...noCountry(), platform: 'woocommerce' }, shopifySettings),
      ).toEqual([])
    })
  })
})

describe('resolveBookingWarnings', () => {
  it('flags a 0%-amount to a known non-SE country', () => {
    expect(
      resolveBookingWarnings({
        currency: 'SEK',
        total: 2000,
        total_tax: 0,
        vat_breakdown: [{ rate: 0, net: 2000, tax: 0 }],
        customer_country: 'NO',
      }),
    ).toEqual(['zero_rate_foreign'])
  })

  it('stays quiet for domestic momsfri and unknown countries', () => {
    expect(
      resolveBookingWarnings({
        currency: 'SEK',
        total: 2000,
        total_tax: 0,
        vat_breakdown: [{ rate: 0, net: 2000, tax: 0 }],
        customer_country: 'SE',
      }),
    ).toEqual([])
    expect(
      resolveBookingWarnings({
        currency: 'SEK',
        total: 2000,
        total_tax: 0,
        vat_breakdown: [{ rate: 0, net: 2000, tax: 0 }],
        customer_country: null,
      }),
    ).toEqual([])
  })

  it('flags VAT charged on a non-SEK order (OSS check)', () => {
    expect(
      resolveBookingWarnings({
        currency: 'EUR',
        total: 100,
        total_tax: 20,
        vat_breakdown: [{ rate: 25, net: 80, tax: 20 }],
        customer_country: 'DK',
      }),
    ).toEqual(['foreign_vat'])
  })
})

describe('orderBookingDescription', () => {
  it('labels an order with its payment method', () => {
    expect(
      orderBookingDescription({
        row_type: 'order',
        order_number: '1001',
        payment_method: 'swish',
        payment_method_title: 'Swish',
      }),
    ).toBe('Order 1001 (Swish)')
  })

  it('falls back to the raw method key, then to no method', () => {
    expect(
      orderBookingDescription({
        row_type: 'order',
        order_number: '1001',
        payment_method: 'swish',
        payment_method_title: null,
      }),
    ).toBe('Order 1001 (swish)')
    expect(
      orderBookingDescription({
        row_type: 'order',
        order_number: '1001',
        payment_method: null,
        payment_method_title: null,
      }),
    ).toBe('Order 1001')
  })

  it('labels refunds without the method', () => {
    expect(
      orderBookingDescription({
        row_type: 'refund',
        order_number: '1001',
        payment_method: 'swish',
        payment_method_title: 'Swish',
      }),
    ).toBe('Återbetalning order 1001')
  })
})
