import { describe, expect, it, vi } from 'vitest'
import { createFakeDb } from '@/lib/pos-sales/__tests__/fake-db'
import type { WebshopOrder, WebshopStoreSettings } from '@/types'
import { deriveUnattendedOrderLines } from '../unattended-lines'

// The FX retry reads Riksbanken; no rate here, so a non-SEK order without one stays unresolved.
vi.mock('@/lib/currency/riksbanken', () => ({ fetchExchangeRate: vi.fn(async () => null) }))

const COMPANY = 'company-1'
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() } as never

function order(overrides: Partial<WebshopOrder> = {}): WebshopOrder {
  return {
    id: 'order-1',
    company_id: COMPANY,
    platform: 'shopify',
    store_scope: 'butik.myshopify.com',
    store_label: 'Butiken',
    row_type: 'order',
    parent_order_id: null,
    order_number: '#1001',
    status: 'paid',
    is_paid: true,
    order_date: '2026-10-14',
    paid_date: '2026-10-14',
    currency: 'SEK',
    total: 125,
    total_tax: 25,
    total_sek: 125,
    exchange_rate: 1,
    vat_breakdown: [{ rate: 25, net: 100, tax: 25 }],
    line_items: [],
    customer_country: 'SE',
    payment_method: 'shopify_payments',
    payment_method_title: 'shopify_payments',
    journal_entry_id: null,
    invoice_id: null,
    manually_booked_at: null,
    legacy_transaction_id: null,
    ...overrides,
  } as WebshopOrder
}

function derive(o: WebshopOrder, settings: Partial<WebshopStoreSettings> | null = null, extra = {}) {
  const db = createFakeDb({ webshop_orders: [o as unknown as Record<string, unknown>] })
  return deriveUnattendedOrderLines({
    supabase: db.client as never,
    companyId: COMPANY,
    order: o,
    settings: settings as WebshopStoreSettings | null,
    log,
    ...extra,
  })
}

describe('deriveUnattendedOrderLines', () => {
  it('derives the order\'s balanced lines', async () => {
    const outcome = await derive(order())
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])).toEqual([
      ['1686', 125, 0],
      ['3001', 0, 100],
      ['2611', 0, 25],
    ])
  })

  it.each([
    ['a booked order', order({ journal_entry_id: 'je-1' }), 'WEBSHOP_ORDER_ALREADY_BOOKED'],
    ['an unpaid order', order({ is_paid: false }), 'WEBSHOP_ORDER_NOT_PAID'],
    ['an order without a VAT split', order({ vat_breakdown: [] }), 'WEBSHOP_ORDER_VAT_BREAKDOWN_MISSING'],
    [
      'a non-Swedish rate on the Swedish accounts',
      order({ vat_breakdown: [{ rate: 19, net: 100, tax: 19 }], total: 119, total_tax: 19, total_sek: 119 }),
      'WEBSHOP_ORDER_UNSUPPORTED_VAT_RATE',
    ],
    [
      'a gross total that does not match the split',
      order({ total: 130, total_sek: 130 }),
      'WEBSHOP_ORDER_RESIDUAL_TOO_LARGE',
    ],
    ['a non-SEK order without a rate', order({ currency: 'XXX', total_sek: null, exchange_rate: null }), 'WEBSHOP_ORDER_FX_UNRESOLVED'],
  ])('refuses %s', async (_label, o, code) => {
    expect(await derive(o, null, { persistFx: false })).toMatchObject({ ok: false, code })
  })

  it('refuses a payment method the store sends through the invoice flow', async () => {
    const settings = { payment_method_account_map: { shopify_payments: { mode: 'invoice' } } }
    expect(await derive(order(), settings as never)).toMatchObject({ ok: false, code: 'WEBSHOP_ORDER_INVOICE_MODE_METHOD' })
  })

  it('refuses a 0 % template account the order\'s country contradicts', async () => {
    // WooCommerce: Shopify's country rules would refuse an unrouted DE order first.
    const o = order({ platform: 'woocommerce', customer_country: 'DE', total: 100, total_tax: 0, total_sek: 100, vat_breakdown: [{ rate: 0, net: 100, tax: 0 }] })
    const outcome = await derive(o, null, {
      revenueAccounts: { 0: '3105' },
      zeroRate: { account: '3105', box: '36', contradicted: (country: string) => country === 'DE' },
    })
    expect(outcome).toMatchObject({ ok: false, code: 'WEBSHOP_ORDER_ZERO_RATE_CONTEXT_MISMATCH', details: { customer_country: 'DE' } })
  })
})
