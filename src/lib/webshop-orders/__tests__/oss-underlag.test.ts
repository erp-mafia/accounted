import { describe, expect, it } from 'vitest'
import type { EcbRateLookup } from '@/lib/currency/ecb'
import {
  classifyOssBookings,
  finalizeOssUnderlag,
  ossAccountsOf,
  ossDeadline,
  ossQuarterBounds,
  ossQuarterOf,
  ossRateNeeds,
  ruleVatAccountCountries,
  type OssAccountCountry,
  type OssClassifyInput,
  type OssEntry,
  type OssOrder,
} from '../oss-underlag'

const Q3 = { year: 2026, quarter: 3 }
const REVENUE = new Set(['3106'])
const VAT = new Set(['2670'])

/** A posted verifikat in Q3 booking `net` on 3106 and `vat` on 2670 (negative for a refund). */
function entry(id: string, overrides: Partial<OssEntry> & { net?: number; vat?: number } = {}): OssEntry {
  const { net = 1000, vat = 190, ...rest } = overrides
  const line = (account_number: string, value: number) =>
    value >= 0
      ? { account_number, debit_amount: 0, credit_amount: value }
      : { account_number, debit_amount: -value, credit_amount: 0 }
  return {
    id,
    voucher_series: 'A',
    voucher_number: Number(id.replace(/\D/g, '')) || 1,
    entry_date: '2026-08-15',
    description: `Order ${id}`,
    status: 'posted',
    reverses_id: null,
    correction_of_id: null,
    lines: [line('3106', net), line('2670', vat)],
    ...rest,
  }
}

function order(id: string, overrides: Partial<OssOrder> = {}): OssOrder {
  return {
    id,
    platform: 'shopify',
    row_type: 'order',
    parent_order_id: null,
    order_number: `#${id}`,
    customer_country: 'DE',
    currency: 'SEK',
    exchange_rate: 1,
    vat_breakdown: [{ rate: 19, net: 1000, tax: 190 }],
    journal_entry_id: null,
    manually_booked_journal_entry_id: null,
    manually_booked_at: null,
    invoice_id: null,
    legacy_transaction_id: null,
    is_paid: true,
    paid_date: '2026-08-15',
    order_date: '2026-08-15',
    ...overrides,
  }
}

function input(overrides: Partial<OssClassifyInput> = {}): OssClassifyInput {
  return {
    quarter: Q3,
    revenueAccounts: REVENUE,
    vatAccounts: VAT,
    entries: [],
    orders: [],
    parentBookingDates: new Map(),
    accountCountries: new Map(),
    linkedEntryDates: new Map(),
    quarterOrders: [],
    ...overrides,
  }
}

const SEK_Q3: [string, EcbRateLookup] = ['SEK|2026-09-30', { ok: true, rate: { currency: 'SEK', rate: 11.331, date: '2026-09-30' } }]
const SEK_Q2: [string, EcbRateLookup] = ['SEK|2026-06-30', { ok: true, rate: { currency: 'SEK', rate: 10.9, date: '2026-06-30' } }]
const EUR_Q3: [string, EcbRateLookup] = ['EUR|2026-09-30', { ok: true, rate: { currency: 'EUR', rate: 1, date: '2026-09-30' } }]

function underlag(classifyInput: OssClassifyInput, rates: Array<[string, EcbRateLookup]> = [SEK_Q3, SEK_Q2, EUR_Q3]) {
  return finalizeOssUnderlag(classifyInput.quarter, classifyOssBookings(classifyInput), new Map(rates))
}

describe('quarters', () => {
  it('bounds each quarter and names its deadline, the last day of the month after', () => {
    expect(ossQuarterBounds(2026, 1)).toEqual({ start: '2026-01-01', end: '2026-03-31' })
    expect(ossQuarterBounds(2026, 3)).toEqual({ start: '2026-07-01', end: '2026-09-30' })
    expect(ossQuarterBounds(2024, 4)).toEqual({ start: '2024-10-01', end: '2024-12-31' })
    expect(ossDeadline(2026, 1)).toBe('2026-04-30')
    expect(ossDeadline(2026, 3)).toBe('2026-10-31')
    expect(ossDeadline(2026, 4)).toBe('2027-01-31')
    expect(ossQuarterOf('2026-06-30')).toEqual({ year: 2026, quarter: 2 })
    expect(ossQuarterOf('2026-10-01')).toEqual({ year: 2026, quarter: 4 })
  })
})

