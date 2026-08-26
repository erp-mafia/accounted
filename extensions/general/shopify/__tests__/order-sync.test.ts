import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const listOrdersPage = vi.fn()
const createShopifySession = vi.fn()

vi.mock('../lib/api-client', () => ({
  listOrdersPage: (...args: unknown[]) => listOrdersPage(...args),
  createShopifySession: (...args: unknown[]) => createShopifySession(...args),
  isRevokedCredentialsError: (error: unknown) =>
    error instanceof Error && error.message === 'REVOKED',
}))

vi.mock('@/lib/webshop-orders/ingest', () => ({
  upsertWebshopOrders: vi.fn(),
}))

import { upsertWebshopOrders } from '@/lib/webshop-orders/ingest'
import type { WebshopOrderUpsert } from '@/lib/webshop-orders/types'
import { encryptCredential } from '../lib/credentials'
import {
  SHOPIFY_IMPORT_SOURCE,
  buildRefundVatBreakdown,
  buildVatBreakdown,
  mapLineItems,
  mapOrderToWebshopRow,
  mapRefundToWebshopRow,
  orderAmountUnparseable,
  orderQualifies,
  shopifyOrderExternalId,
  shopifyRefundExternalId,
  shopifyShopScope,
  syncShopifyOrders,
} from '../lib/order-sync'
import type {
  ShopifyConnection,
  ShopifyLineItem,
  ShopifyOrder,
  ShopifyRefund,
  ShopifyShippingLine,
  ShopifyTaxLine,
} from '../types'

// Set before the describe bodies run: makeConnection() encrypts credentials
// at collection time (same pattern as the WooCommerce order-sync test).
process.env.SHOPIFY_CREDENTIALS_ENCRYPTION_KEY = 'test-key'

const emptyUpsertResult = {
  inserted: 0,
  updated: 0,
  unchanged: 0,
  frozenFlagged: 0,
  crossMarked: 0,
  errors: 0,
}

function makeConnection(overrides: Partial<ShopifyConnection> = {}): ShopifyConnection {
  return {
    id: 'conn-1',
    company_id: 'company-1',
    user_id: 'user-1',
    shop_domain: 'minbutik.myshopify.com',
    shop_name: 'Testbutiken',
    client_id_encrypted: encryptCredential('client-id'),
    client_secret_encrypted: encryptCredential('client-secret'),
    status: 'active',
    currency: 'SEK',
    transaction_sync_enabled: true,
    last_order_synced_at: null,
    error_message: null,
    connected_at: '2026-07-01T00:00:00.000Z',
    disconnected_at: null,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  }
}

function money(amount: string, currencyCode = 'SEK') {
  return { shopMoney: { amount, currencyCode } }
}

function taxLine(ratePercentage: number | null, amount: string): ShopifyTaxLine {
  return { ratePercentage, priceSet: money(amount) }
}

function lineItem(
  name: string,
  quantity: number,
  total: string,
  taxLines: ShopifyTaxLine[] = [],
): ShopifyLineItem {
  return { name, quantity, discountedTotalSet: money(total), taxLines }
}

function shippingLine(
  title: string | null,
  price: string,
  taxLines: ShopifyTaxLine[] = [],
): ShopifyShippingLine {
  return { title, discountedPriceSet: money(price), taxLines }
}

function conn<T>(nodes: T[], hasNextPage = false) {
  return { pageInfo: { hasNextPage }, nodes }
}

/**
 * Default order: tax-inclusive Swedish store, 1250 kr gross at 25% VAT
 * (1000 net + 250 moms), one product line covering the whole total.
 */
function makeOrder(overrides: Partial<ShopifyOrder> = {}): ShopifyOrder {
  return {
    legacyResourceId: '1042',
    name: '#1042',
    test: false,
    createdAt: '2026-08-01T09:00:00Z',
    processedAt: '2026-08-01T09:04:30Z',
    updatedAt: '2026-08-01T09:05:00Z',
    displayFinancialStatus: 'PAID',
    paymentGatewayNames: ['Klarna'],
    taxesIncluded: true,
    totalPriceSet: money('1250.00'),
    taxLines: [taxLine(25, '250.00')],
    lineItems: conn([lineItem('Produkt A', 2, '1250.00', [taxLine(25, '250.00')])]),
    shippingLines: conn<ShopifyShippingLine>([]),
    refunds: [],
    ...overrides,
  }
}

