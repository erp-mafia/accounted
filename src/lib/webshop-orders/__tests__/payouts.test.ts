import { describe, expect, it } from 'vitest'
import type { WebshopPayout } from '@/types'
import { feeVatFitsRate, payoutDescription, payoutLine, payoutLines, planPayoutVoucher } from '../payouts'

/** Kustom's report of the route test: 1 250 sold, 300 returned, 12,50 fees and 3,13 VAT on them, 934,37 paid out. */
const kustom: Pick<WebshopPayout, 'platform' | 'reference' | 'payout_date' | 'currency' | 'amount' | 'lines'> = {
  platform: 'kustom',
  reference: 'PAY123',
  payout_date: '2026-11-19',
  currency: 'SEK',
  amount: 934.37,
  lines: payoutLines([
    ['sale', 1250],
    ['return', 300],
    ['fee', 12.5],
    ['fee_vat', 3.13],
  ]),
}

const rows = (plan: { lines: Array<{ account_number: string; debit_amount: number; credit_amount: number }> }) =>
  plan.lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])

describe('payoutLine', () => {
  it('signs each part toward the payout and drops zero parts', () => {
    expect(payoutLine('sale', -1250)).toEqual({ kind: 'sale', amount: 1250 })
    expect(payoutLine('return', 300)).toEqual({ kind: 'return', amount: -300 })
    expect(payoutLine('fee', 12.5)).toEqual({ kind: 'fee', amount: -12.5 })
    expect(payoutLine('holdback', 50)).toEqual({ kind: 'holdback', amount: -50 })
    expect(payoutLine('release', -50)).toEqual({ kind: 'release', amount: 50 })
    expect(payoutLine('adjustment', -0.5)).toEqual({ kind: 'adjustment', amount: -0.5 })
    expect(payoutLine('reversal', 0)).toBeNull()
  })
})

describe('planPayoutVoucher', () => {
  it('books the fees and their VAT as cost and input VAT, and credits the clearing account gross', () => {
    const planned = planPayoutVoucher({ payout: kustom, clearingAccount: '1686', vatRegistered: true })
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    expect(planned.plan).toMatchObject({ clearing: 950, fees: 12.5, feeVat: 3.13 })
    expect(rows(planned.plan)).toEqual([
      ['6570', 12.5, 0],
      ['2641', 3.13, 0],
      ['1686', 0, 950],
    ])
    // With the bank net beside it, the verifikat balances.
    const debit = 934.37 + 12.5 + 3.13
    expect(Math.abs(debit - 950)).toBeLessThan(0.005)
  })

  it('books the VAT as part of the cost for a company that is not VAT-registered', () => {
    const planned = planPayoutVoucher({ payout: kustom, clearingAccount: '1686', vatRegistered: false })
    if (!planned.ok) throw new Error(planned.reason)
    expect(rows(planned.plan)).toEqual([
      ['6570', 15.63, 0],
      ['1686', 0, 950],
    ])
  })

  it('books a fee without VAT on its own, and a payout without fees as the clearing account alone', () => {
    const shopify = { ...kustom, platform: 'shopify' as const, amount: 965.5, lines: payoutLines([['sale', 1000], ['fee', 34.5]]) }
    const withFee = planPayoutVoucher({ payout: shopify, clearingAccount: '1686', vatRegistered: true })
    if (!withFee.ok) throw new Error(withFee.reason)
    expect(rows(withFee.plan)).toEqual([
      ['6570', 34.5, 0],
      ['1686', 0, 1000],
    ])
    const noFee = planPayoutVoucher({ payout: { ...kustom, amount: 1000, lines: payoutLines([['sale', 1000]]) }, clearingAccount: '1687', vatRegistered: true })
    if (!noFee.ok) throw new Error(noFee.reason)
    expect(rows(noFee.plan)).toEqual([['1687', 0, 1000]])
  })

  it('keeps holdbacks and releases inside the clearing credit: only fees are costs', () => {
    const payout = { ...kustom, amount: 884.37, lines: payoutLines([['sale', 1250], ['return', 300], ['fee', 12.5], ['fee_vat', 3.13], ['holdback', 100], ['release', 50]]) }
    const planned = planPayoutVoucher({ payout, clearingAccount: '1686', vatRegistered: true })
    if (!planned.ok) throw new Error(planned.reason)
    expect(planned.plan.clearing).toBe(900)
    expect(rows(planned.plan)).toEqual([
      ['6570', 12.5, 0],
      ['2641', 3.13, 0],
      ['1686', 0, 900],
    ])
  })

  it('refuses a payout in another currency, parts that do not add up, and a payout that settles nothing', () => {
    expect(planPayoutVoucher({ payout: { ...kustom, currency: 'EUR' }, clearingAccount: '1686', vatRegistered: true })).toEqual({ ok: false, reason: 'currency' })
    expect(planPayoutVoucher({ payout: { ...kustom, amount: 934.38 }, clearingAccount: '1686', vatRegistered: true })).toEqual({ ok: false, reason: 'parts_do_not_add_up' })
    const negative = { ...kustom, amount: -10, lines: payoutLines([['sale', 10], ['fee', 20]]) }
    expect(planPayoutVoucher({ payout: negative, clearingAccount: '1686', vatRegistered: true })).toEqual({ ok: false, reason: 'nothing_to_clear' })
  })
})

describe('what a person books instead', () => {
  it('proposes no payout with a part the report does not name: a commission, a fee correction, a repayment', () => {
    const payout = { ...kustom, amount: 924.37, lines: [...kustom.lines, { kind: 'adjustment' as const, amount: -10 }] }
    expect(planPayoutVoucher({ payout, clearingAccount: '1686', vatRegistered: true })).toEqual({ ok: false, reason: 'adjustment' })
  })

  it('proposes no payout whose fee VAT is not 25 % of its fees', () => {
    const payout = { ...kustom, amount: 931.94, lines: payoutLines([['sale', 1250], ['return', 300], ['fee', 12.5], ['fee_vat', 5.56]]) }
    expect(planPayoutVoucher({ payout, clearingAccount: '1686', vatRegistered: true })).toEqual({ ok: false, reason: 'fee_vat_rate' })
  })
})

describe('feeVatFitsRate', () => {
  it('takes the rounding of one fee line at a time: a krona, or 0,5 % of the VAT on a large payout', () => {
    expect(feeVatFitsRate(12.5, 3.13)).toBe(true)
    expect(feeVatFitsRate(12.5, 4.12)).toBe(true)
    expect(feeVatFitsRate(12.5, 4.2)).toBe(false)
    expect(feeVatFitsRate(10000, 2510)).toBe(true)
    expect(feeVatFitsRate(10000, 2515)).toBe(false)
  })
})

describe('payoutDescription', () => {
  it('names the provider, the reference and the day', () => {
    expect(payoutDescription(kustom)).toBe('Utbetalning Kustom PAY123 2026-11-19')
    expect(payoutDescription({ platform: 'shopify', reference: null, payout_date: '2026-11-05' })).toBe('Utbetalning Shopify Payments 2026-11-05')
  })
})