describe('classifyOssBookings + finalizeOssUnderlag', () => {
  it('declares a booked order per country and rate, in euro at the ECB rate for the last day and in kronor as booked', () => {
    const result = underlag(input({
      entries: [entry('e1')],
      orders: [order('o1', { journal_entry_id: 'e1' })],
    }))

    expect(result.rows).toEqual([
      // 1000 / 11.331 = 88.2534…, 190 / 11.331 = 16.7681…: two decimals, never whole euro.
      { country: 'DE', vat_rate: 19, net_eur: 88.25, vat_eur: 16.77, net_sek: 1000, vat_sek: 190, order_count: 1, voucher_count: 0, rate_mismatch: false },
    ])
    expect(result.totals).toEqual({
      net_eur: 88.25,
      vat_eur: 16.77,
      corrections_vat_eur: 0,
      net_sek: 1000,
      vat_sek: 190,
      corrections_vat_sek: 0,
    })
    expect(result.rates).toEqual([
      { currency: 'SEK', for_date: '2026-09-30', rate: 11.331, rate_date: '2026-09-30', unavailable: false },
    ])
    expect(result.ledger_vat_sek).toBe(190)
    expect(result.unaccounted).toEqual([])
    expect(result.warnings).toEqual([])
    expect(result.nil_return).toBe(false)
    expect(result.period).toMatchObject({ start: '2026-07-01', end: '2026-09-30', label: 'Q3 2026', deadline: '2026-10-31' })
  })

  it('keeps each country and rate on its own row, and converts each currency at its own rate', () => {
    const result = underlag(input({
      entries: [entry('e1'), entry('e2'), entry('e3', { net: 400, vat: 28 })],
      orders: [
        order('o1', { journal_entry_id: 'e1' }),
        // A EUR shop: the amounts are already euro; kronor from the order's Riksbank rate.
        order('o2', { journal_entry_id: 'e2', currency: 'EUR', exchange_rate: 11.25, vat_breakdown: [{ rate: 19, net: 100, tax: 19 }] }),
        order('o3', { journal_entry_id: 'e3', vat_breakdown: [{ rate: 7, net: 400, tax: 28 }] }),
      ],
    }))

    expect(result.rows).toEqual([
      // 88.2534… + 100 = 188.25; 16.7681… + 19 = 35.77
      { country: 'DE', vat_rate: 7, net_eur: 35.3, vat_eur: 2.47, net_sek: 400, vat_sek: 28, order_count: 1, voucher_count: 0, rate_mismatch: false },
      { country: 'DE', vat_rate: 19, net_eur: 188.25, vat_eur: 35.77, net_sek: 2125, vat_sek: 403.75, order_count: 2, voucher_count: 0, rate_mismatch: false },
    ])
  })

  it('nets a refund of a sale in the same quarter into its row', () => {
    const result = underlag(input({
      entries: [entry('e1'), entry('e2', { net: -500, vat: -95 })],
      orders: [
        order('o1', { journal_entry_id: 'e1' }),
        // Shopify stores a refund's buckets positive; the row type takes them back.
        order('r1', { journal_entry_id: 'e2', row_type: 'refund', parent_order_id: 'o1', vat_breakdown: [{ rate: 19, net: 500, tax: 95 }] }),
      ],
    }))

    expect(result.rows).toEqual([
      { country: 'DE', vat_rate: 19, net_eur: 44.13, vat_eur: 8.38, net_sek: 500, vat_sek: 95, order_count: 2, voucher_count: 0, rate_mismatch: false },
    ])
    expect(result.corrections).toEqual([])
  })

  it('makes a refund of an earlier quarter\'s sale a correction of that quarter, at that quarter\'s rate', () => {
    const result = underlag(input({
      entries: [entry('e2', { net: -500, vat: -95 })],
      orders: [
        // Zettle-style negative buckets read the same as Shopify's positive ones.
        order('r1', { journal_entry_id: 'e2', row_type: 'refund', parent_order_id: 'o1', vat_breakdown: [{ rate: 19, net: -500, tax: -95 }] }),
      ],
      parentBookingDates: new Map([['o1', '2026-05-20']]),
    }))

    expect(result.rows).toEqual([])
    expect(result.corrections).toEqual([
      // -95 / 10.9 = -8.7155…: the Q2 rate, so a full refund takes back what Q2 declared.
      { country: 'DE', period: { year: 2026, quarter: 2, label: 'Q2 2026' }, vat_eur: -8.72, vat_sek: -95, refund_count: 1, voucher_count: 0 },
    ])
    expect(result.totals.corrections_vat_eur).toBe(-8.72)
    expect(result.totals.corrections_vat_sek).toBe(-95)
    expect(result.rates.map((rate) => rate.for_date)).toEqual(['2026-06-30'])
    expect(result.nil_return).toBe(false)
  })

  it('leaves out a refund whose order was not booked as an OSS sale, and says so', () => {
    const result = underlag(input({
      entries: [entry('e2', { net: -500, vat: -95 })],
      orders: [order('r1', { journal_entry_id: 'e2', row_type: 'refund', parent_order_id: 'o1', vat_breakdown: [{ rate: 19, net: 500, tax: 95 }] })],
      parentBookingDates: new Map([['o1', null]]),
    }))

    expect(result.rows).toEqual([])
    expect(result.corrections).toEqual([])
    expect(result.warnings.map((w) => [w.code, w.order_numbers])).toEqual([['refund_parent_not_oss', ['#r1']]])
    expect(result.nil_return).toBe(false)
  })

  it('drops a verifikat and its storno in the same quarter, and follows the rättelse that replaced it', () => {
    const original = entry('e1', { status: 'reversed' })
    const storno = entry('e2', { reverses_id: 'e1', net: -1000, vat: -190 })
    const correction = entry('e3', { correction_of_id: 'e1' })

    const cancelledOnly = underlag(input({ entries: [original, storno], orders: [order('o1', { journal_entry_id: 'e1' })] }))
    expect(cancelledOnly.rows).toEqual([])
    expect(cancelledOnly.unaccounted).toEqual([])
    expect(cancelledOnly.ledger_vat_sek).toBe(0)
    expect(cancelledOnly.nil_return).toBe(true)

    const corrected = underlag(input({
      entries: [original, storno, correction],
      orders: [order('o1', { journal_entry_id: 'e1' })],
    }))
    expect(corrected.rows).toEqual([
      { country: 'DE', vat_rate: 19, net_eur: 88.25, vat_eur: 16.77, net_sek: 1000, vat_sek: 190, order_count: 1, voucher_count: 0, rate_mismatch: false },
    ])
    expect(corrected.unaccounted).toEqual([])
  })

  it('still counts a verifikat in its own quarter when the storno came in a later one', () => {
    const result = underlag(input({
      entries: [entry('e1', { status: 'reversed' })],
      orders: [order('o1', { journal_entry_id: 'e1' })],
    }))
    expect(result.rows).toHaveLength(1)
  })

  it('lists every OSS-account verifikat that books no order, with its amounts, and reconciles to the ledger', () => {
    const result = underlag(input({
      entries: [
        entry('e1'),
        entry('e7', { description: 'Manuell OSS-justering', net: 0, vat: 25 }),
        // A storno of an earlier quarter's order: not this quarter's to place.
        entry('e8', { reverses_id: 'e-q2', net: -1000, vat: -190, entry_date: '2026-07-02' }),
      ],
      orders: [order('o1', { journal_entry_id: 'e1' })],
    }))

    expect(result.unaccounted).toEqual([
      { journal_entry_id: 'e8', voucher_series: 'A', voucher_number: 8, entry_date: '2026-07-02', description: 'Order e8', net_sek: -1000, vat_sek: -190 },
      { journal_entry_id: 'e7', voucher_series: 'A', voucher_number: 7, entry_date: '2026-08-15', description: 'Manuell OSS-justering', net_sek: 0, vat_sek: 25 },
    ])
    expect(result.ledger_vat_sek).toBe(25)
    expect(result.totals.vat_sek).toBe(190)
    // One warning for the list, whatever its length: the vouchers are not in the amounts.
    expect(result.warnings.map((w) => [w.code, w.order_numbers])).toEqual([['vouchers_without_order', []]])
  })

  it('never answers a nil return for a sale booked by hand on the OSS accounts, and invents no country for it', () => {
    // A sale through a payment provider, booked as a manual verifikat: no order row carries its country.
    const result = underlag(input({
      entries: [entry('e7', { description: 'Manuell OSS-försäljning', net: 80, vat: 16 })],
    }))

    expect(result.rows).toEqual([])
    expect(result.corrections).toEqual([])
    expect(result.totals).toEqual({ net_eur: 0, vat_eur: 0, corrections_vat_eur: 0, net_sek: 0, vat_sek: 0, corrections_vat_sek: 0 })
    expect(result.rates).toEqual([])
    expect(result.ledger_vat_sek).toBe(16)
    expect(result.unaccounted).toEqual([
      { journal_entry_id: 'e7', voucher_series: 'A', voucher_number: 7, entry_date: '2026-08-15', description: 'Manuell OSS-försäljning', net_sek: 80, vat_sek: 16 },
    ])
    expect(result.warnings.map((w) => [w.code, w.order_numbers])).toEqual([['vouchers_without_order', []]])
    expect(result.warnings[0].message_sv).toContain('vilket land')
    expect(result.warnings[0].message_en).toContain('which country')
    expect(result.nil_return).toBe(false)
  })

  it('answers no nil return for any verifikat left outside, the payment of last quarter\'s OSS VAT included', () => {
    // Debit on the OSS VAT account alone: a payment, or a correction to declare. The ledger does not say which.
    const result = underlag(input({ entries: [entry('e9', { description: 'Betalning OSS', net: 0, vat: -190 })] }))

    expect(result.rows).toEqual([])
    expect(result.unaccounted.map((voucher) => [voucher.journal_entry_id, voucher.net_sek, voucher.vat_sek])).toEqual([['e9', 0, -190]])
    expect(result.nil_return).toBe(false)
  })

  it('answers no nil return when the ledger holds OSS VAT that no row and no warning explains', () => {
    // Marked as booked on a verifikat with OSS VAT, but the order row itself carries no VAT to place.
    const result = underlag(input({
      entries: [entry('e5')],
      orders: [order('o1', { manually_booked_journal_entry_id: 'e5', manually_booked_at: '2026-08-16T10:00:00Z', vat_breakdown: [] })],
    }))

    expect(result.rows).toEqual([])
    expect(result.unaccounted).toEqual([])
    expect(result.warnings).toEqual([])
    expect(result.ledger_vat_sek).toBe(190)
    expect(result.nil_return).toBe(false)
  })

  it('counts an order marked as booked on a verifikat that carries OSS lines', () => {
    const result = underlag(input({
      entries: [entry('e5')],
      orders: [order('o1', { manually_booked_journal_entry_id: 'e5', manually_booked_at: '2026-08-16T10:00:00Z' })],
    }))
    expect(result.rows).toHaveLength(1)
    expect(result.unaccounted).toEqual([])
  })

  it('never declares Sweden, an unknown country or an order without an exchange rate', () => {
    const result = underlag(input({
      entries: [entry('e1'), entry('e2'), entry('e3')],
      orders: [
        order('o1', { journal_entry_id: 'e1', customer_country: 'SE' }),
        order('o2', { journal_entry_id: 'e2', customer_country: null }),
        order('o3', { journal_entry_id: 'e3', currency: 'USD', exchange_rate: null }),
      ],
    }))
    expect(result.rows).toEqual([])
    expect(result.warnings.map((w) => [w.code, w.order_numbers])).toEqual([['orders_not_placeable', ['#o1', '#o2', '#o3']]])
    // The OSS accounts hold their VAT: no rows is a gap here, not a quarter without sales.
    expect(result.ledger_vat_sek).toBe(570)
    expect(result.nil_return).toBe(false)
  })

  it('leaves 0 % buckets out of the declaration', () => {
    const result = underlag(input({
      entries: [entry('e1')],
      orders: [order('o1', { journal_entry_id: 'e1', vat_breakdown: [{ rate: 19, net: 1000, tax: 190 }, { rate: 0, net: 50, tax: 0 }] })],
    }))
    expect(result.rows.map((row) => row.vat_rate)).toEqual([19])
  })

  it('warns about the quarter\'s EU orders that are not booked, and about foreign VAT booked without OSS accounts', () => {
    const result = underlag(input({
      quarterOrders: [
        order('u1'),
        order('u2', { is_paid: false }),
        order('u3', { manually_booked_at: '2026-08-20T08:00:00Z' }),
        order('u4', { vat_breakdown: [{ rate: 0, net: 100, tax: 0 }] }),
        order('b1', { journal_entry_id: 'elsewhere' }),
        order('b2', { journal_entry_id: 'elsewhere', customer_country: 'DK', vat_breakdown: [{ rate: 25, net: 100, tax: 25 }] }),
      ],
    }))
    expect(result.warnings.map((w) => [w.code, w.order_numbers])).toEqual([
      ['unbooked_orders', ['#u1']],
      ['foreign_vat_not_oss', ['#b1']],
    ])
    expect(result.warnings[0].message_sv).toContain('inte bokförda')
    expect(result.warnings[0].message_en).toContain('not booked')
    // Orders known to be missing: an empty underlag is not a nil return yet.
    expect(result.rows).toEqual([])
    expect(result.nil_return).toBe(false)
  })

  it('warns about an order a storno released in the quarter, and counts one whose verifikat is reversed only later', () => {
    // r1: e1 and its storno s1 in the quarter cancel; the order waits to be
    // booked again. r2: e2 is reversed after the quarter, which held it.
    const released = order('r1', { journal_entry_id: 'e1' })
    const reversedLater = order('r2', { journal_entry_id: 'e2' })
    const result = underlag(input({
      entries: [
        entry('e1', { status: 'reversed' }),
        entry('s1', { reverses_id: 'e1', net: -1000, vat: -190 }),
        entry('e2', { status: 'reversed' }),
      ],
      orders: [released, reversedLater],
      quarterOrders: [released, reversedLater],
      releasedEntryIds: new Set(['e1', 'e2']),
    }))
    expect(result.warnings.map((w) => [w.code, w.order_numbers])).toEqual([['unbooked_orders', ['#r1']]])
    expect(result.rows).toEqual([expect.objectContaining({ country: 'DE', vat_sek: 190, order_count: 1 })])
  })

  it('keeps the kronor and leaves the euro empty while the ECB rate is missing', () => {
    const result = underlag(
      input({ entries: [entry('e1')], orders: [order('o1', { journal_entry_id: 'e1' })] }),
      [['SEK|2026-09-30', { ok: true, rate: null }]],
    )
    expect(result.rows[0]).toMatchObject({ net_eur: null, vat_eur: null, net_sek: 1000, vat_sek: 190 })
    expect(result.totals).toMatchObject({ net_eur: null, vat_eur: null, vat_sek: 190 })
    expect(result.rates).toEqual([{ currency: 'SEK', for_date: '2026-09-30', rate: null, rate_date: null, unavailable: true }])
    expect(result.warnings.map((w) => w.code)).toEqual(['rate_unavailable'])
  })

  it('answers a nil return for a quarter without OSS sales, and needs no rate', () => {
    const classification = classifyOssBookings(input())
    expect(ossRateNeeds(classification, Q3)).toEqual([])
    const result = finalizeOssUnderlag(Q3, classification, new Map())
    expect(result.nil_return).toBe(true)
    expect(result.ledger_vat_sek).toBe(0)
    expect(result.unaccounted).toEqual([])
    expect(result.warnings).toEqual([])
    expect(result.totals).toEqual({ net_eur: 0, vat_eur: 0, corrections_vat_eur: 0, net_sek: 0, vat_sek: 0, corrections_vat_sek: 0 })
  })

  it('needs the quarter-end rate per currency, and each corrected quarter\'s', () => {
    const classification = classifyOssBookings(input({
      entries: [entry('e1'), entry('e2', { net: -500, vat: -95 })],
      orders: [
        order('o1', { journal_entry_id: 'e1', currency: 'EUR', exchange_rate: 11.2 }),
        order('r1', { journal_entry_id: 'e2', row_type: 'refund', parent_order_id: 'o0' }),
      ],
      parentBookingDates: new Map([['o0', '2026-02-10']]),
    }))
    expect(ossRateNeeds(classification, Q3)).toEqual([
      { currency: 'SEK', date: '2026-03-31' },
      { currency: 'EUR', date: '2026-09-30' },
    ])
  })
})

