import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const listOrdersPage = vi.fn()
const listOrderRefunds = vi.fn()

vi.mock('../lib/api-client', () => ({
  listOrdersPage: (...args: unknown[]) => listOrdersPage(...args),
  listOrderRefunds: (...args: unknown[]) => listOrderRefunds(...args),
  isRevokedCredentialsError: (error: unknown) =>
    error instanceof Error && error.message === 'REVOKED',
  WC_PAGE_SIZE: 100,
}))

vi.mock('@/lib/webshop-orders/ingest', () => ({
  upsertWebshopOrders: vi.fn(),
  removeWebshopOrders: vi.fn(),
}))

import { removeWebshopOrders, upsertWebshopOrders } from '@/lib/webshop-orders/ingest'
import type { WebshopOrderUpsert } from '@/lib/webshop-orders/types'
import { encryptCredential } from '../lib/credentials'
import {
  WOOCOMMERCE_IMPORT_SOURCE,
  buildRefundVatBreakdown,
  buildVatBreakdown,
  extractOrgnr,
  mapOrderToWebshopRow,
  mapRefundToWebshopRow,
  orderImports,
  orderIsPaid,
  orderRemoves,
  syncWooCommerceOrders,
  wooOrderExternalId,
  wooRefundExternalId,
  wooStoreScope,
} from '../lib/order-sync'
import type { WooCommerceConnection, WooOrder, WooRefund } from '../types'

process.env.WOOCOMMERCE_CREDENTIALS_ENCRYPTION_KEY = 'test-key'

const emptyUpsertResult = {
  inserted: 0,
  updated: 0,
  unchanged: 0,
  frozenFlagged: 0,
  crossMarked: 0,
  errors: 0,
}

