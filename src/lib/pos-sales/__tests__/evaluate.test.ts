import { describe, expect, it } from 'vitest'
import type { PosDay } from '@accounted/connect-contract'
import { buildPosDayEntry, evaluatePosDay, posDayDescription } from '../evaluate'
import { DEFAULT_POS_SALES_SETTINGS, applyPosSalesSettingsPatch, type PosSalesSettings } from '../settings'

function day(overrides: Partial<PosDay> = {}): PosDay {
  return {
    businessDate: '2026-09-11',
    currency: 'SEK',
    sales: { net: 34000, vat: 5070, gross: 39070 },
    vatGroups: [
      { ratePercent: 25, net: 9000, vat: 2250, gross: 11250 },
      { ratePercent: 12, net: 22000, vat: 2640, gross: 24640 },
      { ratePercent: 6, net: 3000, vat: 180, gross: 3180 },
    ],
    tenders: [
      { kind: 'card', method: 'card', amount: 28000, tips: 0, receiptCount: 160 },
      { kind: 'swish', method: 'swish', amount: 6000, tips: 0, receiptCount: 40 },
      { kind: 'cash', method: 'cash', amount: 5070, tips: 0, receiptCount: 12 },
    ],
    tips: 0,
    discounts: 0,
    refunds: { count: 0, gross: 0 },
    receiptCount: 212,
    firstReceiptNumber: '1001',
    lastReceiptNumber: '1212',
    firstPaidAt: null,
    lastPaidAt: null,
    categories: [],
    receipts: [],
    issues: [],
    ...overrides,
  }
}

function sides(lines: ReturnType<typeof buildPosDayEntry>['lines']) {
  return lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount, l.line_description])
}

const sum = (values: number[]) => Math.round(values.reduce((a, b) => a + b, 0) * 100) / 100

describe('buildPosDayEntry', () => {
  it('books the swedish-cash-register worked example (one restaurant day) with the default mapping', () => {
    // .claude/skills/swedish-cash-register/references/cash-bookkeeping.md, section 4,
    // with Swish on the 1686 clearing account instead of straight to 1930.
    const entry = buildPosDayEntry(day(), DEFAULT_POS_SALES_SETTINGS)
    expect(entry.problems).toEqual([])
    expect(sides(entry.lines)).toEqual([
      ['1686', 28000, 0, 'Kortbetalningar'],
      ['1686', 6000, 0, 'Swish'],
      ['1910', 5070, 0, 'Kontant'],
      ['3001', 0, 9000, 'Försäljning 25 % moms'],
      ['2611', 0, 2250, 'Utgående moms 25 %'],
      ['3002', 0, 22000, 'Försäljning 12 % moms'],
      ['2621', 0, 2640, 'Utgående moms 12 %'],
      ['3003', 0, 3000, 'Försäljning 6 % moms'],
      ['2631', 0, 180, 'Utgående moms 6 %'],
    ])
    expect(sum(entry.lines.map((l) => l.debit_amount))).toBe(39070)
    expect(sum(entry.lines.map((l) => l.credit_amount))).toBe(39070)
    expect(entry.roundingAmount).toBe(0)
  })

  it('credits tips to the liability account, inside the card tender', () => {
    const entry = buildPosDayEntry(
      day({
        tenders: [
          { kind: 'card', method: 'card', amount: 28640, tips: 640, receiptCount: 160 },
          { kind: 'swish', method: 'swish', amount: 6000, tips: 0, receiptCount: 40 },
          { kind: 'cash', method: 'cash', amount: 5070, tips: 0, receiptCount: 12 },
        ],
        tips: 640,
      }),
      DEFAULT_POS_SALES_SETTINGS,
    )
    expect(entry.problems).toEqual([])
    expect(sides(entry.lines)).toContainEqual(['2820', 0, 640, 'Dricks att betala ut till personalen'])
    expect(sum(entry.lines.map((l) => l.debit_amount))).toBe(sum(entry.lines.map((l) => l.credit_amount)))
  })

  it('books a difference up to max_rounding on the rounding account, on the side that balances', () => {
    const short = buildPosDayEntry(
      day({ tenders: [{ kind: 'cash', method: 'cash', amount: 39069.6, tips: 0, receiptCount: 212 }] }),
      DEFAULT_POS_SALES_SETTINGS,
    )
    expect(short.problems).toEqual([])
    expect(short.roundingAmount).toBe(-0.4)
    expect(sides(short.lines)).toContainEqual(['3740', 0.4, 0, 'Öres- och kronutjämning'])

    const over = buildPosDayEntry(
      day({ tenders: [{ kind: 'cash', method: 'cash', amount: 39070.5, tips: 0, receiptCount: 212 }] }),
      DEFAULT_POS_SALES_SETTINGS,
    )
    expect(over.roundingAmount).toBe(0.5)
    expect(sides(over.lines)).toContainEqual(['3740', 0, 0.5, 'Öres- och kronutjämning'])
  })

  it('refuses a difference above max_rounding instead of hiding it', () => {
    const entry = buildPosDayEntry(
      day({ tenders: [{ kind: 'cash', method: 'cash', amount: 39000, tips: 0, receiptCount: 212 }] }),
      DEFAULT_POS_SALES_SETTINGS,
    )
    expect(entry.lines).toEqual([])
    expect(entry.problems).toEqual([{ code: 'not_balanced', params: { difference: -70 } }])
  })

  it('stops a day whose tender has no account, and a VAT-free sale by default', () => {
    const entry = buildPosDayEntry(
      day({
        vatGroups: [
          { ratePercent: 12, net: 22000, vat: 2640, gross: 24640 },
          { ratePercent: 0, net: 500, vat: 0, gross: 500 },
        ],
        sales: { net: 22500, vat: 2640, gross: 25140 },
        tenders: [
          { kind: 'card', method: 'card', amount: 24640, tips: 0, receiptCount: 100 },
          { kind: 'invoice', method: 'faktura', amount: 500, tips: 0, receiptCount: 1 },
        ],
      }),
      DEFAULT_POS_SALES_SETTINGS,
    )
    expect(entry.lines).toEqual([])
    expect(entry.problems).toEqual([
      { code: 'tender_unmapped', params: { kind: 'invoice', method: 'faktura', amount: 500 } },
      { code: 'vat_rate_unmapped', params: { rate: 0, gross: 500 } },
    ])
  })

  it('books VAT-free sales once a person chose the account (a gift card liability here)', () => {
    const settings: PosSalesSettings = applyPosSalesSettingsPatch(DEFAULT_POS_SALES_SETTINGS, { revenue_accounts: { '0': '2421' } })
    const entry = buildPosDayEntry(
      day({
        vatGroups: [{ ratePercent: 0, net: 500, vat: 0, gross: 500 }],
        sales: { net: 500, vat: 0, gross: 500 },
        tenders: [{ kind: 'card', method: 'card', amount: 500, tips: 0, receiptCount: 1 }],
      }),
      settings,
    )
    expect(entry.problems).toEqual([])
    expect(sides(entry.lines)).toEqual([
      ['1686', 500, 0, 'Kortbetalningar'],
      ['2421', 0, 500, 'Försäljning utan moms'],
    ])
  })

  it('swaps sides for a day with more refunds than sales on a line', () => {
    const entry = buildPosDayEntry(
      day({
        sales: { net: -100, vat: -12, gross: -112 },
        vatGroups: [{ ratePercent: 12, net: -100, vat: -12, gross: -112 }],
        tenders: [{ kind: 'card', method: 'card', amount: -112, tips: 0, receiptCount: 1 }],
      }),
      DEFAULT_POS_SALES_SETTINGS,
    )
    expect(entry.problems).toEqual([])
    expect(sides(entry.lines)).toEqual([
      ['1686', 0, 112, 'Kortbetalningar'],
      ['3002', 100, 0, 'Försäljning 12 % moms'],
      ['2621', 12, 0, 'Utgående moms 12 %'],
    ])
  })

  it('names another method in the line and keeps every line on one side only', () => {
    const settings = applyPosSalesSettingsPatch(DEFAULT_POS_SALES_SETTINGS, { tender_accounts: { other: '1689' } })
    const entry = buildPosDayEntry(
      day({
        sales: { net: 100, vat: 12, gross: 112 },
        vatGroups: [{ ratePercent: 12, net: 100, vat: 12, gross: 112 }],
        tenders: [{ kind: 'other', method: 'wechat', amount: 112, tips: 0, receiptCount: 1 }],
      }),
      settings,
    )
    expect(sides(entry.lines)[0]).toEqual(['1689', 112, 0, 'Betalsätt wechat'])
    for (const l of entry.lines) expect(l.debit_amount === 0 || l.credit_amount === 0).toBe(true)
  })
})

