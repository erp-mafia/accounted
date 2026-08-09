import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const listOrdersPage = vi.fn()
const createShopifySession = vi.fn()

vi.mock('../lib/api-client', () => ({
  listOrdersPage: (...args: unknown[]) => listOrdersPage(...args),
  createShopifySession: (...args: unknown[]) => createShopifySession(...args),
  isRevokedCredentialsError: (error: unknown) =>
    error instanceof Error && error.message === 'REVOKED',
}))

vi.mock('@/lib/transactions/ingest', () => ({
  ingestTransactions: vi.fn(),
}))

vi.mock('@/lib/cash-accounts/service', () => ({
  ensureManualCashAccount: vi.fn().mockResolvedValue('cash-account-1'),
}))

vi.mock('@/lib/import/account-sync', () => ({
  syncMappedAccounts: vi.fn().mockResolvedValue({ error: null }),
}))

import { ingestTransactions } from '@/lib/transactions/ingest'
import { ensureManualCashAccount } from '@/lib/cash-accounts/service'
import { encryptCredential } from '../lib/credentials'
import {
  SHOPIFY_IMPORT_SOURCE,
  SHOPIFY_LEDGER_ACCOUNT,
  mapOrder,
  mapRefund,
  orderQualifies,
  rowBehindLock,
  shopifyOrderExternalId,
  shopifyRefundExternalId,
  shopifyShopScope,
  syncShopifyOrders,
} from '../lib/order-sync'
import type { ShopifyConnection, ShopifyOrder, ShopifyRefund } from '../types'

beforeAll(() => {
  vi.stubEnv('SHOPIFY_CREDENTIALS_ENCRYPTION_KEY', 'test-key')
})

afterAll(() => {
  vi.unstubAllEnvs()
})

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

function makeOrder(overrides: Partial<ShopifyOrder> = {}): ShopifyOrder {
  return {
    legacyResourceId: '1042',
    name: '#1042',
    test: false,
    processedAt: '2026-08-01T09:04:30Z',
    updatedAt: '2026-08-01T09:05:00Z',
    displayFinancialStatus: 'PAID',
    paymentGatewayNames: ['Klarna'],
    totalPriceSet: money('1250.00'),
    refunds: [],
    ...overrides,
  }
}

/** One-page result helper; the loop terminates on hasNextPage: false. */
function page(orders: ShopifyOrder[], hasNextPage = false, endCursor: string | null = null) {
  return { orders, hasNextPage, endCursor }
}