// A chart with one sales account per country and rate and one VAT account
// per country, the way OSS is booked without an order feed.
const COUNTRY_REVENUE = new Set(['3106', '3149', '3150', '3151'])
const COUNTRY_VAT = new Set(['2670', '2671', '2672'])
const COUNTRIES = new Map<string, OssAccountCountry>([
  ['3149', { country: 'DE', vat_rate: 19 }],
  ['3150', { country: 'FR', vat_rate: 20 }],
  ['3151', { country: 'DE', vat_rate: 7 }],
  ['2671', { country: 'DE', vat_rate: null }],
  ['2672', { country: 'FR', vat_rate: null }],
])

/** A posted verifikat in Q3 with the given credit (positive) or debit (negative) per account. */
function voucher(id: string, lines: Array<[string, number]>, overrides: Partial<OssEntry> = {}): OssEntry {
  return {
    id,
    voucher_series: 'A',
    voucher_number: Number(id.replace(/\D/g, '')) || 1,
    entry_date: '2026-08-15',
    description: `Faktura ${id}`,
    status: 'posted',
    reverses_id: null,
    correction_of_id: null,
    lines: lines.map(([account_number, value]) =>
      value >= 0
        ? { account_number, debit_amount: 0, credit_amount: value }
        : { account_number, debit_amount: -value, credit_amount: 0 },
    ),
    ...overrides,
  }
}