function makeRefund(overrides: Partial<ShopifyRefund> = {}): ShopifyRefund {
  return {
    legacyResourceId: '77',
    createdAt: '2026-08-03T10:00:00Z',
    totalRefundedSet: money('250.00'),
    ...overrides,
  }
}

/** One-page result helper; the loop terminates on hasNextPage: false. */
function page(orders: ShopifyOrder[], hasNextPage = false, endCursor: string | null = null) {
  return { orders, hasNextPage, endCursor }
}

/** Minimal chainable supabase mock covering the sync's query patterns. */
function makeSupabaseMock() {
  const updates: Array<{ table: string; values: Record<string, unknown> }> = []
  const client = {
    from(table: string) {
      const builder = {
        select: () => builder,
        eq: () => builder,
        update: (values: Record<string, unknown>) => {
          updates.push({ table, values })
          return builder
        },
      }
      return builder
    },
  }
  return { client: client as unknown as SupabaseClient, updates }
}

function cursorUpdates(updates: Array<{ table: string; values: Record<string, unknown> }>) {
  return updates.filter(
    (u) => u.table === 'shopify_connections' && 'last_order_synced_at' in u.values,
  )
}

function upsertedRows(call = 0): WebshopOrderUpsert[] {
  return vi.mocked(upsertWebshopOrders).mock.calls[call][3] as WebshopOrderUpsert[]
}

beforeEach(() => {
  vi.clearAllMocks()
  createShopifySession.mockResolvedValue({
    shopDomain: 'minbutik.myshopify.com',
    accessToken: 'token-1',
  })
  listOrdersPage.mockResolvedValue(page([]))
  vi.mocked(upsertWebshopOrders).mockResolvedValue({ ...emptyUpsertResult })
})

describe('frozen external_id formats', () => {
  // ⚠️ These assert the exact persisted formats. If this test fails, you are
  // about to orphan every previously imported Shopify row: do not update the
  // expectation without a coordinated backfill (see order-sync.ts).
  it('order id format is frozen', () => {
    expect(shopifyOrderExternalId('minbutik.myshopify.com', '1042')).toBe(
      'shopify_minbutik.myshopify.com_order_1042',
    )
  })

  it('refund id format is frozen', () => {
    expect(shopifyRefundExternalId('minbutik.myshopify.com', '77')).toBe(
      'shopify_minbutik.myshopify.com_refund_77',
    )
  })

  it('shop scope is the stored shop domain', () => {
    expect(shopifyShopScope('minbutik.myshopify.com')).toBe('minbutik.myshopify.com')
  })

  it('retired feed import source is frozen', () => {
    expect(SHOPIFY_IMPORT_SOURCE).toBe('shopify')
  })
})

describe('orderQualifies', () => {
  it('requires a paid financial status and excludes test orders', () => {
    expect(orderQualifies(makeOrder())).toBe(true)
    expect(orderQualifies(makeOrder({ displayFinancialStatus: 'PARTIALLY_REFUNDED' }))).toBe(true)
    expect(orderQualifies(makeOrder({ displayFinancialStatus: 'REFUNDED' }))).toBe(true)
    expect(orderQualifies(makeOrder({ displayFinancialStatus: 'PENDING' }))).toBe(false)
    expect(orderQualifies(makeOrder({ displayFinancialStatus: 'AUTHORIZED' }))).toBe(false)
    expect(orderQualifies(makeOrder({ displayFinancialStatus: 'PARTIALLY_PAID' }))).toBe(false)
    expect(orderQualifies(makeOrder({ displayFinancialStatus: null }))).toBe(false)
    expect(orderQualifies(makeOrder({ test: true }))).toBe(false)
  })
})

