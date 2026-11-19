/**
 * webshop-orders.* (crm#1032, crm#1066): an agent reads synced webshop
 * orders and books one with its own lines through the Orders page's own
 * write path. The doors are exercised in
 * app/api/v1/companies/[companyId]/webshop-orders/__tests__; these pin the
 * contract, the pure rules (booking status, advisories) and that a dry run
 * resolves the exchange rate without storing it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { createLogger } from '@/lib/logger'
import { webshopOrdersBook, webshopOrdersBookDay, webshopOrdersGet, webshopOrdersList } from '../webshop-orders'
import { webshopOrderBookingStatus } from '@/lib/webshop-orders/booking-status'
import { webshopOrderWarnings } from '@/lib/webshop-orders/service'
import { resolveOrderFx } from '@/lib/webshop-orders/book-order'
import type { WebshopOrder, WebshopStoreSettings } from '@/types'

const fetchExchangeRateMock = vi.fn()
vi.mock('@/lib/currency/riksbanken', () => ({
  fetchExchangeRate: (...a: unknown[]) => fetchExchangeRateMock(...a),
}))

function order(overrides: Partial<WebshopOrder> = {}): WebshopOrder {
  return {
    id: 'order-1',
    company_id: 'company-1',
    user_id: 'user-1',
    platform: 'shopify',
    store_scope: 'butik.myshopify.com',
    store_label: null,
    connection_id: null,
    row_type: 'order',
    parent_order_id: null,
    external_id: 'x',
    platform_order_id: '1',
    order_number: '1001',
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
    customer_name: null,
    customer_company: null,
    customer_email: null,
    customer_orgnr: null,
    customer_country: 'SE',
    payment_method: 'shopify_payments',
    payment_method_title: null,
    gateway_reference: null,
    refunded_total: 0,
    journal_entry_id: null,
    invoice_id: null,
    legacy_transaction_id: null,
    remote_changed_after_freeze: false,
    manually_booked_at: null,
    manually_booked_by: null,
    manually_booked_journal_entry_id: null,
    created_at: '2026-10-14T10:00:00Z',
    updated_at: '2026-10-14T10:00:00Z',
    ...overrides,
  }
}

const codes = (o: WebshopOrder, settings: WebshopStoreSettings | null = null) =>
  webshopOrderWarnings(o, settings).map((w) => w.code)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('webshop-orders: contract', () => {
  it('reads with transactions:read and never stages', () => {
    for (const op of [webshopOrdersList, webshopOrdersGet]) {
      expect(op.kind).toBe('read')
      expect(op.scope).toBe('transactions:read')
      expect(op.mcp?.stage).toBeUndefined()
    }
    expect(webshopOrdersList.mcp?.name).toBe('gnubok_list_webshop_orders')
    expect(webshopOrdersGet.mcp?.name).toBe('gnubok_get_webshop_order')
  })

  it('books as a high-risk, irreversible bookkeeping:write staged as book_webshop_order', () => {
    expect(webshopOrdersBook.kind).toBe('write')
    expect(webshopOrdersBook.scope).toBe('bookkeeping:write')
    expect(webshopOrdersBook.risk).toBe('high')
    expect(webshopOrdersBook.reversible).toBe(false)
    expect(webshopOrdersBook.http).toMatchObject({
      method: 'POST',
      path: '/api/v1/companies/:companyId/webshop-orders/:orderId/book',
      pathParams: { orderId: 'webshop_order_id' },
    })
    expect(webshopOrdersBook.mcp?.name).toBe('gnubok_book_webshop_order')
    expect(webshopOrdersBook.mcp?.stage?.pendingType).toBe('book_webshop_order')
  })

  it('books a day as a high-risk, irreversible bookkeeping:write staged as book_webshop_day, pinning the reviewed rows', () => {
    expect(webshopOrdersBookDay.kind).toBe('write')
    expect(webshopOrdersBookDay.scope).toBe('bookkeeping:write')
    expect(webshopOrdersBookDay.risk).toBe('high')
    expect(webshopOrdersBookDay.reversible).toBe(false)
    expect(webshopOrdersBookDay.http).toMatchObject({ method: 'POST', path: '/api/v1/companies/:companyId/webshop-orders/book-day' })
    expect(webshopOrdersBookDay.mcp?.name).toBe('gnubok_book_webshop_day')
    const stage = webshopOrdersBookDay.mcp?.stage
    expect(stage?.pendingType).toBe('book_webshop_day')
    const input = { platform: 'shopify', store_scope: 'butik.myshopify.com', date: '2026-10-14', payment_method: 'paypal' }
    expect(stage?.pinParams?.(input, { order_ids: ['a', 'b'], lines_sha256: 'f'.repeat(64) })).toEqual({
      ...input,
      expected_order_ids: ['a', 'b'],
      expected_lines_sha256: 'f'.repeat(64),
    })
  })

  it('requires a store, a day and a payment method for a day', () => {
    const day = { platform: 'shopify', store_scope: 'butik.myshopify.com', date: '2026-10-14', payment_method: 'paypal' }
    expect(webshopOrdersBookDay.input.safeParse(day).success).toBe(true)
    expect(webshopOrdersBookDay.input.safeParse({ ...day, date: '14/10/2026' }).success).toBe(false)
    expect(webshopOrdersBookDay.input.safeParse({ ...day, payment_method: '' }).success).toBe(false)
    expect(webshopOrdersBookDay.input.safeParse({ ...day, expected_order_ids: ['nope'] }).success).toBe(false)
  })

  it('requires the order id and at least two lines', () => {
    const lines = [
      { account_number: '1686', debit_amount: 125, credit_amount: 0 },
      { account_number: '3001', debit_amount: 0, credit_amount: 125 },
    ]
    expect(webshopOrdersBook.input.safeParse({ webshop_order_id: 'nope', lines }).success).toBe(false)
    expect(
      webshopOrdersBook.input.safeParse({ webshop_order_id: '3f2a4b5c-1d2e-4f3a-8b9c-0d1e2f3a4b5c', lines: [lines[0]] })
        .success,
    ).toBe(false)
    expect(
      webshopOrdersBook.input.safeParse({ webshop_order_id: '3f2a4b5c-1d2e-4f3a-8b9c-0d1e2f3a4b5c', lines }).success,
    ).toBe(true)
  })

  it('titles the approval after the order and pins the date, period and text the approver saw', () => {
    const stage = webshopOrdersBook.mcp!.stage!
    const preview = {
      order_number: '#1042',
      journal_entry: { entry_date: '2026-10-14', fiscal_period_id: 'fp-1', description: 'Order #1042' },
    }
    expect(stage.title({}, preview)).toBe('Bokför order #1042')
    expect(stage.title({}, undefined)).toBe('Bokför webshoporder')
    expect(stage.pinParams!({ webshop_order_id: 'o', lines: [] }, preview)).toEqual({
      webshop_order_id: 'o',
      lines: [],
      entry_date: '2026-10-14',
      fiscal_period_id: 'fp-1',
      description: 'Order #1042',
    })
    expect(stage.extras!({}, preview)).toEqual({ periodDate: '2026-10-14' })
  })
})

describe('webshopOrderBookingStatus', () => {
  it.each([
    [{ journal_entry_id: 'je' }, 'booked'],
    [{ manually_booked_at: '2026-10-15T00:00:00Z' }, 'marked_booked'],
    [{ invoice_id: 'inv' }, 'invoiced'],
    [{ legacy_transaction_id: 'tx' }, 'in_transactions'],
    [{ is_paid: false }, 'unpaid'],
    [{ is_paid: false, row_type: 'refund' as const }, 'to_book'],
    [{}, 'to_book'],
  ])('%o is %s', (overrides, status) => {
    expect(webshopOrderBookingStatus(order(overrides))).toBe(status)
  })
})

describe('webshopOrderWarnings', () => {
  it('says nothing for a Swedish order at a Swedish rate', () => {
    expect(codes(order())).toEqual([])
  })

  it('flags a gap above öre rounding the suggestion leaves out, not one it splits at the one rate (crm#1993)', () => {
    const twoRates = order({
      total: 300,
      total_tax: 37,
      total_sek: 300,
      vat_breakdown: [
        { rate: 25, net: 100, tax: 25 },
        { rate: 12, net: 100, tax: 12 },
      ],
    })
    expect(codes(twoRates)).toEqual(['vat_breakdown_gap'])
    expect(codes(order({ total: 164, total_sek: 164 }))).toEqual([])
  })

  it('flags a country outside Sweden, which the Swedish suggestion cannot know', () => {
    expect(codes(order({ customer_country: 'no' }))).toEqual(['country_outside_sweden'])
  })

  it('keeps the dialog\'s own advisories', () => {
    expect(
      codes(order({ customer_country: 'US', vat_breakdown: [{ rate: 0, net: 125, tax: 0 }], total_tax: 0 })),
    ).toEqual(['country_outside_sweden', 'zero_rate_foreign'])
    expect(codes(order({ currency: 'EUR' }))).toEqual(['foreign_vat'])
  })

  it('flags a non-Swedish VAT rate and a missing VAT split', () => {
    expect(codes(order({ customer_country: 'DE', vat_breakdown: [{ rate: 19, net: 100, tax: 19 }] }))).toEqual([
      'country_outside_sweden',
      'unsupported_vat_rate',
    ])
    expect(codes(order({ vat_breakdown: [] }))).toEqual(['vat_breakdown_missing'])
  })

  it('drops the outside-Sweden hints for buckets the store\'s country rules book (crm#1032)', () => {
    const settings = {
      payment_method_account_map: {},
      country_account_rules: [
        { country: 'EU', vat_rate: null, mode: 'accounts', revenue_account: '3106', vat_account: '2670' },
      ],
    } as unknown as WebshopStoreSettings
    expect(
      codes(order({ customer_country: 'DE', vat_breakdown: [{ rate: 19, net: 100, tax: 19 }] }), settings),
    ).toEqual([])
    // Norway is outside the EU rule: the hint stays.
    expect(codes(order({ customer_country: 'NO' }), settings)).toEqual(['country_outside_sweden'])
  })

  it('flags an order without a country when the store has country rules, like the dialog', () => {
    const settings = {
      payment_method_account_map: {},
      country_account_rules: [
        { country: 'EU', vat_rate: null, mode: 'accounts', revenue_account: '3106', vat_account: '2670' },
      ],
    } as unknown as WebshopStoreSettings
    expect(codes(order({ customer_country: null }), settings)).toEqual(['country_unknown'])
    expect(webshopOrderWarnings(order({ customer_country: null }), settings)[0].message_sv).toContain(
      'saknar leveransland',
    )
    // No rules: the store has not said it sells abroad.
    expect(codes(order({ customer_country: null }))).toEqual([])
  })

  it('flags a payment method the store routes to the invoice flow', () => {
    const settings = {
      payment_method_account_map: { shopify_payments: { mode: 'invoice' } },
    } as unknown as WebshopStoreSettings
    expect(codes(order(), settings)).toEqual(['invoice_mode_method'])
  })
})

describe('resolveOrderFx', () => {
  it('a dry run resolves the rate without storing it', async () => {
    const { supabase, calls } = createQueuedMockSupabase()
    fetchExchangeRateMock.mockResolvedValue({ rate: 11.5 })
    const resolved = await resolveOrderFx(
      supabase as never,
      'company-1',
      order({ currency: 'EUR', total: 100, total_sek: null, exchange_rate: null }),
      createLogger('test'),
      { persist: false },
    )
    expect(resolved).toMatchObject({ total_sek: 1150, exchange_rate: 11.5 })
    expect(calls.some((c) => c.method === 'update')).toBe(false)
  })
})
