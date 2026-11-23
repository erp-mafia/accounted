import { describe, expect, it } from 'vitest'
import { buildOrderBooking } from '../booking-lines'
import {
  kustomCaptureExternalId,
  kustomImport,
  kustomOrderNumbers,
  kustomRefundExternalId,
  parseKustomSettlementReport,
} from '../kustom-settlement'

const SUMMARY_HEADER =
  'total_sale_amount;total_fee_amount;total_return_amount;total_reversal_amount;total_commission_amount;total_holdback_amount;total_repay_amount;total_release_amount;total_fee_correction_amount;total_settlement_amount;total_tax_amount;payment_reference;settlement_currency;payout_date;merchant_id;merchant_settlement_type'
const TX_HEADER =
  'type;capture_date;sale_date;order_id;short_order_id;capture_id;merchant_reference1;merchant_reference2;amount;posting_currency;refund_id;purchase_country;tax_rate_1;tax_amount_1;tax_rate_2;tax_amount_2;shipping_address_country;ipp_device_id'

interface Tx {
  type: string
  capture: string
  sale?: string
  order: string
  captureId?: string
  ref?: string
  amount: string
  refundId?: string
  country?: string
  shipTo?: string
  device?: string
  vat?: Array<[string, string]>
}

function tx(t: Tx): string {
  const vat = t.vat ?? []
  return [
    t.type,
    t.capture,
    t.sale ?? t.capture,
    t.order,
    `${t.order.slice(0, 4).toUpperCase()}-1`,
    t.captureId ?? '',
    t.ref ?? '',
    '',
    t.amount,
    'SEK',
    t.refundId ?? '',
    t.country ?? 'SE',
    vat[0]?.[0] ?? '',
    vat[0]?.[1] ?? '',
    vat[1]?.[0] ?? '',
    vat[1]?.[1] ?? '',
    t.shipTo ?? '',
    t.device ?? '',
  ].join(';')
}

/** The summary of a payout of only `sales` and `returns`, nothing else. */
function summaryOf(sales: string, returns: string, settlement: string): string {
  return `${sales};0.00;${returns};0.00;0.00;0.00;0.00;0.00;0.00;${settlement};0.00;PAY9;SEK;2026-11-19T00:00:00.000Z;M100;NET`
}

const sale = (t: Partial<Tx> & { captureId: string; amount: string }): string =>
  tx({ type: 'SALE', capture: '2026-11-18T09:00:00.000Z', order: `o-${t.captureId}`, ref: `R-${t.captureId}`, ...t })

const ret = (t: Partial<Tx> & { refundId: string; amount: string }): string =>
  tx({ type: 'RETURN', capture: '2026-11-18T09:00:00.000Z', order: `o-${t.refundId}`, ref: `R-${t.refundId}`, ...t })

/**
 * An invented payout: two sales (one 25 %, one 25 % + 12 %), one return, two
 * fees. 1250.00 + 612.00 - 300.00 - 18.10 - 4.53 = 1539.37.
 */
function report(overrides: { summary?: string; header?: string; rows?: string[] } = {}): string {
  const rows = overrides.rows ?? [
    tx({
      type: 'SALE',
      capture: '2026-11-18T09:00:00.000Z',
      sale: '2026-11-17T20:00:00.000Z',
      order: 'aaaa1111',
      captureId: 'cap-1',
      ref: 'REFA',
      amount: '1250.00',
      vat: [['2500', '250.00']],
    }),
    tx({ type: 'FEE', capture: '2026-11-18T09:00:00.000Z', order: 'aaaa1111', captureId: 'cap-1', amount: '12.50' }),
    tx({
      type: 'SALE',
      capture: '2026-11-18T23:30:00.000Z',
      order: 'bbbb2222',
      captureId: 'cap-2',
      ref: 'REFB',
      amount: '612.00',
      vat: [['2500', '100.00'], ['1200', '12.00']],
    }),
    tx({ type: 'FEE', capture: '2026-11-18T23:30:00.000Z', order: 'bbbb2222', captureId: 'cap-2', amount: '5.60' }),
    tx({
      type: 'RETURN',
      capture: '2026-11-18T07:00:00.000Z',
      sale: '2026-10-02T10:00:00.000Z',
      order: 'cccc3333',
      ref: 'REFC',
      amount: '300.00',
      refundId: 'ref-1',
      vat: [['2500', '60.00']],
    }),
  ]
  const summary =
    overrides.summary ??
    '1862.00;18.10;300.00;0.00;0.00;0.00;0.00;0.00;0.00;1539.37;4.53;PAY123;SEK;2026-11-19T00:00:00.000Z;M100;NET'
  return [SUMMARY_HEADER, summary, overrides.header ?? TX_HEADER, ...rows].join('\n')
}

