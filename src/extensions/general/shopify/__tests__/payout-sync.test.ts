import { beforeEach, describe, expect, it, vi } from 'vitest'

const { listPayoutsPage, storeWebshopPayouts } = vi.hoisted(() => ({ listPayoutsPage: vi.fn(), storeWebshopPayouts: vi.fn() }))
vi.mock('../lib/api-client', () => ({ listPayoutsPage: (...args: unknown[]) => listPayoutsPage(...args) }))
vi.mock('@/lib/webshop-orders/payout-store', () => ({ storeWebshopPayouts: (...args: unknown[]) => storeWebshopPayouts(...args) }))

import { planPayoutVoucher } from '@/lib/webshop-orders/payouts'
import { shopifyPayoutExternalId, shopifyPayoutRecord, syncShopifyPayouts } from '../lib/payout-sync'
import type { ShopifyPayout } from '../types'

const zero = { amount: '0.00' }
const money = (amount: string) => ({ amount })

/** 1 000 kr charged, 120 kr refunded, 34,50 kr in fees: 845,50 kr paid out. */
function payout(over: Partial<ShopifyPayout> = {}, summary: Partial<ShopifyPayout['summary']> = {}): ShopifyPayout {
  return {
    legacyResourceId: '168750317903',
    issuedAt: '2026-11-04T23:30:00Z',
    status: 'PAID',
    transactionType: 'DEPOSIT',
    net: { amount: '845.50', currencyCode: 'SEK' },
    summary: {
      adjustmentsFee: zero,
      adjustmentsGross: zero,
      advanceFees: zero,
      advanceGross: zero,
      chargesFee: money('34.50'),
      chargesGross: money('1000.00'),
      refundsFee: zero,
      refundsFeeGross: money('-120.00'),
      reservedFundsFee: zero,
      reservedFundsGross: zero,
      retriedPayoutsFee: zero,
      retriedPayoutsGross: zero,
      ...summary,
    },
    ...over,
  }
}

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() } as never

describe('shopifyPayoutRecord', () => {
  it('reads a paid deposit as sale, return and fee, adding up to the payout, dated the Swedish day', () => {
    const outcome = shopifyPayoutRecord('butik.myshopify.com', payout())
    expect(outcome).toEqual({
      ok: true,
      record: {
        platform: 'shopify',
        store_scope: 'butik.myshopify.com',
        external_id: shopifyPayoutExternalId('butik.myshopify.com', '168750317903'),
        reference: '168750317903',
        // 23:30 UTC on 4 November is 5 November in Stockholm.
        payout_date: '2026-11-05',
        currency: 'SEK',
        amount: 845.5,
        lines: [
          { kind: 'sale', amount: 1000 },
          { kind: 'return', amount: -120 },
          { kind: 'fee', amount: -34.5 },
        ],
      },
    })
    if (!outcome.ok) return
    // The verifikat the bank row is proposed: bank 845,50 + fee 34,50 = 1686 880,00, no fee VAT.
    const planned = planPayoutVoucher({ payout: outcome.record, clearingAccount: '1686', vatRegistered: true })
    if (!planned.ok) throw new Error(planned.reason)
    expect(planned.plan.lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])).toEqual([
      ['6570', 34.5, 0],
      ['1686', 0, 880],
    ])
  })

  it('reads fees reported as deductions the same way: the payout decides their sign', () => {
    const outcome = shopifyPayoutRecord('s', payout({}, { chargesFee: money('-34.50') }))
    expect(outcome.ok && outcome.record.lines).toEqual([
      { kind: 'sale', amount: 1000 },
      { kind: 'return', amount: -120 },
      { kind: 'fee', amount: -34.5 },
    ])
  })

  it('keeps reserved funds as a holdback or a release, and adjustments for a person', () => {
    const held = shopifyPayoutRecord('s', payout({ net: { amount: '745.50', currencyCode: 'SEK' } }, { reservedFundsGross: money('-100.00') }))
    expect(held.ok && held.record.lines).toContainEqual({ kind: 'holdback', amount: -100 })
    const adjusted = shopifyPayoutRecord('s', payout({ net: { amount: '840.50', currencyCode: 'SEK' } }, { adjustmentsGross: money('-5.00') }))
    expect(adjusted.ok && adjusted.record.lines).toContainEqual({ kind: 'adjustment', amount: -5 })
    if (!adjusted.ok) return
    expect(planPayoutVoucher({ payout: adjusted.record, clearingAccount: '1686', vatRegistered: true })).toEqual({ ok: false, reason: 'adjustment' })
  })

  it('leaves out a payout that is not a paid deposit, and one whose summary does not add up', () => {
    expect(shopifyPayoutRecord('s', payout({ status: 'SCHEDULED' }))).toEqual({ ok: false, reason: 'not_paid' })
    expect(shopifyPayoutRecord('s', payout({ status: 'FAILED' }))).toEqual({ ok: false, reason: 'not_paid' })
    expect(shopifyPayoutRecord('s', payout({ transactionType: 'WITHDRAWAL' }))).toEqual({ ok: false, reason: 'not_paid' })
    expect(shopifyPayoutRecord('s', payout({ status: 'IN_TRANSIT' })).ok).toBe(true)
    expect(shopifyPayoutRecord('s', payout({ net: { amount: '850.00', currencyCode: 'SEK' } }))).toEqual({ ok: false, reason: 'unreadable' })
    expect(shopifyPayoutRecord('s', payout({}, { chargesGross: money('abc') }))).toEqual({ ok: false, reason: 'unreadable' })
  })
})

describe('syncShopifyPayouts', () => {
  const args = { companyId: 'company-1', userId: 'user-1', shopScope: 'butik.myshopify.com', connectionId: 'conn-1', today: '2026-11-28' }

  beforeEach(() => {
    vi.clearAllMocks()
    storeWebshopPayouts.mockResolvedValue(undefined)
  })

  it('reads the last weeks\' payouts and stores the paid deposits', async () => {
    listPayoutsPage.mockResolvedValueOnce({ kind: 'page', payouts: [payout(), payout({ legacyResourceId: '2', status: 'SCHEDULED' })], hasNextPage: false, endCursor: null })
    const summary = await syncShopifyPayouts({} as never, {} as never, args, log)
    expect(summary).toEqual({ stored: 1, skipped: 1, scopeMissing: false })
    expect(listPayoutsPage).toHaveBeenCalledWith({}, { issuedOnOrAfter: '2026-10-24', after: null })
    const [, companyId, userId, records] = storeWebshopPayouts.mock.calls[0] as [unknown, string, string, Array<{ external_id: string }>]
    expect([companyId, userId, records.map((r) => r.external_id)]).toEqual(['company-1', 'user-1', [shopifyPayoutExternalId('butik.myshopify.com', '168750317903')]])
  })

  it('says the scopes are missing and stores nothing', async () => {
    listPayoutsPage.mockResolvedValueOnce({ kind: 'scope_missing' })
    expect(await syncShopifyPayouts({} as never, {} as never, args, log)).toEqual({ stored: 0, skipped: 0, scopeMissing: true })
    expect(storeWebshopPayouts).not.toHaveBeenCalled()
  })

  it('reads nothing more for a store without Shopify Payments', async () => {
    listPayoutsPage.mockResolvedValueOnce({ kind: 'no_account' })
    expect(await syncShopifyPayouts({} as never, {} as never, args, log)).toEqual({ stored: 0, skipped: 0, scopeMissing: false })
    expect(storeWebshopPayouts).not.toHaveBeenCalled()
  })
})