describe('buildVatBreakdown', () => {
  it('derives per-rate nets from the order-level tax lines', () => {
    expect(buildVatBreakdown(makeOrder())).toEqual([{ rate: 25, net: 1000, tax: 250 }])
  })

  it('handles mixed rates, highest first', () => {
    const order = makeOrder({
      totalPriceSet: money('1362.00'),
      taxLines: [taxLine(12, '12.00'), taxLine(25, '250.00')],
    })
    // 25%: net 1000 + 250; 12%: net 100 + 12 = 1362 total, no remainder.
    expect(buildVatBreakdown(order)).toEqual([
      { rate: 25, net: 1000, tax: 250 },
      { rate: 12, net: 100, tax: 12 },
    ])
  })

  it('books the uncovered remainder as a 0%-bucket (zero-rated goods)', () => {
    const order = makeOrder({
      totalPriceSet: money('1750.00'),
      taxLines: [taxLine(25, '250.00')],
    })
    expect(buildVatBreakdown(order)).toEqual([
      { rate: 25, net: 1000, tax: 250 },
      { rate: 0, net: 500, tax: 0 },
    ])
  })

  it('maps an entirely untaxed order to one 0%-bucket', () => {
    const order = makeOrder({ totalPriceSet: money('900.00'), taxLines: [] })
    expect(buildVatBreakdown(order)).toEqual([{ rate: 0, net: 900, tax: 0 }])
  })

  it('leaves öre-level drift to the booking residual instead of a fake 0%-sale', () => {
    const order = makeOrder({
      totalPriceSet: money('1250.30'),
      taxLines: [taxLine(25, '250.00')],
    })
    expect(buildVatBreakdown(order)).toEqual([{ rate: 25, net: 1000, tax: 250 }])
  })

  it('refuses a breakdown when a charged tax has no reported rate', () => {
    const order = makeOrder({ taxLines: [taxLine(null, '250.00')] })
    expect(buildVatBreakdown(order)).toEqual([])
  })

  it('refuses a breakdown whose buckets exceed the charged total', () => {
    const order = makeOrder({
      totalPriceSet: money('500.00'),
      taxLines: [taxLine(25, '250.00')],
    })
    expect(buildVatBreakdown(order)).toEqual([])
  })

  it('returns [] for zero or unparseable totals', () => {
    expect(buildVatBreakdown(makeOrder({ totalPriceSet: money('0.00') }))).toEqual([])
    expect(buildVatBreakdown(makeOrder({ totalPriceSet: money('nope') }))).toEqual([])
  })
})

describe('buildRefundVatBreakdown', () => {
  it("prorates the parent order's mix by refund/order ratio", () => {
    const { breakdown, totalTax } = buildRefundVatBreakdown(makeOrder(), makeRefund())
    // 250 / 1250 = 20% of {net 1000, tax 250}.
    expect(breakdown).toEqual([{ rate: 25, net: 200, tax: 50 }])
    expect(totalTax).toBe(50)
  })

  it('still prorates the parent TOTAL tax when per-rate bucketing is refused', () => {
    // Unreported rate: buildVatBreakdown refuses, but the parent was taxed.
    // The refund row must still carry the moms reversal (total_tax), which
    // the booking dialog's ratio-inference fallback turns into an editable
    // bucket instead of a silent 0%-refund.
    const order = makeOrder({ taxLines: [taxLine(null, '250.00')] })
    expect(buildRefundVatBreakdown(order, makeRefund())).toEqual({
      breakdown: [],
      totalTax: 50,
    })
  })

  it('returns zero tax when the parent genuinely carried none', () => {
    const order = makeOrder({ totalPriceSet: money('900.00'), taxLines: [] })
    // Parent maps to one 0%-bucket, prorating it yields a 0-tax bucket set.
    const { totalTax } = buildRefundVatBreakdown(order, makeRefund())
    expect(totalTax).toBe(0)
  })

  it('returns an empty breakdown for zero-amount refunds', () => {
    expect(
      buildRefundVatBreakdown(makeOrder(), makeRefund({ totalRefundedSet: money('0') })),
    ).toEqual({ breakdown: [], totalTax: 0 })
  })
})