function read(content: string) {
  const outcome = parseKustomSettlementReport(content)
  if (!outcome.ok) throw new Error(`refused: ${outcome.code}`)
  return outcome.file
}

function imported(content: string, knownElsewhere?: Set<string>) {
  return kustomImport(read(content), knownElsewhere)
}

const refusal = (content: string) => {
  const outcome = parseKustomSettlementReport(content)
  return outcome.ok ? 'ok' : outcome.code
}

describe('parseKustomSettlementReport', () => {
  it('reads the payout summary for booking the bank row', () => {
    expect(read(report()).payout).toEqual({
      reference: 'PAY123',
      merchantId: 'M100',
      payoutDate: '2026-11-19',
      currency: 'SEK',
      sales: 1862,
      returns: 300,
      reversals: 0,
      fees: 18.1,
      feeVat: 4.53,
      holdback: 0,
      release: 0,
      other: 0,
      settlement: 1539.37,
    })
  })

  it('names reversals, holdbacks and releases on their own, and nets the rest as other', () => {
    // 1862 - 300 - 50 (reversal) - 18.10 - 4.53 - 100 (holdback) + 40 (release)
    // = 1429.37; a correction of -9.37 makes the payout 1420.00.
    const { payout } = read(
      report({
        summary: '1862.00;18.10;300.00;50.00;0.00;100.00;0.00;40.00;0.00;1420.00;4.53;PAY123;SEK;2026-11-19T00:00:00.000Z;M100;NET',
      }),
    )
    expect(payout).toMatchObject({ reversals: 50, holdback: 100, release: 40, other: -9.37, settlement: 1420 })
  })

  it('makes every SALE an order and every RETURN a refund; fees stay off the Orders page', () => {
    const { rows } = imported(report())
    expect(rows.map((r) => [r.row_type, r.external_id, r.total])).toEqual([
      ['order', kustomCaptureExternalId('M100', 'cap-1'), 1250],
      ['order', kustomCaptureExternalId('M100', 'cap-2'), 612],
      ['refund', kustomRefundExternalId('M100', 'ref-1'), -300],
    ])
    expect(rows.every((r) => r.platform === 'kustom' && r.store_scope === 'M100')).toBe(true)
    expect(rows[0]).toMatchObject({
      order_number: 'REFA',
      payment_method: 'kustom',
      payment_method_title: 'Kustom',
      gateway_reference: 'PAY123',
      customer_country: 'SE',
      currency: 'SEK',
      is_paid: true,
      status: 'paid',
    })
    expect(rows[2]).toMatchObject({ status: 'refund', is_paid: true })
  })

  it('dates a sale by the Swedish day it was captured, not the payout or the UTC day', () => {
    const { rows } = imported(report())
    expect(rows[0]).toMatchObject({ order_date: '2026-11-17', paid_date: '2026-11-18' })
    // 23:30 UTC on the 18th is 00:30 on the 19th in Stockholm.
    expect(rows[1]).toMatchObject({ order_date: '2026-11-19', paid_date: '2026-11-19' })
    // A return is dated when it was registered, not by the original sale.
    expect(rows[2]).toMatchObject({ order_date: '2026-11-18', paid_date: '2026-11-18' })
  })

  it('reads a timestamp without an offset as UTC, as Kustom writes it', () => {
    const rows_ = [sale({ captureId: 'cap-1', amount: '125.00', capture: '2026-12-31T23:30:00', vat: [['2500', '25.00']] })]
    const { rows } = imported(report({ rows: rows_, summary: summaryOf('125.00', '0.00', '125.00') }))
    // New Year's Eve 23:30 UTC is New Year's Day in Sweden: the next year.
    expect(rows[0].paid_date).toBe('2027-01-01')
  })

  it('splits VAT per rate so net plus VAT is the amount', () => {
    const { rows } = imported(report())
    expect(rows[0].vat_breakdown).toEqual([{ rate: 25, net: 1000, tax: 250 }])
    expect(rows[0].total_tax).toBe(250)
    expect(rows[1].vat_breakdown).toEqual([
      { rate: 25, net: 400, tax: 100 },
      { rate: 12, net: 100, tax: 12 },
    ])
    // A refund's total is negative; its buckets are signed against the row.
    expect(rows[2].vat_breakdown).toEqual([{ rate: 25, net: 240, tax: 60 }])
    expect(rows[2].total_tax).toBe(-60)
  })

  it('books every row it imports, balanced and with no gap, through the real booking builder', () => {
    const { rows } = imported(report())
    const booked = rows.map((row) => {
      const { lines, gap } = buildOrderBooking({
        order: { ...row, total_sek: row.total, exchange_rate: 1, ships_nothing: false },
        settings: null,
      })
      return { gap, lines: lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount]) }
    })
    expect(booked).toEqual([
      { gap: null, lines: [['1686', 1250, 0], ['3001', 0, 1000], ['2611', 0, 250]] },
      { gap: null, lines: [['1686', 612, 0], ['3001', 0, 400], ['2611', 0, 100], ['3002', 0, 100], ['2621', 0, 12]] },
      // The return reverses revenue and output VAT against the receivable.
      { gap: null, lines: [['1686', 0, 300], ['3001', 240, 0], ['2611', 60, 0]] },
    ])
  })

  it('gives the rounding öre to the largest bucket', () => {
    // 33.37 at 25 %: VAT 6.67, 6.67 / 0.25 = 26.68, so 0.02 is rounding.
    const rows_ = [sale({ captureId: 'cap-4', amount: '33.37', vat: [['2500', '6.67']] })]
    const { rows } = imported(report({ rows: rows_, summary: summaryOf('33.37', '0.00', '33.37') }))
    expect(rows[0].vat_breakdown).toEqual([{ rate: 25, net: 26.7, tax: 6.67 }])
  })

  it('holds a sale whose VAT does not add up, and imports such a return without a split', () => {
    const rows_ = [
      // 25 % VAT of 100.00 would be 20.00: half the amount carries no VAT the
      // report explains (a gift card, a 0 % line), so the split is a guess.
      sale({ captureId: 'cap-5', amount: '200.00', vat: [['2500', '20.00']] }),
      // 0.40 kr off at 25 % is more than rounding (at most 0.08 kr).
      sale({ captureId: 'cap-6', amount: '125.40', vat: [['2500', '25.00']] }),
      // No VAT on the row at all.
      sale({ captureId: 'cap-7', amount: '50.00' }),
      ret({ refundId: 'ref-7', amount: '80.00' }),
    ]
    const result = imported(report({ rows: rows_, summary: summaryOf('375.40', '80.00', '295.40') }))
    expect(result.rows.map((r) => [r.external_id, r.is_paid, r.status, r.vat_breakdown])).toEqual([
      [kustomCaptureExternalId('M100', 'cap-5'), false, 'needs_review', []],
      [kustomCaptureExternalId('M100', 'cap-6'), false, 'needs_review', []],
      [kustomCaptureExternalId('M100', 'cap-7'), false, 'needs_review', []],
      // A refund row is bookable whatever its status: without a split, bulk
      // and day booking refuse it and a person books it from the dialog.
      [kustomRefundExternalId('M100', 'ref-7'), true, 'refund', []],
    ])
    expect(result.rows[0].payment_method_title).toMatch(/momsen/)
    expect(result.salesHeld).toBe(3)
    expect(result.returnsHeld).toBe(1)
    expect(result.returnsLeftOut).toEqual({ count: 0, total: 0 })
  })

  it('holds a sale shipped outside Sweden: the Orders page books it as Swedish VAT otherwise', () => {
    const rows_ = [
      sale({ captureId: 'cap-dk', amount: '125.00', shipTo: 'DK', vat: [['2500', '25.00']] }),
      // No shipping country: the purchase country decides Sweden-or-not.
      sale({ captureId: 'cap-no', amount: '125.00', country: 'NO', vat: [['2500', '25.00']] }),
      ret({ refundId: 'ref-dk', amount: '125.00', shipTo: 'DK', vat: [['2500', '25.00']] }),
    ]
    const result = imported(report({ rows: rows_, summary: summaryOf('250.00', '125.00', '125.00') }))
    expect(result.rows.map((r) => [r.customer_country, r.is_paid, r.status, r.vat_breakdown.length])).toEqual([
      ['DK', false, 'needs_review', 1],
      ['NO', false, 'needs_review', 1],
      ['DK', true, 'refund', 0],
    ])
    expect(result.rows[0].payment_method_title).toMatch(/utanför Sverige/)
    expect(result.salesHeld).toBe(2)
    expect(result.returnsHeld).toBe(1)
  })

  it('holds an in-store sale and leaves its return out: the till books those', () => {
    const rows_ = [
      sale({ captureId: 'cap-shop', amount: '125.00', device: 'T-1', vat: [['2500', '25.00']] }),
      ret({ refundId: 'ref-shop', amount: '25.00', device: 'T-1', vat: [['2500', '5.00']] }),
    ]
    const result = imported(report({ rows: rows_, summary: summaryOf('125.00', '25.00', '100.00') }))
    expect(result.rows.map((r) => [r.row_type, r.is_paid, r.payment_method_title])).toEqual([
      ['order', false, 'Kustom: köp i butik, bokför manuellt'],
    ])
    expect(result.returnsLeftOut).toEqual({ count: 1, total: 25 })
  })

  it('holds a sale the shop feed already has, and leaves its return out', () => {
    const file = read(report())
    expect(kustomOrderNumbers(file)).toEqual(['REFA', 'REFB', 'REFC'])
    const result = kustomImport(file, new Set(['REFA', 'REFC']))
    expect(result.rows.map((r) => [r.order_number, r.is_paid, r.status])).toEqual([
      ['REFA', false, 'needs_review'],
      ['REFB', true, 'paid'],
    ])
    expect(result.rows[0].payment_method_title).toMatch(/bokför inte två gånger/)
    expect(result.salesHeld).toBe(1)
    expect(result.returnsLeftOut).toEqual({ count: 1, total: 300 })
  })

  it('refuses a report without consumer VAT, also in the default layout that has no refund_id', () => {
    const header = 'type;capture_date;sale_date;order_id;short_order_id;capture_id;merchant_reference1;amount;posting_currency;purchase_country'
    const rows = ['SALE;2026-11-18T09:00:00.000Z;2026-11-18T09:00:00.000Z;aaaa1111;AAAA-1;cap-1;REFA;1250.00;SEK;SE']
    expect(refusal(report({ header, rows, summary: summaryOf('1250.00', '0.00', '1250.00') }))).toBe(
      'KUSTOM_SETTLEMENT_NO_CONSUMER_VAT',
    )
  })

  it('refuses a report whose returns have no refund_id: they would have no key', () => {
    const header = TX_HEADER.replace(';refund_id', '')
    const rows = [ret({ refundId: 'x', amount: '25.00', vat: [['2500', '5.00']] }).replace(';x;', ';')]
    expect(refusal(report({ header, rows, summary: summaryOf('0.00', '25.00', '-25.00') }))).toBe(
      'KUSTOM_SETTLEMENT_ID_COLUMNS_MISSING',
    )
  })

  it('refuses the same capture twice in one file', () => {
    const one = sale({ captureId: 'cap-1', amount: '125.00', vat: [['2500', '25.00']] })
    expect(refusal(report({ rows: [one, one], summary: summaryOf('250.00', '0.00', '250.00') }))).toBe(
      'KUSTOM_SETTLEMENT_DUPLICATE_ROW',
    )
  })

  it('refuses amounts in minor units rather than reading öre as kronor', () => {
    expect(refusal(report().replace(/(\d+)\.(\d{2})/g, '$1$2'))).toBe('KUSTOM_SETTLEMENT_AMOUNT_FORMAT')
  })

  it('refuses a file whose rows do not add up to its summary (cut or edited)', () => {
    const rows = report().split('\n')
    expect(refusal(rows.slice(0, -1).join('\n'))).toBe('KUSTOM_SETTLEMENT_TOTALS_MISMATCH')
  })

  it('refuses a file that is not a Kustom settlement report', () => {
    expect(refusal('Datum;Text;Belopp\n2026-11-18;Insättning;100,00')).toBe('KUSTOM_SETTLEMENT_NOT_RECOGNIZED')
  })

  it('refuses a capture date without its time: the UTC day is not the Swedish one', () => {
    expect(refusal(report().replace('2026-11-18T09:00:00.000Z;2026-11-17T20:00:00.000Z', '2026-11-18;2026-11-17'))).toBe(
      'KUSTOM_SETTLEMENT_DATE_FORMAT',
    )
    expect(refusal(report().replace('2026-11-18T09:00:00.000Z;2026-11-17T20:00:00.000Z', '18/11/2026;17/11/2026'))).toBe(
      'KUSTOM_SETTLEMENT_DATE_FORMAT',
    )
  })

  it('reads a comma-delimited export with a BOM and CRLF line ends', () => {
    const content = '﻿' + report().replaceAll(';', ',').replaceAll('\n', '\r\n')
    expect(imported(content).rows).toHaveLength(3)
  })

  it('reads the signed export (minus signs on) the same way', () => {
    const content = report().replace(';300.00;SEK;ref-1', ';-300.00;SEK;ref-1').replace(';60.00', ';-60.00')
    const { rows } = imported(content)
    expect(rows[2]).toMatchObject({ total: -300, total_tax: -60 })
    expect(rows[2].vat_breakdown).toEqual([{ rate: 25, net: 240, tax: 60 }])
  })
})