describe('evaluatePosDay', () => {
  it('is ready when the voucher balances and nothing was reported', () => {
    expect(evaluatePosDay(day(), DEFAULT_POS_SALES_SETTINGS)).toEqual({ status: 'ready', reasons: [], acknowledgeable: false })
  })

  it('is empty for a day without sales or payments', () => {
    const empty = day({
      sales: { net: 0, vat: 0, gross: 0 },
      vatGroups: [],
      tenders: [],
      receiptCount: 0,
    })
    expect(evaluatePosDay(empty, DEFAULT_POS_SALES_SETTINGS).status).toBe('empty')
  })

  it('needs review for provider issues, which a person may acknowledge', () => {
    const result = evaluatePosDay(
      day({ issues: [{ code: 'tips_counted_once', message: 'Kvitto 1: samma dricks stod på varje rad och räknades en gång' }] }),
      DEFAULT_POS_SALES_SETTINGS,
    )
    expect(result.status).toBe('needs_review')
    expect(result.acknowledgeable).toBe(true)
    expect(result.reasons).toEqual([
      {
        code: 'provider_issue',
        params: { code: 'tips_counted_once' },
        message: 'Kvitto 1: samma dricks stod på varje rad och räknades en gång',
      },
    ])
  })

  it('never lets an acknowledgement cover a missing account', () => {
    const settings = applyPosSalesSettingsPatch(DEFAULT_POS_SALES_SETTINGS, { tender_accounts: { card: null } })
    const result = evaluatePosDay(day({ issues: [{ code: 'prepaid_present', message: 'x' }] }), settings)
    expect(result.status).toBe('needs_review')
    expect(result.acknowledgeable).toBe(false)
    expect(result.reasons.map((r) => r.code)).toEqual(['tender_unmapped', 'provider_issue'])
  })

  it('flags payments without any sales', () => {
    const result = evaluatePosDay(
      day({ sales: { net: 0, vat: 0, gross: 0 }, vatGroups: [], tips: 50, tenders: [{ kind: 'card', method: 'card', amount: 50, tips: 50, receiptCount: 1 }] }),
      DEFAULT_POS_SALES_SETTINGS,
    )
    expect(result.status).toBe('needs_review')
    expect(result.reasons[0].code).toBe('payments_without_sales')
    expect(result.acknowledgeable).toBe(false)
  })
})

describe('posDayDescription', () => {
  it('says what, when, where and from which system', () => {
    expect(posDayDescription({ businessDate: '2026-09-30' }, 'Restaurang Exempel', 'Kassa AB')).toBe(
      'Dagskassa 2026-09-30 Restaurang Exempel (Kassa AB)',
    )
  })
})
