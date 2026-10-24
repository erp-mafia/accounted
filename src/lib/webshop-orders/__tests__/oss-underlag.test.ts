import { describe, expect, it } from 'vitest'
import type { EcbRateLookup } from '@/lib/currency/ecb'
import {
  classifyOssBookings,
  finalizeOssUnderlag,
  ossDeadline,
  ossQuarterBounds,
  ossQuarterOf,
  ossRateNeeds,
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
      { country: 'DE', vat_rate: 19, net_eur: 88.25, vat_eur: 16.77, net_sek: 1000, vat_sek: 190, order_count: 1 },
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
      { country: 'DE', vat_rate: 7, net_eur: 35.3, vat_eur: 2.47, net_sek: 400, vat_sek: 28, order_count: 1 },
      { country: 'DE', vat_rate: 19, net_eur: 188.25, vat_eur: 35.77, net_sek: 2125, vat_sek: 403.75, order_count: 2 },
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
      { country: 'DE', vat_rate: 19, net_eur: 44.13, vat_eur: 8.38, net_sek: 500, vat_sek: 95, order_count: 2 },
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
      { country: 'DE', period: { year: 2026, quarter: 2, label: 'Q2 2026' }, vat_eur: -8.72, vat_sek: -95, refund_count: 1 },
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
      { country: 'DE', vat_rate: 19, net_eur: 88.25, vat_eur: 16.77, net_sek: 1000, vat_sek: 190, order_count: 1 },
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