function makeConnection(overrides: Partial<WooCommerceConnection> = {}): WooCommerceConnection {
  return {
    id: 'conn-1',
    company_id: 'company-1',
    user_id: 'user-1',
    store_url: 'https://shop.example.se',
    store_name: 'Testbutiken',
    consumer_key_encrypted: encryptCredential('ck_test'),
    consumer_secret_encrypted: encryptCredential('cs_test'),
    key_permissions: 'read',
    status: 'active',
    oauth_state: null,
    currency: 'SEK',
    prices_include_tax: true,
    wc_version: '9.9.5',
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

function makeOrder(overrides: Partial<WooOrder> = {}): WooOrder {
  return {
    id: 1042,
    number: '1042',
    status: 'processing',
    currency: 'sek',
    total: '1250.00',
    total_tax: '250.00',
    prices_include_tax: true,
    date_created_gmt: '2026-08-01T09:00:00',
    date_modified_gmt: '2026-08-01T09:05:00',
    date_paid_gmt: '2026-08-01T09:04:30',
    payment_method: 'stripe',
    payment_method_title: 'Kortbetalning',
    transaction_id: 'pi_abc123',
    refunds: [],
    billing: {
      first_name: 'Test',
      last_name: 'Person',
      company: 'Testbolaget AB',
      email: 'kund@example.se',
    },
    line_items: [
      {
        id: 1,
        name: 'Produkt A',
        quantity: 2,
        total: '1000.00',
        total_tax: '250.00',
        taxes: [{ id: 3, total: '250.00' }],
      },
    ],
    tax_lines: [
      { rate_id: 3, rate_percent: 25, label: 'Moms 25%', tax_total: '250.00', shipping_tax_total: '0.00' },
    ],
    shipping_lines: [],
    meta_data: [],
    ...overrides,
  }
}

/** Minimal chainable supabase mock covering the sync's query patterns. */
function makeSupabaseMock() {
  const updates: Array<{ table: string; values: Record<string, unknown> }> = []
  const client = {
    from(table: string) {
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({ data: null, error: null }),
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
    (u) => u.table === 'woocommerce_connections' && 'last_order_synced_at' in u.values,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  // Termination is an empty page; every test starts from a quiet store and
  // enqueues its pages with mockResolvedValueOnce.
  listOrdersPage.mockResolvedValue([])
  listOrderRefunds.mockResolvedValue([])
  vi.mocked(upsertWebshopOrders).mockResolvedValue({ ...emptyUpsertResult })
  vi.mocked(removeWebshopOrders).mockResolvedValue({ removed: 0, errors: 0 })
})

describe('frozen external_id formats', () => {
  // ⚠️ These assert the exact persisted formats, now shared between
  // webshop_orders.external_id and the legacy transactions rows the
  // cross-mark joins against. If this test fails, you are about to orphan
  // every previously imported WooCommerce row AND break the legacy overlap
  // join: do not update the expectation without a coordinated backfill.
  it('order id format is frozen', () => {
    expect(wooOrderExternalId('shop.example.se', 1042)).toBe(
      'woo_shop.example.se_order_1042',
    )
  })

  it('refund id format is frozen', () => {
    expect(wooRefundExternalId('shop.example.se', 77)).toBe(
      'woo_shop.example.se_refund_77',
    )
  })

  it('store scope strips exactly the https prefix and keeps host + path', () => {
    expect(wooStoreScope('https://shop.example.se')).toBe('shop.example.se')
    expect(wooStoreScope('https://example.se/butik')).toBe('example.se/butik')
  })

  it('legacy import source constant is frozen', () => {
    expect(WOOCOMMERCE_IMPORT_SOURCE).toBe('woocommerce')
  })
})

describe('orderImports / orderRemoves / orderIsPaid', () => {
  it('every status except trash and failed imports, paid or not', () => {
    expect(orderImports(makeOrder())).toBe(true)
    expect(orderImports(makeOrder({ status: 'pending', date_paid_gmt: null }))).toBe(true)
    expect(orderImports(makeOrder({ status: 'refunded' }))).toBe(true)
    expect(orderImports(makeOrder({ status: 'trash' }))).toBe(false)
    expect(orderImports(makeOrder({ status: 'failed', date_paid_gmt: null }))).toBe(false)
  })

  it('only failed orders trigger removal of an existing row', () => {
    expect(orderRemoves(makeOrder({ status: 'failed' }))).toBe(true)
    expect(orderRemoves(makeOrder({ status: 'trash' }))).toBe(false)
    expect(orderRemoves(makeOrder())).toBe(false)
    expect(orderRemoves(makeOrder({ status: 'cancelled' }))).toBe(false)
  })

  it('is_paid follows date_paid', () => {
    expect(orderIsPaid(makeOrder())).toBe(true)
    expect(orderIsPaid(makeOrder({ date_paid_gmt: null }))).toBe(false)
  })
})

describe('mapOrderToWebshopRow', () => {
  const connection = { id: 'conn-1', store_name: 'Testbutiken' }

  it('maps the full booking underlag', () => {
    const rows = mapOrderToWebshopRow(connection, 'shop.example.se', makeOrder())
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      platform: 'woocommerce',
      store_scope: 'shop.example.se',
      store_label: 'Testbutiken',
      connection_id: 'conn-1',
      row_type: 'order',
      external_id: 'woo_shop.example.se_order_1042',
      platform_order_id: '1042',
      order_number: '1042',
      status: 'processing',
      is_paid: true,
      order_date: '2026-08-01',
      paid_date: '2026-08-01',
      currency: 'SEK',
      total: 1250,
      total_tax: 250,
      customer_name: 'Test Person',
      customer_company: 'Testbolaget AB',
      customer_email: 'kund@example.se',
      payment_method: 'stripe',
      payment_method_title: 'Kortbetalning',
      gateway_reference: 'pi_abc123',
    })
    expect(rows[0].vat_breakdown).toEqual([{ rate: 25, net: 1000, tax: 250 }])
    expect(rows[0].line_items).toEqual([
      { name: 'Produkt A', quantity: 2, total: 1000, total_tax: 250, vat_rate: 25 },
    ])
  })

  it('imports unpaid orders with is_paid false and no paid_date', () => {
    const rows = mapOrderToWebshopRow(
      connection,
      's',
      makeOrder({ status: 'pending', date_paid_gmt: null }),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ is_paid: false, paid_date: null, order_date: '2026-08-01' })
  })

  it('skips trashed, unparseable-total and zero-total orders', () => {
    expect(mapOrderToWebshopRow(connection, 's', makeOrder({ status: 'trash' }))).toEqual([])
    expect(
      mapOrderToWebshopRow(connection, 's', makeOrder({ total: 'not-a-number' })),
    ).toEqual([])
    // 100% coupon order: paid but zero money; importing it would strand an
    // unbookable row (the engine refuses zero-sum entries).
    expect(mapOrderToWebshopRow(connection, 's', makeOrder({ total: '0.00' }))).toEqual([])
  })

  it('captures the billing country uppercased', () => {
    const rows = mapOrderToWebshopRow(
      connection,
      's',
      makeOrder({ billing: { first_name: 'A', last_name: 'B', country: 'dk' } }),
    )
    expect(rows[0].customer_country).toBe('DK')
  })

  it('snapshots shipping and fee lines so the invoice conversion covers order.total', () => {
    const rows = mapOrderToWebshopRow(
      connection,
      's',
      makeOrder({
        shipping_lines: [
          { method_title: 'Postnord', total: '80.00', total_tax: '20.00', taxes: [{ id: 3, total: '20.00' }] },
        ],
        fee_lines: [
          { name: 'Fakturaavgift', total: '25.00', total_tax: '6.25', taxes: [{ id: 3, total: '6.25' }] },
        ],
      }),
    )
    expect(rows[0].line_items.map((i) => i.name)).toEqual([
      'Produkt A',
      'Postnord',
      'Fakturaavgift',
    ])
    expect(rows[0].line_items[1]).toMatchObject({ total: 80, total_tax: 20, vat_rate: 25 })
    expect(rows[0].line_items[2]).toMatchObject({ total: 25, total_tax: 6.25, vat_rate: 25 })
  })

  it('sums inline refund totals into refunded_total', () => {
    const rows = mapOrderToWebshopRow(
      connection,
      's',
      makeOrder({ refunds: [{ id: 77, reason: '', total: '-250.00' }] }),
    )
    expect(rows[0].refunded_total).toBe(250)
  })
})