/** Minimal chainable supabase mock covering the sync's query patterns. */
function makeSupabaseMock(options: { lockThrough?: string | null } = {}) {
  const updates: Array<{ table: string; values: Record<string, unknown> }> = []
  const client = {
    from(table: string) {
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({
          data:
            table === 'company_settings'
              ? { bookkeeping_locked_through: options.lockThrough ?? null }
              : null,
          error: null,
        }),
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

beforeEach(() => {
  vi.clearAllMocks()
  createShopifySession.mockResolvedValue({
    shopDomain: 'minbutik.myshopify.com',
    accessToken: 'token-1',
  })
  listOrdersPage.mockResolvedValue(page([]))
  vi.mocked(ingestTransactions).mockResolvedValue({
    imported: 0,
    duplicates: 0,
    errors: 0,
  } as Awaited<ReturnType<typeof ingestTransactions>>)
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

  it('import source and ledger account are frozen', () => {
    expect(SHOPIFY_IMPORT_SOURCE).toBe('shopify')
    expect(SHOPIFY_LEDGER_ACCOUNT).toBe('1584')
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

describe('mapOrder', () => {
  it('maps a paid order to one gross row dated by processedAt', () => {
    const rows = mapOrder('minbutik.myshopify.com', makeOrder())
    expect(rows).toEqual([
      {
        date: '2026-08-01',
        description: 'Shopify-order #1042',
        amount: 1250,
        currency: 'SEK',
        external_id: 'shopify_minbutik.myshopify.com_order_1042',
        import_source: 'shopify',
        reference: 'Klarna',
      },
    ])
  })

  it('rounds string money to two decimals and uppercases the currency', () => {
    const rows = mapOrder('s', makeOrder({ totalPriceSet: money('99.995', 'eur') }))
    expect(rows[0].amount).toBe(100)
    expect(rows[0].currency).toBe('EUR')
  })

  it('skips unpaid, test, zero-total and unparseable orders', () => {
    expect(mapOrder('s', makeOrder({ displayFinancialStatus: 'PENDING' }))).toEqual([])
    expect(mapOrder('s', makeOrder({ test: true }))).toEqual([])
    expect(mapOrder('s', makeOrder({ totalPriceSet: money('0.00') }))).toEqual([])
    expect(mapOrder('s', makeOrder({ totalPriceSet: money('not-a-number') }))).toEqual([])
  })

  it('leaves the reference null when no gateways are reported', () => {
    expect(mapOrder('s', makeOrder({ paymentGatewayNames: [] }))[0].reference).toBeNull()
  })
})

describe('mapRefund', () => {
  const refund: ShopifyRefund = {
    legacyResourceId: '77',
    createdAt: '2026-08-03T10:00:00Z',
    totalRefundedSet: money('250.00'),
  }

  it('maps a refund to one negative row dated by the refund date', () => {
    const rows = mapRefund('minbutik.myshopify.com', makeOrder(), refund)
    expect(rows).toEqual([
      {
        date: '2026-08-03',
        description: 'Shopify-återbetalning order #1042',
        amount: -250,
        currency: 'SEK',
        external_id: 'shopify_minbutik.myshopify.com_refund_77',
        import_source: 'shopify',
        reference: null,
      },
    ])
  })

  it('skips zero-amount refunds', () => {
    expect(
      mapRefund('s', makeOrder(), { ...refund, totalRefundedSet: money('0') }),
    ).toEqual([])
  })
})

describe('rowBehindLock', () => {
  it('drops dates on/before the lock and keeps later ones', () => {
    expect(rowBehindLock('2026-06-30', '2026-06-30')).toBe(true)
    expect(rowBehindLock('2026-06-15', '2026-06-30')).toBe(true)
    expect(rowBehindLock('2026-07-01', '2026-06-30')).toBe(false)
    expect(rowBehindLock('2026-06-15', null)).toBe(false)
  })
})

describe('syncShopifyOrders', () => {
  it('ingests order and refund rows against the 1584 cash account and advances the cursor', async () => {
    const { client, updates } = makeSupabaseMock()
    const order = makeOrder({
      displayFinancialStatus: 'PARTIALLY_REFUNDED',
      refunds: [
        {
          legacyResourceId: '77',
          createdAt: '2026-08-03T10:00:00Z',
          totalRefundedSet: money('250.00'),
        },
      ],
    })
    listOrdersPage.mockResolvedValueOnce(page([order]))
    vi.mocked(ingestTransactions).mockResolvedValueOnce({
      imported: 2,
      duplicates: 0,
      errors: 0,
    } as Awaited<ReturnType<typeof ingestTransactions>>)

    const summary = await syncShopifyOrders(client, makeConnection())

    expect(summary).toMatchObject({ fetched: 1, refundsFetched: 1, imported: 2, duplicates: 0 })
    expect(ensureManualCashAccount).toHaveBeenCalledWith(
      client,
      'company-1',
      '1584',
      'SEK',
      'Shopify-saldo',
    )
    expect(ingestTransactions).toHaveBeenCalledTimes(1)
    const [, companyId, userId, rows, ingestOptions] =
      vi.mocked(ingestTransactions).mock.calls[0]
    expect(companyId).toBe('company-1')
    expect(userId).toBe('user-1')
    expect((rows as Array<{ external_id: string }>).map((r) => r.external_id)).toEqual([
      'shopify_minbutik.myshopify.com_order_1042',
      'shopify_minbutik.myshopify.com_refund_77',
    ])
    expect(ingestOptions).toEqual({ settlementAccount: '1584', skipAutoCategorization: true })

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

  it('drops rows dated on/before the bookkeeping lock on every run', async () => {
    const { client, updates } = makeSupabaseMock({ lockThrough: '2026-08-02' })
    // Order paid 2026-08-01 (behind lock), refund created 2026-08-03 (after).
    const order = makeOrder({
      displayFinancialStatus: 'PARTIALLY_REFUNDED',
      refunds: [
        {
          legacyResourceId: '77',
          createdAt: '2026-08-03T10:00:00Z',
          totalRefundedSet: money('250.00'),
        },
      ],
    })
    listOrdersPage.mockResolvedValueOnce(page([order]))

    const summary = await syncShopifyOrders(client, makeConnection())

    expect(summary.skippedLocked).toBe(1)
    const [, , , rows] = vi.mocked(ingestTransactions).mock.calls[0]
    expect((rows as Array<{ external_id: string }>).map((r) => r.external_id)).toEqual([
      'shopify_minbutik.myshopify.com_refund_77',
    ])
    // The cursor still advances (page + watermark): the drop is by design,
    // not a failure.
    expect(cursorUpdates(updates)).toHaveLength(2)
  })

  it('holds the cursor below a page whose ingest reported errors', async () => {
    const { client, updates } = makeSupabaseMock()
    // Two orders so the assertion distinguishes "first updatedAt minus 1s"
    // (the floor rule) from "max updatedAt minus 1s".
    listOrdersPage.mockResolvedValueOnce(
      page([
        makeOrder(),
        makeOrder({ legacyResourceId: '1043', name: '#1043', updatedAt: '2026-08-02T08:00:00Z' }),
      ]),
    )
    vi.mocked(ingestTransactions).mockResolvedValueOnce({
      imported: 0,
      duplicates: 0,
      errors: 1,
    } as Awaited<ReturnType<typeof ingestTransactions>>)

    const summary = await syncShopifyOrders(client, makeConnection())

    expect(summary.errors).toBe(1)
    // Page's FIRST updatedAt 09:05:00 minus 1s: the next run re-lists it.
    // The floor also caps the end-of-run watermark, so no second update.
    const cursors = cursorUpdates(updates)
    expect(cursors).toHaveLength(1)
    expect(cursors[0].values.last_order_synced_at).toBe('2026-08-01T09:04:59.000Z')
  })

  it('falls back to the first order currency when the shop currency was unreadable', async () => {
    const { client } = makeSupabaseMock()
    listOrdersPage.mockResolvedValueOnce(
      page([makeOrder({ totalPriceSet: money('10.00', 'eur') })]),
    )

    await syncShopifyOrders(client, makeConnection({ currency: null }))

    expect(ensureManualCashAccount).toHaveBeenCalledWith(
      client,
      'company-1',
      '1584',
      'EUR',
      'Shopify-saldo',
    )
  })

  it('surfaces a cash-account failure on the connection instead of failing silently', async () => {
    const { client, updates } = makeSupabaseMock()
    listOrdersPage.mockResolvedValueOnce(page([makeOrder()]))
    vi.mocked(ensureManualCashAccount).mockRejectedValueOnce(
      new Error('cash account 1584 exists with currency EUR'),
    )

    await expect(syncShopifyOrders(client, makeConnection())).rejects.toThrow(
      /currency EUR/,
    )
    const errorUpdate = updates.find(
      (u) => u.table === 'shopify_connections' && 'error_message' in u.values,
    )
    expect(errorUpdate?.values.error_message).toMatch(/1584/)
  })

  it('counts an unparseable order total as an error without stalling the cursor', async () => {
    const { client, updates } = makeSupabaseMock()
    listOrdersPage.mockResolvedValueOnce(
      page([makeOrder({ totalPriceSet: money('not-a-number') })]),
    )

    const summary = await syncShopifyOrders(client, makeConnection())

    expect(summary.errors).toBe(1)
    expect(ingestTransactions).not.toHaveBeenCalled()
    // Deliberate: a permanently corrupt total must not stall the feed
    // (page cursor + end-of-run watermark both persist).
    expect(cursorUpdates(updates)).toHaveLength(2)
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