function byAccount(overrides: Partial<OssClassifyInput> = {}): OssClassifyInput {
  return input({ revenueAccounts: COUNTRY_REVENUE, vatAccounts: COUNTRY_VAT, accountCountries: COUNTRIES, ...overrides })
}

describe('verifikat placed by the country their accounts name', () => {
  it('declares a verifikat that books no order under the country and rate of its sales account', () => {
    const result = underlag(byAccount({ entries: [voucher('e1', [['3149', 1000], ['2671', 190]])] }))

    expect(result.rows).toEqual([
      { country: 'DE', vat_rate: 19, net_eur: 88.25, vat_eur: 16.77, net_sek: 1000, vat_sek: 190, order_count: 0, voucher_count: 1, rate_mismatch: false },
    ])
    expect(result.rates).toEqual([
      { currency: 'SEK', for_date: '2026-09-30', rate: 11.331, rate_date: '2026-09-30', unavailable: false },
    ])
    expect(result.unaccounted).toEqual([])
    expect(result.refund_vouchers).toEqual([])
    expect(result.warnings).toEqual([])
    expect(result.ledger_vat_sek).toBe(190)
    expect(result.nil_return).toBe(false)
  })

  it('gives the VAT on a shared VAT account to the one sale it is booked with', () => {
    const result = underlag(byAccount({ entries: [voucher('e1', [['3150', 500], ['2670', 100]])] }))
    expect(result.rows.map((row) => [row.country, row.vat_rate, row.net_sek, row.vat_sek])).toEqual([['FR', 20, 500, 100]])
  })

  it('gives each country its own VAT account in a verifikat that sells to several', () => {
    const result = underlag(byAccount({
      entries: [voucher('e1', [['3149', 1000], ['3150', 500], ['2671', 190], ['2672', 100]])],
    }))
    expect(result.rows.map((row) => [row.country, row.vat_rate, row.net_sek, row.vat_sek, row.voucher_count, row.rate_mismatch])).toEqual([
      ['DE', 19, 1000, 190, 1, false],
      ['FR', 20, 500, 100, 1, false],
    ])
  })

  it('shares one VAT line between several sales by what their rates make of them, to the öre', () => {
    const result = underlag(byAccount({
      // Two German rates on the German VAT account, and France with it on the shared one.
      entries: [
        voucher('e1', [['3149', 1000], ['3151', 400], ['2671', 218.01]]),
        voucher('e2', [['3149', 1000], ['3150', 500], ['2670', 290]]),
      ],
    }))
    expect(result.rows.map((row) => [row.country, row.vat_rate, row.net_sek, row.vat_sek])).toEqual([
      // e1: 218.01 × 28 / 218 = 28.0013 → 28.00 to 7 %, and 19 % takes what is left, 190.01.
      ['DE', 7, 400, 28],
      ['DE', 19, 2000, 380.01],
      ['FR', 20, 500, 100],
    ])
    expect(result.totals.vat_sek).toBe(508.01)
    expect(result.ledger_vat_sek).toBe(508.01)
  })

  it('shares a VAT line by unrounded proportions, so sales of a few öre still carry their part', () => {
    // 0.02 at 19 % against 0.01 at 20 %: 38 parts to 20, and each rounds to one öre.
    const result = underlag(byAccount({ entries: [voucher('e1', [['3149', 0.02], ['3150', 0.01], ['2670', 0.02]])] }))
    expect(result.rows.map((row) => [row.country, row.net_sek, row.vat_sek])).toEqual([
      ['DE', 0.02, 0.01],
      ['FR', 0.01, 0.01],
    ])
  })

  it('leaves a verifikat out whole when one of its sales accounts names no country, and names the account', () => {
    const classification = classifyOssBookings(byAccount({
      entries: [voucher('e1', [['3149', 1000], ['3106', 200], ['2670', 230]])],
    }))
    expect(classification.rows.size).toBe(0)
    expect(classification.accountsWithoutCountry).toEqual(['3106'])
    expect(classification.unaccounted.map((v) => [v.journal_entry_id, v.net_sek, v.vat_sek])).toEqual([['e1', 1200, 230]])
    expect(classification.warnings.map((w) => w.code)).toEqual(['vouchers_without_order'])
  })

  it('does not read a VAT line with no sale to go to as a sale: the payment of last quarter\'s OSS VAT', () => {
    const result = underlag(byAccount({
      entries: [
        voucher('e9', [['2671', -190], ['2672', -100]], { description: 'Betalning OSS' }),
        // German sale, French VAT account: no French sale in the verifikat to carry it.
        voucher('e10', [['3149', 1000], ['2672', 190]]),
      ],
    }))
    expect(result.rows).toEqual([])
    expect(result.unaccounted.map((v) => v.journal_entry_id)).toEqual(['e9', 'e10'])
    expect(result.accounts).toEqual([])
    expect(result.nil_return).toBe(false)
  })

  it('makes the storno of an earlier quarter\'s verifikat a correction of that quarter, at that quarter\'s rate', () => {
    const result = underlag(byAccount({
      entries: [voucher('e8', [['3149', -1000], ['2671', -190]], { reverses_id: 'e-q2' })],
      linkedEntryDates: new Map([['e-q2', '2026-05-20']]),
    }))
    expect(result.rows).toEqual([])
    expect(result.corrections).toEqual([
      // -190 / 10.9 = -17.431…
      { country: 'DE', period: { year: 2026, quarter: 2, label: 'Q2 2026' }, vat_eur: -17.43, vat_sek: -190, refund_count: 0, voucher_count: 1 },
    ])
    expect(result.refund_vouchers).toEqual([])
    expect(result.unaccounted).toEqual([])
    expect(result.warnings).toEqual([])
  })

  it('makes the rättelse that replaces an earlier quarter\'s verifikat a correction of that quarter too', () => {
    // Booked on Germany in Q2, taken back and booked on France in Q3: both belong to Q2.
    const result = underlag(byAccount({
      entries: [
        voucher('e8', [['3149', -1000], ['2671', -190]], { reverses_id: 'e-q2' }),
        voucher('e9', [['3150', 1000], ['2672', 200]], { correction_of_id: 'e-q2' }),
      ],
      linkedEntryDates: new Map([['e-q2', '2026-05-20']]),
    }))
    expect(result.rows).toEqual([])
    expect(result.corrections.map((c) => [c.country, c.period.label, c.vat_sek, c.voucher_count])).toEqual([
      ['DE', 'Q2 2026', -190, 1],
      ['FR', 'Q2 2026', 200, 1],
    ])
  })

  it('leaves a storno outside when the verifikat it takes back cannot be read', () => {
    const result = underlag(byAccount({
      entries: [voucher('e8', [['3149', -1000], ['2671', -190]], { reverses_id: 'gone' })],
    }))
    expect(result.rows).toEqual([])
    expect(result.corrections).toEqual([])
    expect(result.unaccounted.map((v) => v.journal_entry_id)).toEqual(['e8'])
  })

  it('takes a refund booked as a verifikat of its own off the quarter, and lists it', () => {
    const result = underlag(byAccount({
      entries: [
        voucher('e1', [['3149', 1000], ['2671', 190]]),
        voucher('e2', [['3149', -400], ['2671', -76]], { description: 'Kreditfaktura' }),
      ],
    }))
    expect(result.rows.map((row) => [row.country, row.net_sek, row.vat_sek, row.voucher_count, row.rate_mismatch])).toEqual([
      ['DE', 600, 114, 2, false],
    ])
    expect(result.refund_vouchers).toEqual([
      { journal_entry_id: 'e2', voucher_series: 'A', voucher_number: 2, entry_date: '2026-08-15', description: 'Kreditfaktura', net_sek: -400, vat_sek: -76 },
    ])
    expect(result.warnings.map((w) => w.code)).toEqual(['refund_vouchers_netted'])
    expect(result.warnings[0].message_sv).toContain('rättelse')
    expect(result.warnings[0].message_en).toContain('correction')
  })

  it('marks a row whose booked VAT is not the rate of its sales, and lets a krona of rounding pass', () => {
    const wrongRate = underlag(byAccount({ entries: [voucher('e1', [['3149', 1000], ['2671', 210]])] }))
    expect(wrongRate.rows[0]).toMatchObject({ vat_sek: 210, rate_mismatch: true })
    expect(wrongRate.warnings.map((w) => w.code)).toEqual(['vat_rate_mismatch'])

    // VAT booked on an account that is not an OSS VAT account never reaches the row.
    const noVat = underlag(byAccount({ entries: [voucher('e1', [['3149', 1000]])] }))
    expect(noVat.rows[0]).toMatchObject({ vat_sek: 0, rate_mismatch: true })

    // 1234.50 at 19 % is 234.555; booked as whole kronor it is 0.445 off.
    const rounded = underlag(byAccount({ entries: [voucher('e1', [['3149', 1234.5], ['2671', 235]])] }))
    expect(rounded.rows[0]).toMatchObject({ vat_sek: 235, rate_mismatch: false })
    expect(rounded.warnings).toEqual([])
  })

  it('lets the order decide when a verifikat books one, whatever its accounts name', () => {
    const result = underlag(byAccount({
      entries: [voucher('e1', [['3149', 1000], ['2671', 200]])],
      orders: [order('o1', { journal_entry_id: 'e1', customer_country: 'FR', vat_breakdown: [{ rate: 20, net: 1000, tax: 200 }] })],
    }))
    expect(result.rows).toEqual([
      { country: 'FR', vat_rate: 20, net_eur: 88.25, vat_eur: 17.65, net_sek: 1000, vat_sek: 200, order_count: 1, voucher_count: 0, rate_mismatch: false },
    ])
  })
})