describe('mapRefundToWebshopRow', () => {
  const connection = { id: 'conn-1', store_name: 'Testbutiken' }
  const refund: WooRefund = {
    id: 77,
    amount: '250.00',
    reason: 'Retur',
    date_created_gmt: '2026-08-03T10:00:00',
  }

  it('maps a refund to a negative row parented by external id, with PRORATED VAT', () => {
    const rows = mapRefundToWebshopRow(connection, 'shop.example.se', makeOrder(), refund)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      row_type: 'refund',
      parent_external_id: 'woo_shop.example.se_order_1042',
      external_id: 'woo_shop.example.se_refund_77',
      order_number: '1042',
      order_date: '2026-08-03',
      total: -250,
      // 250 of a 1250 order (net 1000 + moms 250): the reversal carries the
      // sale's mix. A zero here would leave ruta 10 over-declared (the
      // skeptic's counterexample ledger).
      total_tax: -50,
      is_paid: true,
    })
    expect(rows[0].vat_breakdown).toEqual([{ rate: 25, net: 200, tax: 50 }])
  })

  it('skips zero-amount refunds', () => {
    expect(
      mapRefundToWebshopRow(connection, 's', makeOrder(), { ...refund, amount: '0' }),
    ).toEqual([])
  })
})

describe('buildRefundVatBreakdown', () => {
  it('prefers the refund\'s own line allocation over proration', () => {
    const refundWithLines: WooRefund = {
      id: 78,
      amount: '125.00',
      reason: '',
      date_created_gmt: '2026-08-03T10:00:00',
      line_items: [
        { id: 9, total: '-100.00', total_tax: '-25.00', taxes: [{ id: 3, total: '-25.00' }] },
      ],
    }
    expect(buildRefundVatBreakdown(makeOrder(), refundWithLines)).toEqual({
      breakdown: [{ rate: 25, net: 100, tax: 25 }],
      totalTax: 25,
    })
  })

  it('prorates a mixed-rate order for amount-only refunds', () => {
    const order = makeOrder({
      total: '1000.00',
      total_tax: '160.00',
      line_items: [
        { id: 1, name: 'A', quantity: 1, total: '500.00', total_tax: '125.00', taxes: [{ id: 3, total: '125.00' }] },
        { id: 2, name: 'B', quantity: 1, total: '340.00', total_tax: '35.00', taxes: [{ id: 4, total: '35.00' }] },
      ],
      tax_lines: [
        { rate_id: 3, rate_percent: 25, tax_total: '125.00', shipping_tax_total: '0.00' },
        { rate_id: 4, rate_percent: 12, tax_total: '35.00', shipping_tax_total: '0.00' },
      ],
    })
    const halfRefund: WooRefund = {
      id: 79,
      amount: '500.00',
      reason: '',
      date_created_gmt: '2026-08-03T10:00:00',
    }
    const { breakdown, totalTax } = buildRefundVatBreakdown(order, halfRefund)
    expect(breakdown).toEqual([
      { rate: 25, net: 250, tax: 62.5 },
      { rate: 12, net: 170, tax: 17.5 },
    ])
    expect(totalTax).toBe(80)
  })

  it('returns empty when the order itself has no breakdown', () => {
    const order = makeOrder({ line_items: [], shipping_lines: [], tax_lines: [] })
    const amountOnly: WooRefund = {
      id: 80,
      amount: '100.00',
      reason: '',
      date_created_gmt: '2026-08-03T10:00:00',
    }
    expect(buildRefundVatBreakdown(order, amountOnly)).toEqual({
      breakdown: [],
      totalTax: 0,
    })
  })
})