describe('mapLineItems', () => {
  it('decomposes tax-inclusive lines into net + tax with the line rate', () => {
    expect(mapLineItems(makeOrder())).toEqual([
      { name: 'Produkt A', quantity: 2, total: 1000, total_tax: 250, vat_rate: 25 },
    ])
  })

  it('keeps tax-exclusive line totals as the net', () => {
    const order = makeOrder({
      taxesIncluded: false,
      lineItems: conn([lineItem('Produkt A', 2, '1000.00', [taxLine(25, '250.00')])]),
    })
    expect(mapLineItems(order)).toEqual([
      { name: 'Produkt A', quantity: 2, total: 1000, total_tax: 250, vat_rate: 25 },
    ])
  })

  it('includes shipping as its own line and marks untaxed lines 0%', () => {
    const order = makeOrder({
      totalPriceSet: money('1329.00'),
      taxLines: [taxLine(25, '265.80')],
      lineItems: conn([lineItem('Produkt A', 2, '1250.00', [taxLine(25, '250.00')])]),
      shippingLines: conn([shippingLine(null, '79.00', [taxLine(25, '15.80')])]),
    })
    expect(mapLineItems(order)).toEqual([
      { name: 'Produkt A', quantity: 2, total: 1000, total_tax: 250, vat_rate: 25 },
      { name: 'Frakt', quantity: 1, total: 63.2, total_tax: 15.8, vat_rate: 25 },
    ])
  })

  it('drops the snapshot when the parts do not reconstruct the charged total', () => {
    // Cart-level discount: 100 kr off the total that discountedTotalSet does
    // not carry. An invoice built from these lines would overbill.
    const order = makeOrder({ totalPriceSet: money('1150.00') })
    expect(mapLineItems(order)).toEqual([])
  })

  it('drops the snapshot when the line-item page is truncated', () => {
    const order = makeOrder({
      lineItems: conn([lineItem('Produkt A', 2, '1250.00', [taxLine(25, '250.00')])], true),
    })
    expect(mapLineItems(order)).toEqual([])
  })

  it('drops the snapshot when the shipping-line page is truncated', () => {
    const order = makeOrder({
      shippingLines: conn<ShopifyShippingLine>([], true),
    })
    expect(mapLineItems(order)).toEqual([])
  })

  it('stores vat_rate null for a part taxed at two different rates', () => {
    const order = makeOrder({
      totalPriceSet: money('1370.00'),
      taxLines: [taxLine(25, '250.00'), taxLine(12, '12.00')],
      lineItems: conn([
        lineItem('Paket', 1, '1370.00', [taxLine(25, '250.00'), taxLine(12, '12.00')]),
      ]),
    })
    expect(mapLineItems(order)).toEqual([
      { name: 'Paket', quantity: 1, total: 1108, total_tax: 262, vat_rate: null },
    ])
  })
})