describe('ruleVatAccountCountries', () => {
  it('gives a VAT account the country the rules name it for, when they name one other EU country', () => {
    expect(
      ruleVatAccountCountries(
        new Map([
          ['2671', new Set(['DE'])],
          // The EU catch-all, two countries and Sweden say no single country: the account is shared.
          ['2670', new Set(['EU'])],
          ['2680', new Set(['DE', 'FR'])],
          ['2690', new Set(['SE'])],
        ]),
      ),
    ).toEqual(new Map([['2671', 'DE']]))
  })
})

describe('ossAccountsOf', () => {
  const sales = [
    { account_number: '3106', account_name: 'Försäljning varor till annat EU-land, momspliktig', country: null, vat_rate: null },
    { account_number: '3149', account_name: 'Försäljning OSS Tyskland 19 %', country: 'DE', vat_rate: 19 },
    { account_number: '3150', account_name: 'Försäljning enl. OSS (Frankrike 20%)', country: null, vat_rate: null },
    { account_number: '3152', account_name: 'Försäljning OSS Spanien 21%', country: null, vat_rate: null },
  ]
  const vat = [
    { account_number: '2611', account_name: 'Utgående moms på försäljning inom Sverige, 25 %', country: null, vat_rate: null },
    { account_number: '2670', account_name: 'Utgående moms på försäljning inom EU, OSS', country: null, vat_rate: null },
    { account_number: '2671', account_name: 'Utgående moms OSS Tyskland', country: 'DE', vat_rate: null },
    { account_number: '2672', account_name: 'Utgående moms OSS Frankrike', country: null, vat_rate: null },
    { account_number: '2690', account_name: 'Avräkning OSS Frankrike', country: null, vat_rate: null },
  ]

  it('lists the accounts that name a country, the sales accounts a verifikat waits for, and the VAT accounts whose name states a country', () => {
    const accounts = ossAccountsOf({
      salesAccounts: sales,
      vatAccounts: vat,
      ossVatAccounts: new Set(['2670', '2671']),
      accountsWithoutCountry: ['3150'],
    })
    expect(accounts).toEqual([
      { account_number: '2671', account_name: 'Utgående moms OSS Tyskland', kind: 'vat', country: 'DE', vat_rate: null, suggested_country: null, suggested_vat_rate: null, blocks_vouchers: false },
      { account_number: '2672', account_name: 'Utgående moms OSS Frankrike', kind: 'vat', country: null, vat_rate: null, suggested_country: 'FR', suggested_vat_rate: null, blocks_vouchers: false },
      { account_number: '3149', account_name: 'Försäljning OSS Tyskland 19 %', kind: 'sales', country: 'DE', vat_rate: 19, suggested_country: null, suggested_vat_rate: null, blocks_vouchers: false },
      { account_number: '3150', account_name: 'Försäljning enl. OSS (Frankrike 20%)', kind: 'sales', country: null, vat_rate: null, suggested_country: 'FR', suggested_vat_rate: 20, blocks_vouchers: true },
    ])
  })

  it('lists nothing for a company whose OSS accounts name no country and wait for none', () => {
    expect(
      ossAccountsOf({ salesAccounts: sales.filter((a) => a.country === null), vatAccounts: vat.filter((a) => a.country === null), ossVatAccounts: new Set(['2670']), accountsWithoutCountry: [] }),
    ).toEqual([])
  })
})