describe('buildVatBreakdown', () => {
  it('groups line and shipping taxes per rate', () => {
    const order = makeOrder({
      line_items: [
        {
          id: 1,
          name: 'A',
          quantity: 1,
          total: '400.00',
          total_tax: '100.00',
          taxes: [{ id: 3, total: '100.00' }],
        },
        {
          id: 2,
          name: 'B',
          quantity: 1,
          total: '100.00',
          total_tax: '12.00',
          taxes: [{ id: 4, total: '12.00' }],
        },
      ],
      shipping_lines: [
        { total: '49.00', total_tax: '12.25', taxes: [{ id: 3, total: '12.25' }] },
      ],
      tax_lines: [
        { rate_id: 3, rate_percent: 25, tax_total: '112.25', shipping_tax_total: '12.25' },
        { rate_id: 4, rate_percent: 12, tax_total: '12.00', shipping_tax_total: '0.00' },
      ],
    })
    expect(buildVatBreakdown(order)).toEqual([
      { rate: 25, net: 449, tax: 112.25 },
      { rate: 12, net: 100, tax: 12 },
    ])
  })

  it('lands untaxed lines in the 0% bucket', () => {
    const order = makeOrder({
      line_items: [
        { id: 1, name: 'A', quantity: 1, total: '300.00', total_tax: '0.00', taxes: [] },
      ],
      tax_lines: [],
      total_tax: '0.00',
    })
    expect(buildVatBreakdown(order)).toEqual([{ rate: 0, net: 300, tax: 0 }])
  })

  it('infers the rate from the ratio when tax_lines are missing', () => {
    const order = makeOrder({
      line_items: [
        { id: 1, name: 'A', quantity: 1, total: '400.00', total_tax: '100.00' },
      ],
      tax_lines: [],
    })
    expect(buildVatBreakdown(order)).toEqual([{ rate: 25, net: 400, tax: 100 }])
  })

  it('returns [] when the payload has no line data (dialog falls back)', () => {
    const order = makeOrder({ line_items: [], shipping_lines: [], tax_lines: [] })
    expect(buildVatBreakdown(order)).toEqual([])
  })

  it('returns [] for tax-stripped stores: empty taxes arrays are NOT tax data', () => {
    // Hardened hosts serialize `taxes: []` on every line while hiding the
    // amounts; treating that as tax data booked the whole VAT into 3740.
    const order = makeOrder({
      total: '500.00',
      total_tax: '100.00',
      line_items: [
        { id: 1, name: 'A', quantity: 1, total: '400.00', total_tax: '', taxes: [] },
      ],
      tax_lines: [],
      shipping_lines: [],
    })
    expect(buildVatBreakdown(order)).toEqual([])
  })

  it('includes fee lines so their VAT reaches 2611 instead of the 3740 residual', () => {
    const order = makeOrder({
      total: '562.50',
      total_tax: '112.50',
      fee_lines: [
        { name: 'Fakturaavgift', total: '50.00', total_tax: '12.50', taxes: [{ id: 3, total: '12.50' }] },
      ],
    })
    expect(buildVatBreakdown(order)).toEqual([{ rate: 25, net: 1050, tax: 262.5 }])
  })

  it('keeps discount lines SIGNED (negative net stays negative)', () => {
    const order = makeOrder({
      total: '525.00',
      total_tax: '125.00',
      line_items: [
        { id: 1, name: 'Produkt', quantity: 1, total: '500.00', total_tax: '125.00', taxes: [{ id: 3, total: '125.00' }] },
        { id: 2, name: 'Presentkort', quantity: 1, total: '-100.00', total_tax: '0.00', taxes: [] },
      ],
    })
    expect(buildVatBreakdown(order)).toEqual([
      { rate: 25, net: 500, tax: 125 },
      { rate: 0, net: -100, tax: 0 },
    ])
  })
})