describe('mapOrderToWebshopRow', () => {
  const connection = makeConnection()

  it('maps a paid order to a full webshop_orders upsert row', () => {
    const rows = mapOrderToWebshopRow(connection, 'minbutik.myshopify.com', makeOrder())
    expect(rows).toEqual([
      {
        platform: 'shopify',
        store_scope: 'minbutik.myshopify.com',
        store_label: 'Testbutiken',
        connection_id: 'conn-1',
        row_type: 'order',
        parent_external_id: null,
        external_id: 'shopify_minbutik.myshopify.com_order_1042',
        platform_order_id: '1042',
        order_number: '#1042',
        status: 'paid',
        is_paid: true,
        order_date: '2026-08-01',
        paid_date: '2026-08-01',
        currency: 'SEK',
        total: 1250,
        total_tax: 250,
        vat_breakdown: [{ rate: 25, net: 1000, tax: 250 }],
        line_items: [
          { name: 'Produkt A', quantity: 2, total: 1000, total_tax: 250, vat_rate: 25 },
        ],
        customer_name: null,
        customer_company: null,
        customer_email: null,
        customer_orgnr: null,
        customer_country: null,
        payment_method: 'Klarna',
        payment_method_title: 'Klarna',
        gateway_reference: null,
        refunded_total: 0,
      },
    ])
  })

  it('uppercases the currency and reports the summed refund total', () => {
    const order = makeOrder({
      totalPriceSet: money('1250.00', 'eur'),
      displayFinancialStatus: 'PARTIALLY_REFUNDED',
      refunds: [makeRefund(), makeRefund({ legacyResourceId: '78' })],
    })
    const [row] = mapOrderToWebshopRow(connection, 's', order)
    expect(row.currency).toBe('EUR')
    expect(row.status).toBe('partially_refunded')
    expect(row.refunded_total).toBe(500)
  })

  it('joins multiple gateways into the title and keys on the first', () => {
    const order = makeOrder({ paymentGatewayNames: ['Shopify Payments', 'gift_card'] })
    const [row] = mapOrderToWebshopRow(connection, 's', order)
    expect(row.payment_method).toBe('Shopify Payments')
    expect(row.payment_method_title).toBe('Shopify Payments, gift_card')
  })

  it('leaves the payment method null when no gateways are reported', () => {
    const [row] = mapOrderToWebshopRow(connection, 's', makeOrder({ paymentGatewayNames: [] }))
    expect(row.payment_method).toBeNull()
    expect(row.payment_method_title).toBeNull()
  })

  it('skips unpaid, test, zero-total and unparseable orders', () => {
    expect(
      mapOrderToWebshopRow(connection, 's', makeOrder({ displayFinancialStatus: 'PENDING' })),
    ).toEqual([])
    expect(mapOrderToWebshopRow(connection, 's', makeOrder({ test: true }))).toEqual([])
    expect(
      mapOrderToWebshopRow(connection, 's', makeOrder({ totalPriceSet: money('0.00') })),
    ).toEqual([])
    expect(
      mapOrderToWebshopRow(connection, 's', makeOrder({ totalPriceSet: money('nope') })),
    ).toEqual([])
    expect(orderAmountUnparseable(makeOrder({ totalPriceSet: money('nope') }))).toBe(true)
  })
})

describe('mapRefundToWebshopRow', () => {
  const connection = makeConnection()

  it('maps a refund to a negative row parented to its order', () => {
    const rows = mapRefundToWebshopRow(
      connection,
      'minbutik.myshopify.com',
      makeOrder(),
      makeRefund(),
    )
    expect(rows).toEqual([
      {
        platform: 'shopify',
        store_scope: 'minbutik.myshopify.com',
        store_label: 'Testbutiken',
        connection_id: 'conn-1',
        row_type: 'refund',
        parent_external_id: 'shopify_minbutik.myshopify.com_order_1042',
        external_id: 'shopify_minbutik.myshopify.com_refund_77',
        platform_order_id: '77',
        order_number: '#1042',
        status: 'refund',
        is_paid: true,
        order_date: '2026-08-03',
        paid_date: '2026-08-03',
        currency: 'SEK',
        total: -250,
        total_tax: -50,
        vat_breakdown: [{ rate: 25, net: 200, tax: 50 }],
        line_items: [],
        customer_name: null,
        customer_company: null,
        customer_email: null,
        customer_orgnr: null,
        customer_country: null,
        payment_method: 'Klarna',
        payment_method_title: 'Klarna',
        gateway_reference: null,
        refunded_total: 0,
      },
    ])
  })

  it('skips zero-amount refunds', () => {
    expect(
      mapRefundToWebshopRow(connection, 's', makeOrder(), makeRefund({ totalRefundedSet: money('0') })),
    ).toEqual([])
  })
})

