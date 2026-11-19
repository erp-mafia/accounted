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
  resolveWindowStartIso,
  shippingCountryOf,
  orderCountryOf,
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
  return { name, quantity, discountedTotalSet: money(total), taxLines, requiresShipping: true }
}

/** A digital product or service line: the variant needs no shipping. */
function digitalLine(name: string, total: string, taxLines: ShopifyTaxLine[] = []): ShopifyLineItem {
  return { ...lineItem(name, 1, total, taxLines), requiresShipping: false }
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
 * (1000 net + 250 moms), one physical product line covering the whole total,
 * shipped to a Swedish address and billed to a Danish one.
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
    shippingAddress: { countryCodeV2: 'SE' },
    billingAddress: { countryCodeV2: 'DK' },
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
function page(
  orders: ShopifyOrder[],
  hasNextPage = false,
  endCursor: string | null = null,
  addressesWithheld = false,
) {
  return { orders, hasNextPage, endCursor, addressesWithheld }
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
        customer_country: 'SE',
        ships_nothing: false,
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

  it('dates an order on the Swedish day, not the UTC day (#58)', () => {
    // Winter time: 23:30Z on 31 October is 00:30 on 1 November in Stockholm.
    const [winter] = mapOrderToWebshopRow(connection, 's', makeOrder({
      createdAt: '2026-10-31T23:30:00Z',
      processedAt: '2026-10-31T23:31:00Z',
    }))
    expect(winter).toMatchObject({ order_date: '2026-11-01', paid_date: '2026-11-01' })
    // Summer time: 22:30Z on 31 August is 00:30 on 1 September.
    const [summer] = mapOrderToWebshopRow(connection, 's', makeOrder({
      createdAt: '2026-08-31T22:30:00Z',
      processedAt: '2026-08-31T22:31:00Z',
    }))
    expect(summer).toMatchObject({ order_date: '2026-09-01', paid_date: '2026-09-01' })
    // 21:30Z is still 23:30 on 31 August there.
    const [evening] = mapOrderToWebshopRow(connection, 's', makeOrder({
      createdAt: '2026-08-31T21:30:00Z',
      processedAt: '2026-08-31T21:31:00Z',
    }))
    expect(evening).toMatchObject({ order_date: '2026-08-31', paid_date: '2026-08-31' })
  })

  it('dates a refund on the Swedish day too (#58)', () => {
    const [row] = mapRefundToWebshopRow(
      connection,
      's',
      makeOrder(),
      makeRefund({ createdAt: '2026-10-31T23:30:00Z' }),
    )
    expect(row).toMatchObject({ order_date: '2026-11-01', paid_date: '2026-11-01' })
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

  it('stores a foreign shipping country as the destination (crm#1032)', () => {
    // An EU distance sale (OSS) and an export outside the EU: the account
    // choice downstream keys on exactly this column.
    const [toGermany] = mapOrderToWebshopRow(
      connection,
      's',
      makeOrder({ shippingAddress: { countryCodeV2: 'DE' } }),
    )
    expect(toGermany.customer_country).toBe('DE')
    const [toNorway] = mapOrderToWebshopRow(
      connection,
      's',
      makeOrder({ shippingAddress: { countryCodeV2: 'no' } }),
    )
    expect(toNorway.customer_country).toBe('NO')
  })

  it('keeps the country null for a goods order without a shipping address', () => {
    // Local pickup: physical goods, no destination. The billing country is
    // never a stand-in for where goods go.
    const [row] = mapOrderToWebshopRow(connection, 's', makeOrder({ shippingAddress: null }))
    expect(row.customer_country).toBeNull()
  })

  it('stores the billing country for an order with nothing to ship (#98)', () => {
    // E-books, courses, coaching: no shipping address exists, and for an
    // e-service to a consumer the customer's location decides the VAT.
    const digital = makeOrder({
      shippingAddress: null,
      billingAddress: { countryCodeV2: 'de' },
      lineItems: conn([digitalLine('E-bok', '1250.00', [taxLine(25, '250.00')])]),
    })
    const [row] = mapOrderToWebshopRow(connection, 's', digital)
    expect(row.customer_country).toBe('DE')
    // The rest of the row is the ordinary order row.
    expect(row.total).toBe(1250)
    expect(row.vat_breakdown).toEqual([{ rate: 25, net: 1000, tax: 250 }])
  })

  it('marks an order with nothing to ship, and its refunds, as ships_nothing (#88)', () => {
    const digital = makeOrder({
      shippingAddress: null,
      billingAddress: { countryCodeV2: 'US' },
      lineItems: conn([digitalLine('E-bok', '1250.00')]),
    })
    expect(mapOrderToWebshopRow(connection, 's', digital)[0].ships_nothing).toBe(true)
    expect(mapRefundToWebshopRow(connection, 's', digital, makeRefund())[0].ships_nothing).toBe(true)
  })

  it('does not mark an order with a line that ships, an unknown line or a truncated page', () => {
    const mixed = conn([digitalLine('Kurs', '100.00'), lineItem('Bok', 1, '1150.00')])
    const { requiresShipping: _flag, ...unflagged } = digitalLine('Kurs', '1250.00')
    for (const lineItems of [mixed, conn([unflagged]), conn([digitalLine('Kurs', '1250.00')], true)]) {
      const order = makeOrder({ lineItems })
      expect(mapOrderToWebshopRow(connection, 's', order)[0].ships_nothing).toBe(false)
      expect(mapRefundToWebshopRow(connection, 's', order, makeRefund())[0].ships_nothing).toBe(false)
    }
  })

  it('keeps the country null when the store withholds the billing address of a digital order', () => {
    const lines = conn([digitalLine('E-bok', '1250.00', [taxLine(25, '250.00')])])
    const [withheld] = mapOrderToWebshopRow(
      connection,
      's',
      makeOrder({ shippingAddress: null, billingAddress: null, lineItems: lines }),
    )
    expect(withheld.customer_country).toBeNull()
    const [redacted] = mapOrderToWebshopRow(
      connection,
      's',
      makeOrder({
        shippingAddress: null,
        billingAddress: { countryCodeV2: null },
        lineItems: lines,
      }),
    )
    expect(redacted.customer_country).toBeNull()
  })

  it('keeps the country null when the run stopped asking for addresses', () => {
    const { shippingAddress: _s, billingAddress: _b, ...withoutAddress } = makeOrder({
      lineItems: conn([digitalLine('E-bok', '1250.00', [taxLine(25, '250.00')])]),
    })
    const [row] = mapOrderToWebshopRow(connection, 's', withoutAddress as ShopifyOrder)
    expect(row.customer_country).toBeNull()
  })
})

describe('orderCountryOf', () => {
  const digital = conn([digitalLine('Kurs', '100.00')])

  it('prefers the shipping (destination) country over billing for a goods order', () => {
    expect(orderCountryOf(makeOrder({ shippingAddress: { countryCodeV2: 'NO' } }))).toBe('NO')
  })

  it('keeps a shipping country that a digital order happens to carry', () => {
    expect(
      orderCountryOf(makeOrder({ shippingAddress: { countryCodeV2: 'FI' }, lineItems: digital })),
    ).toBe('FI')
  })

  it('falls back to billing only when no line needs shipping', () => {
    const mixed = conn([digitalLine('Kurs', '100.00'), lineItem('Bok', 1, '1150.00')])
    expect(orderCountryOf(makeOrder({ shippingAddress: null, lineItems: mixed }))).toBeNull()
    expect(orderCountryOf(makeOrder({ shippingAddress: null, lineItems: digital }))).toBe('DK')
  })

  it('treats an unknown line or a truncated line page as possibly shipping', () => {
    const { requiresShipping: _flag, ...unflagged } = digitalLine('Kurs', '100.00')
    expect(
      orderCountryOf(makeOrder({ shippingAddress: null, lineItems: conn([unflagged]) })),
    ).toBeNull()
    expect(
      orderCountryOf(
        makeOrder({ shippingAddress: null, lineItems: conn([digitalLine('Kurs', '100.00')], true) }),
      ),
    ).toBeNull()
    expect(orderCountryOf(makeOrder({ shippingAddress: null, lineItems: conn([]) }))).toBeNull()
  })

  it('treats the unknown region ZZ and junk on the billing address as no country', () => {
    for (const code of ['ZZ', 'Germany', '']) {
      expect(
        orderCountryOf(
          makeOrder({ shippingAddress: null, billingAddress: { countryCodeV2: code }, lineItems: digital }),
        ),
      ).toBeNull()
    }
  })
})

describe('shippingCountryOf', () => {
  it('returns the upper-cased ISO code', () => {
    expect(shippingCountryOf({ shippingAddress: { countryCodeV2: 'fi' } })).toBe('FI')
  })

  it('treats a withheld field, the unknown region ZZ and junk as no country', () => {
    expect(shippingCountryOf({ shippingAddress: { countryCodeV2: null } })).toBeNull()
    expect(shippingCountryOf({ shippingAddress: { countryCodeV2: 'ZZ' } })).toBeNull()
    expect(shippingCountryOf({ shippingAddress: { countryCodeV2: 'Sweden' } })).toBeNull()
    expect(shippingCountryOf({ shippingAddress: null })).toBeNull()
    expect(shippingCountryOf({})).toBeNull()
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
        customer_country: 'SE',
        ships_nothing: false,
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

  it("takes its order's destination country (the refund reverses that sale)", () => {
    const order = makeOrder({ shippingAddress: { countryCodeV2: 'NO' } })
    const [row] = mapRefundToWebshopRow(connection, 's', order, makeRefund())
    expect(row.customer_country).toBe('NO')
    const [noAddress] = mapRefundToWebshopRow(
      connection,
      's',
      makeOrder({ shippingAddress: null }),
      makeRefund(),
    )
    expect(noAddress.customer_country).toBeNull()
    const [digital] = mapRefundToWebshopRow(
      connection,
      's',
      makeOrder({ shippingAddress: null, lineItems: conn([digitalLine('E-bok', '1250.00')]) }),
      makeRefund(),
    )
    expect(digital.customer_country).toBe('DK')
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

  it('asks for the order addresses on every page by default', async () => {
    const { client } = makeSupabaseMock()
    listOrdersPage.mockResolvedValueOnce(page([makeOrder()]))
    const summary = await syncShopifyOrders(client, makeConnection())
    expect(listOrdersPage.mock.calls[0][1].includeAddresses).toBe(true)
    expect(summary.shippingCountryWithheld).toBeUndefined()
    expect(upsertedRows()[0].customer_country).toBe('SE')
  })

  it('stores a country for a digital-only store whose orders have no shipping address (#98)', async () => {
    const { client } = makeSupabaseMock()
    const ebook = (id: string, billing: string) =>
      makeOrder({
        legacyResourceId: id,
        name: `#${id}`,
        shippingAddress: null,
        billingAddress: { countryCodeV2: billing },
        lineItems: conn([digitalLine('E-bok', '1250.00', [taxLine(25, '250.00')])]),
      })
    listOrdersPage.mockResolvedValueOnce(page([ebook('2001', 'US'), ebook('2002', 'CH')]))
    const summary = await syncShopifyOrders(client, makeConnection())
    expect(summary.shippingCountryWithheld).toBeUndefined()
    expect(upsertedRows().map((r) => r.customer_country)).toEqual(['US', 'CH'])
  })

  it('keeps syncing with null countries when the store withholds shipping addresses', async () => {
    const { client, updates } = makeSupabaseMock()
    // What listOrdersPage reports for Shopify's protected-data refusal: the
    // page is complete, shippingAddress came back null on every order.
    const withheld = makeOrder({
      shippingAddress: null,
      displayFinancialStatus: 'PARTIALLY_REFUNDED',
      refunds: [makeRefund()],
    })
    const second = makeOrder({
      legacyResourceId: '1043',
      name: '#1043',
      updatedAt: '2026-08-02T08:00:00Z',
      shippingAddress: undefined,
    })
    listOrdersPage
      .mockResolvedValueOnce(page([withheld], true, 'cursor-1', true))
      .mockResolvedValueOnce(page([second]))

    const summary = await syncShopifyOrders(client, makeConnection())

    expect(summary.shippingCountryWithheld).toBe(true)
    expect(summary.revoked).toBeUndefined()
    expect(summary.fetched).toBe(2)
    // The refusal is app-level, so the rest of the run stops asking.
    expect(listOrdersPage.mock.calls[0][1].includeAddresses).toBe(true)
    expect(listOrdersPage.mock.calls[1][1].includeAddresses).toBe(false)
    const rows = [...upsertedRows(0), ...upsertedRows(1)]
    expect(rows.map((r) => r.row_type)).toEqual(['order', 'refund', 'order'])
    expect(rows.every((r) => r.customer_country === null)).toBe(true)
    // Never treated as a connection problem: no revoke, cursor still advances.
    expect(updates.some((u) => u.values.status === 'revoked')).toBe(false)
    expect(cursorUpdates(updates).length).toBeGreaterThan(0)
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

describe('shopify sync window', () => {
  const CONNECTED_AT = '2026-09-09T10:00:00.000Z'
  const seeded = (overrides: Partial<ShopifyConnection> = {}) =>
    makeConnection({
      connected_at: CONNECTED_AT,
      created_at: '2026-09-09T09:59:00.000Z',
      last_order_synced_at: CONNECTED_AT,
      ...overrides,
    })

  it('starts the first sync at the connection moment, not a day earlier', () => {
    // POST /connect seeds the cursor with connected_at; the 24 h overlap must
    // not drag the window back into orders the user booked from the bank.
    expect(resolveWindowStartIso(seeded())).toBe(CONNECTED_AT)
  })

  it('keeps the 24 h overlap once the cursor has moved past the connection', () => {
    expect(
      resolveWindowStartIso(seeded({ last_order_synced_at: '2026-09-20T10:00:00.000Z' })),
    ).toBe('2026-09-19T10:00:00.000Z')
  })

  it("falls back to the connection's own start when the cursor is null", () => {
    expect(resolveWindowStartIso(seeded({ last_order_synced_at: null }))).toBe(CONNECTED_AT)
    expect(
      resolveWindowStartIso(seeded({ last_order_synced_at: null, connected_at: null })),
    ).toBe('2026-09-09T09:59:00.000Z')
  })

  it('honours an explicit backfill cursor exactly, without reaching a day further back', () => {
    expect(
      resolveWindowStartIso(seeded({ last_order_synced_at: '2026-01-01T00:00:00.000Z' })),
    ).toBe('2026-01-01T00:00:00.000Z')
  })
})