describe('extractOrgnr', () => {
  it('reads an orgnr embedded in the billing company field', () => {
    expect(
      extractOrgnr(makeOrder({ billing: { company: 'Testbolaget AB 556677-8899' } })),
    ).toBe('556677-8899')
  })

  it('scans meta_data for orgnr-ish keys', () => {
    expect(
      extractOrgnr(
        makeOrder({
          billing: { company: 'Testbolaget AB' },
          meta_data: [{ key: '_billing_org_nr', value: '5566778899' }],
        }),
      ),
    ).toBe('556677-8899')
  })

  it('returns null when nothing matches', () => {
    expect(extractOrgnr(makeOrder())).toBeNull()
    expect(extractOrgnr(makeOrder({ billing: undefined, meta_data: undefined }))).toBeNull()
  })
})

describe('syncWooCommerceOrders', () => {
  it('upserts order and refund rows and advances the cursor', async () => {
    const { client, updates } = makeSupabaseMock()
    const order = makeOrder({
      refunds: [{ id: 77, reason: 'Retur', total: '-250.00' }],
    })
    listOrdersPage.mockResolvedValueOnce([order])
    listOrderRefunds.mockResolvedValueOnce([
      { id: 77, amount: '250.00', reason: 'Retur', date_created_gmt: '2026-08-03T10:00:00' },
    ])
    vi.mocked(upsertWebshopOrders).mockResolvedValueOnce({
      ...emptyUpsertResult,
      inserted: 2,
    })

    const summary = await syncWooCommerceOrders(client, makeConnection())

    expect(summary).toMatchObject({ fetched: 1, refundsFetched: 1, inserted: 2, errors: 0 })
    expect(upsertWebshopOrders).toHaveBeenCalledTimes(1)
    const [, companyId, userId, rows] = vi.mocked(upsertWebshopOrders).mock.calls[0]
    expect(companyId).toBe('company-1')
    expect(userId).toBe('user-1')
    expect((rows as WebshopOrderUpsert[]).map((r) => r.external_id)).toEqual([
      'woo_shop.example.se_order_1042',
      'woo_shop.example.se_refund_77',
    ])

    // Cursor persisted from the page's max date_modified_gmt, branded UTC,
    // and any stale error_message is cleared on progress.
    const cursors = cursorUpdates(updates)
    expect(cursors).toHaveLength(1)
    expect(cursors[0].values.last_order_synced_at).toBe('2026-08-01T09:05:00.000Z')
    expect(cursors[0].values.error_message).toBeNull()

    // Second list call proves cursor pagination: modified_after advanced to
    // the last row's timestamp, page reset to 1, terminated by the empty page.
    expect(listOrdersPage).toHaveBeenCalledTimes(2)
    expect(listOrdersPage.mock.calls[1][1]).toEqual({
      modifiedAfter: '2026-08-01T09:05:00.000Z',
      page: 1,
    })
  })

  it('imports unpaid orders without fetching refunds for them', async () => {
    const { client } = makeSupabaseMock()
    listOrdersPage.mockResolvedValueOnce([
      makeOrder({ status: 'pending', date_paid_gmt: null, refunds: [] }),
    ])

    await syncWooCommerceOrders(client, makeConnection())

    expect(listOrderRefunds).not.toHaveBeenCalled()
    const [, , , rows] = vi.mocked(upsertWebshopOrders).mock.calls[0]
    expect((rows as WebshopOrderUpsert[])[0]).toMatchObject({ is_paid: false })
  })

  it('removes the existing row of a failed order instead of importing it', async () => {
    const { client, updates } = makeSupabaseMock()
    listOrdersPage.mockResolvedValueOnce([
      makeOrder({
        status: 'failed',
        date_paid_gmt: null,
        // A stray refunds stub must not trigger a refund fetch for a
        // non-importing order.
        refunds: [{ id: 9, reason: '', total: '-100.00' }],
      }),
    ])
    vi.mocked(removeWebshopOrders).mockResolvedValueOnce({ removed: 1, errors: 0 })

    const summary = await syncWooCommerceOrders(client, makeConnection())

    expect(summary).toMatchObject({ fetched: 1, inserted: 0, removed: 1, errors: 0 })
    expect(upsertWebshopOrders).not.toHaveBeenCalled()
    expect(listOrderRefunds).not.toHaveBeenCalled()
    expect(removeWebshopOrders).toHaveBeenCalledWith(client, 'company-1', [
      'woo_shop.example.se_order_1042',
    ])
    // The removal is complete work: the cursor advances normally.
    const cursors = cursorUpdates(updates)
    expect(cursors).toHaveLength(1)
    expect(cursors[0].values.last_order_synced_at).toBe('2026-08-01T09:05:00.000Z')
  })

  it('holds the cursor below a page whose removal reported errors', async () => {
    const { client, updates } = makeSupabaseMock()
    listOrdersPage.mockResolvedValueOnce([makeOrder({ status: 'failed', date_paid_gmt: null })])
    vi.mocked(removeWebshopOrders).mockResolvedValueOnce({ removed: 0, errors: 1 })

    const summary = await syncWooCommerceOrders(client, makeConnection())

    expect(summary.errors).toBe(1)
    const cursors = cursorUpdates(updates)
    expect(cursors).toHaveLength(1)
    expect(cursors[0].values.last_order_synced_at).toBe('2026-08-01T09:04:59.000Z')
  })

  it('holds the cursor below an order whose refund fetch failed', async () => {
    const { client, updates } = makeSupabaseMock()
    const order = makeOrder({ refunds: [{ id: 77, reason: '', total: '-250.00' }] })
    listOrdersPage.mockResolvedValueOnce([order])
    listOrderRefunds.mockRejectedValueOnce(new Error('502 from host'))

    const summary = await syncWooCommerceOrders(client, makeConnection())

    expect(summary.errors).toBe(1)
    // date_modified 09:05:00 minus 1s: the next run re-lists this order.
    const cursors = cursorUpdates(updates)
    expect(cursors).toHaveLength(1)
    expect(cursors[0].values.last_order_synced_at).toBe('2026-08-01T09:04:59.000Z')
  })

  it('holds the cursor below a page whose upsert reported errors', async () => {
    const { client, updates } = makeSupabaseMock()
    listOrdersPage.mockResolvedValueOnce([makeOrder()])
    vi.mocked(upsertWebshopOrders).mockResolvedValueOnce({
      ...emptyUpsertResult,
      errors: 1,
    })

    const summary = await syncWooCommerceOrders(client, makeConnection())

    expect(summary.errors).toBe(1)
    const cursors = cursorUpdates(updates)
    expect(cursors).toHaveLength(1)
    expect(cursors[0].values.last_order_synced_at).toBe('2026-08-01T09:04:59.000Z')
  })

  it('pages through a full same-timestamp tie by offset, then resumes cursor pagination', async () => {
    const { client } = makeSupabaseMock()
    const tie = Array.from({ length: 100 }, (_, i) =>
      makeOrder({ id: i + 1, number: String(i + 1) }),
    )
    const later = makeOrder({
      id: 500,
      number: '500',
      date_modified_gmt: '2026-08-01T10:00:00',
    })
    listOrdersPage.mockResolvedValueOnce(tie).mockResolvedValueOnce([later])

    const summary = await syncWooCommerceOrders(client, makeConnection())

    expect(summary.fetched).toBe(101)
    expect(listOrdersPage).toHaveBeenCalledTimes(3)
    const [firstArgs, secondArgs, thirdArgs] = listOrdersPage.mock.calls.map((c) => c[1])
    // Full page, all one timestamp: same cursor, next offset page.
    expect(secondArgs).toEqual({ modifiedAfter: firstArgs.modifiedAfter, page: 2 })
    // Progress within the tie page: cursor moves, offset resets.
    expect(thirdArgs).toEqual({ modifiedAfter: '2026-08-01T10:00:00.000Z', page: 1 })
  })

  it('counts an unparseable order total as an error without stalling the cursor', async () => {
    const { client, updates } = makeSupabaseMock()
    listOrdersPage.mockResolvedValueOnce([makeOrder({ total: 'not-a-number' })])

    const summary = await syncWooCommerceOrders(client, makeConnection())

    expect(summary.errors).toBe(1)
    expect(upsertWebshopOrders).not.toHaveBeenCalled()
    // Deliberate: a permanently corrupt total must not stall the feed.
    expect(cursorUpdates(updates)).toHaveLength(1)
  })

  it('does nothing for a connection without credentials or not active', async () => {
    const { client } = makeSupabaseMock()
    const summary = await syncWooCommerceOrders(
      client,
      makeConnection({ consumer_key_encrypted: null }),
    )
    expect(summary.fetched).toBe(0)
    expect(listOrdersPage).not.toHaveBeenCalled()

    const revokedSummary = await syncWooCommerceOrders(
      client,
      makeConnection({ status: 'revoked' }),
    )
    expect(revokedSummary.fetched).toBe(0)
  })

  it('flips the connection to revoked when the store rejects the credentials', async () => {
    const { client, updates } = makeSupabaseMock()
    listOrdersPage.mockRejectedValueOnce(new Error('REVOKED'))

    const summary = await syncWooCommerceOrders(client, makeConnection())

    expect(summary.revoked).toBe(true)
    const revokeUpdate = updates.find((u) => u.table === 'woocommerce_connections')
    expect(revokeUpdate?.values.status).toBe('revoked')
  })

  it('stops before fetching when the deadline is already reached', async () => {
    const { client } = makeSupabaseMock()
    const summary = await syncWooCommerceOrders(
      client,
      makeConnection(),
      undefined,
      Date.now() - 1,
    )
    expect(summary.deadlineReached).toBe(true)
    expect(listOrdersPage).not.toHaveBeenCalled()
  })

  it('skips remaining refund fetches on deadline and holds the cursor for them', async () => {
    const { client, updates } = makeSupabaseMock()
    const refunded = makeOrder({ refunds: [{ id: 77, reason: '', total: '-1.00' }] })
    // The list call itself consumes the whole budget, so the deadline is
    // comfortably alive at the loop check and expired by the refund loop.
    const deadlineMs = Date.now() + 200
    listOrdersPage.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250))
      return [refunded]
    })
    const summary = await syncWooCommerceOrders(client, makeConnection(), undefined, deadlineMs)

    expect(summary.deadlineReached).toBe(true)
    expect(listOrderRefunds).not.toHaveBeenCalled()
    const cursors = cursorUpdates(updates)
    expect(cursors).toHaveLength(1)
    expect(cursors[0].values.last_order_synced_at).toBe('2026-08-01T09:04:59.000Z')
  })
})