describe('syncShopifyOrders', () => {
  it('upserts order and refund rows and advances the cursor', async () => {
    const { client, updates } = makeSupabaseMock()
    const order = makeOrder({
      displayFinancialStatus: 'PARTIALLY_REFUNDED',
      refunds: [makeRefund()],
    })
    listOrdersPage.mockResolvedValueOnce(page([order]))
    vi.mocked(upsertWebshopOrders).mockResolvedValueOnce({
      ...emptyUpsertResult,
      inserted: 2,
    })

    const summary = await syncShopifyOrders(client, makeConnection())

    expect(summary).toMatchObject({
      fetched: 1,
      refundsFetched: 1,
      inserted: 2,
      updated: 0,
      errors: 0,
    })
    expect(upsertWebshopOrders).toHaveBeenCalledTimes(1)
    const [, companyId, userId] = vi.mocked(upsertWebshopOrders).mock.calls[0]
    expect(companyId).toBe('company-1')
    expect(userId).toBe('user-1')
    const rows = upsertedRows()
    expect(rows.map((r) => r.external_id)).toEqual([
      'shopify_minbutik.myshopify.com_order_1042',
      'shopify_minbutik.myshopify.com_refund_77',
    ])
    expect(rows[1].parent_external_id).toBe('shopify_minbutik.myshopify.com_order_1042')

    // Cursor persisted from the page's max updatedAt, and any stale
    // error_message is cleared on progress. A fully-listed window then
    // advances the watermark to the run start time.
    const cursors = cursorUpdates(updates)
    expect(cursors).toHaveLength(2)
    expect(cursors[0].values.last_order_synced_at).toBe('2026-08-01T09:05:00.000Z')
    expect(cursors[0].values.error_message).toBeNull()
    const watermarkMs = Date.parse(cursors[1].values.last_order_synced_at as string)
    expect(Math.abs(watermarkMs - Date.now())).toBeLessThan(60_000)
    // hasNextPage: false terminates without a second list call.
    expect(listOrdersPage).toHaveBeenCalledTimes(1)
  })

  it('walks Relay cursors within one fixed window', async () => {
    const { client } = makeSupabaseMock()
    const first = makeOrder()
    const second = makeOrder({
      legacyResourceId: '1043',
      name: '#1043',
      updatedAt: '2026-08-02T08:00:00Z',
    })
    listOrdersPage
      .mockResolvedValueOnce(page([first], true, 'cursor-1'))
      .mockResolvedValueOnce(page([second]))

    const summary = await syncShopifyOrders(client, makeConnection())

    expect(summary.fetched).toBe(2)
    expect(listOrdersPage).toHaveBeenCalledTimes(2)
    const [firstArgs, secondArgs] = listOrdersPage.mock.calls.map((c) => c[1])
    expect(firstArgs.after).toBeNull()
    expect(secondArgs.after).toBe('cursor-1')
    // The window is fixed for the whole run; only the cursor moves.
    expect(secondArgs.updatedAtMin).toBe(firstArgs.updatedAtMin)
  })

  it('re-polls with a 24h overlap from the persisted cursor', async () => {
    const { client } = makeSupabaseMock()
    await syncShopifyOrders(
      client,
      makeConnection({ last_order_synced_at: '2026-08-05T12:00:00.000Z' }),
    )
    expect(listOrdersPage.mock.calls[0][1].updatedAtMin).toBe('2026-08-04T12:00:00.000Z')
  })

  it('holds the cursor below a page whose upsert reported errors', async () => {
    const { client, updates } = makeSupabaseMock()
    // Two orders so the assertion distinguishes "first updatedAt minus 1s"
    // (the floor rule) from "max updatedAt minus 1s".
    listOrdersPage.mockResolvedValueOnce(
      page([
        makeOrder(),
        makeOrder({ legacyResourceId: '1043', name: '#1043', updatedAt: '2026-08-02T08:00:00Z' }),
      ]),
    )
    vi.mocked(upsertWebshopOrders).mockResolvedValueOnce({
      ...emptyUpsertResult,
      inserted: 1,
      errors: 1,
    })

    const summary = await syncShopifyOrders(client, makeConnection())

    expect(summary.errors).toBe(1)
    // Page's FIRST updatedAt 09:05:00 minus 1s: the next run re-lists it.
    // The floor also caps the end-of-run watermark, so no second update.
    const cursors = cursorUpdates(updates)
    expect(cursors).toHaveLength(1)
    expect(cursors[0].values.last_order_synced_at).toBe('2026-08-01T09:04:59.000Z')
  })

  it('counts an unparseable order total as an error without stalling the cursor', async () => {
    const { client, updates } = makeSupabaseMock()
    listOrdersPage.mockResolvedValueOnce(
      page([makeOrder({ totalPriceSet: money('not-a-number') })]),
    )

    const summary = await syncShopifyOrders(client, makeConnection())

    expect(summary.errors).toBe(1)
    expect(upsertWebshopOrders).not.toHaveBeenCalled()
    // Deliberate: a permanently corrupt total must not stall the feed
    // (page cursor + end-of-run watermark both persist).
    expect(cursorUpdates(updates)).toHaveLength(2)
  })

  it('counts an unparseable refund amount without dropping the order row', async () => {
    const { client } = makeSupabaseMock()
    const order = makeOrder({
      refunds: [makeRefund({ totalRefundedSet: money('nope') })],
    })
    listOrdersPage.mockResolvedValueOnce(page([order]))

    const summary = await syncShopifyOrders(client, makeConnection())

    expect(summary.errors).toBe(1)
    expect(summary.refundsFetched).toBe(1)
    expect(upsertedRows().map((r) => r.row_type)).toEqual(['order'])
  })

  it('advances a watermark on an empty first run so quiet stores rotate in the cron', async () => {
    const { client, updates } = makeSupabaseMock()

    const summary = await syncShopifyOrders(client, makeConnection())

    expect(summary.fetched).toBe(0)
    // Without this, an empty store keeps a NULL cursor forever and the cron's
    // nullsFirst selection re-picks it every night ahead of everyone else.
    const cursors = cursorUpdates(updates)
    expect(cursors).toHaveLength(1)
    const watermarkMs = Date.parse(cursors[0].values.last_order_synced_at as string)
    expect(Math.abs(watermarkMs - Date.now())).toBeLessThan(60_000)
  })

  it('does nothing for a connection without credentials or not active', async () => {
    const { client } = makeSupabaseMock()
    const summary = await syncShopifyOrders(
      client,
      makeConnection({ client_id_encrypted: null }),
    )
    expect(summary.fetched).toBe(0)
    expect(createShopifySession).not.toHaveBeenCalled()

    const revokedSummary = await syncShopifyOrders(
      client,
      makeConnection({ status: 'revoked' }),
    )
    expect(revokedSummary.fetched).toBe(0)
  })

  it('flips the connection to revoked when the token exchange rejects the credentials', async () => {
    const { client, updates } = makeSupabaseMock()
    createShopifySession.mockRejectedValueOnce(new Error('REVOKED'))

    const summary = await syncShopifyOrders(client, makeConnection())

    expect(summary.revoked).toBe(true)
    const revokeUpdate = updates.find((u) => u.table === 'shopify_connections')
    expect(revokeUpdate?.values.status).toBe('revoked')
    expect(revokeUpdate?.values.client_id_encrypted).toBeNull()
  })

  it('flips the connection to revoked when the store rejects the token mid-run', async () => {
    const { client, updates } = makeSupabaseMock()
    listOrdersPage.mockRejectedValueOnce(new Error('REVOKED'))

    const summary = await syncShopifyOrders(client, makeConnection())

    expect(summary.revoked).toBe(true)
    expect(updates.find((u) => u.table === 'shopify_connections')?.values.status).toBe(
      'revoked',
    )
  })

  it('stops before fetching when the deadline is already reached', async () => {
    const { client } = makeSupabaseMock()
    const summary = await syncShopifyOrders(
      client,
      makeConnection(),
      undefined,
      Date.now() - 1,
    )
    expect(summary.deadlineReached).toBe(true)
    expect(listOrdersPage).not.toHaveBeenCalled()
  })

  it('stops between pages on deadline with the processed pages cursored', async () => {
    const { client, updates } = makeSupabaseMock()
    const deadlineMs = Date.now() + 150
    listOrdersPage.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200))
      return page([makeOrder()], true, 'cursor-1')
    })

    const summary = await syncShopifyOrders(client, makeConnection(), undefined, deadlineMs)

    expect(summary.deadlineReached).toBe(true)
    // The fetched page was fully processed and cursored; page two never ran.
    expect(listOrdersPage).toHaveBeenCalledTimes(1)
    expect(cursorUpdates(updates)).toHaveLength(1)
  })
})
