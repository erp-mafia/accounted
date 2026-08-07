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
  WOOCOMMERCE_IMPORT_SOURCE,
  WOOCOMMERCE_LEDGER_ACCOUNT,
  mapOrder,
  mapRefund,
  orderQualifies,
  rowBehindLock,
  syncWooCommerceOrders,
  wooOrderExternalId,
  wooRefundExternalId,
  wooStoreScope,
} from '../lib/order-sync'
import type { WooCommerceConnection, WooOrder, WooRefund } from '../types'

process.env.WOOCOMMERCE_CREDENTIALS_ENCRYPTION_KEY = 'test-key'

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
    ...overrides,
  }
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
    (u) => u.table === 'woocommerce_connections' && 'last_order_synced_at' in u.values,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  // Termination is an empty page; every test starts from a quiet store and
  // enqueues its pages with mockResolvedValueOnce.
  listOrdersPage.mockResolvedValue([])
  listOrderRefunds.mockResolvedValue([])
  vi.mocked(ingestTransactions).mockResolvedValue({
    imported: 0,
    duplicates: 0,
    errors: 0,
  } as Awaited<ReturnType<typeof ingestTransactions>>)
})

describe('frozen external_id formats', () => {
  // ⚠️ These assert the exact persisted formats. If this test fails, you are
  // about to orphan every previously imported WooCommerce row: do not update
  // the expectation without a coordinated backfill (see order-sync.ts).
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

  it('import source and ledger account are frozen', () => {
    expect(WOOCOMMERCE_IMPORT_SOURCE).toBe('woocommerce')
    expect(WOOCOMMERCE_LEDGER_ACCOUNT).toBe('1680')
  })
})

describe('orderQualifies', () => {
  it('requires date_paid and excludes trashed orders', () => {
    expect(orderQualifies(makeOrder())).toBe(true)
    expect(orderQualifies(makeOrder({ status: 'refunded' }))).toBe(true)
    expect(orderQualifies(makeOrder({ date_paid_gmt: null }))).toBe(false)
    expect(orderQualifies(makeOrder({ status: 'trash' }))).toBe(false)
  })
})

describe('mapOrder', () => {
  it('maps a paid order to one gross row dated by date_paid', () => {
    const rows = mapOrder('shop.example.se', makeOrder())
    expect(rows).toEqual([
      {
        date: '2026-08-01',
        description: 'WooCommerce-order #1042',
        amount: 1250,
        currency: 'SEK',
        external_id: 'woo_shop.example.se_order_1042',
        import_source: 'woocommerce',
        reference: 'pi_abc123',
      },
    ])
  })

  it('rounds string money to two decimals', () => {
    const rows = mapOrder('s', makeOrder({ total: '99.995' }))
    expect(rows[0].amount).toBe(100)
  })

  it('skips unpaid, trashed, zero-total and unparseable orders', () => {
    expect(mapOrder('s', makeOrder({ date_paid_gmt: null }))).toEqual([])
    expect(mapOrder('s', makeOrder({ status: 'trash' }))).toEqual([])
    expect(mapOrder('s', makeOrder({ total: '0.00' }))).toEqual([])
    expect(mapOrder('s', makeOrder({ total: 'not-a-number' }))).toEqual([])
  })
})

describe('mapRefund', () => {
  const refund: WooRefund = {
    id: 77,
    amount: '250.00',
    reason: 'Retur',
    date_created_gmt: '2026-08-03T10:00:00',
  }

  it('maps a refund to one negative row dated by the refund date', () => {
    const rows = mapRefund('shop.example.se', makeOrder(), refund)
    expect(rows).toEqual([
      {
        date: '2026-08-03',
        description: 'WooCommerce-återbetalning order #1042',
        amount: -250,
        currency: 'SEK',
        external_id: 'woo_shop.example.se_refund_77',
        import_source: 'woocommerce',
        reference: null,
      },
    ])
  })

  it('skips zero-amount refunds', () => {
    expect(mapRefund('s', makeOrder(), { ...refund, amount: '0' })).toEqual([])
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

describe('syncWooCommerceOrders', () => {
  it('ingests order and refund rows against the 1680 cash account and advances the cursor', async () => {
    const { client, updates } = makeSupabaseMock()
    const order = makeOrder({
      refunds: [{ id: 77, reason: 'Retur', total: '-250.00' }],
    })
    listOrdersPage.mockResolvedValueOnce([order])
    listOrderRefunds.mockResolvedValueOnce([
      { id: 77, amount: '250.00', reason: 'Retur', date_created_gmt: '2026-08-03T10:00:00' },
    ])
    vi.mocked(ingestTransactions).mockResolvedValueOnce({
      imported: 2,
      duplicates: 0,
      errors: 0,
    } as Awaited<ReturnType<typeof ingestTransactions>>)

    const summary = await syncWooCommerceOrders(client, makeConnection())

    expect(summary).toMatchObject({ fetched: 1, refundsFetched: 1, imported: 2, duplicates: 0 })
    expect(ensureManualCashAccount).toHaveBeenCalledWith(
      client,
      'company-1',
      '1680',
      'SEK',
      'WooCommerce-saldo',
    )
    expect(ingestTransactions).toHaveBeenCalledTimes(1)
    const [, companyId, userId, rows, ingestOptions] =
      vi.mocked(ingestTransactions).mock.calls[0]
    expect(companyId).toBe('company-1')
    expect(userId).toBe('user-1')
    expect((rows as Array<{ external_id: string }>).map((r) => r.external_id)).toEqual([
      'woo_shop.example.se_order_1042',
      'woo_shop.example.se_refund_77',
    ])
    expect(ingestOptions).toEqual({ settlementAccount: '1680', skipAutoCategorization: true })

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

  it('drops rows dated on/before the bookkeeping lock on every run', async () => {
    const { client, updates } = makeSupabaseMock({ lockThrough: '2026-08-02' })
    // Order paid 2026-08-01 (behind lock), refund created 2026-08-03 (after).
    const order = makeOrder({ refunds: [{ id: 77, reason: '', total: '-250.00' }] })
    listOrdersPage.mockResolvedValueOnce([order])
    listOrderRefunds.mockResolvedValueOnce([
      { id: 77, amount: '250.00', reason: '', date_created_gmt: '2026-08-03T10:00:00' },
    ])

    const summary = await syncWooCommerceOrders(client, makeConnection())

    expect(summary.skippedLocked).toBe(1)
    const [, , , rows] = vi.mocked(ingestTransactions).mock.calls[0]
    expect((rows as Array<{ external_id: string }>).map((r) => r.external_id)).toEqual([
      'woo_shop.example.se_refund_77',
    ])
    // The cursor still advances: the drop is by design, not a failure.
    expect(cursorUpdates(updates)).toHaveLength(1)
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

  it('falls back to the first order currency when store settings were unreadable', async () => {
    const { client } = makeSupabaseMock()
    listOrdersPage.mockResolvedValueOnce([makeOrder({ currency: 'eur' })])

    await syncWooCommerceOrders(client, makeConnection({ currency: null }))

    expect(ensureManualCashAccount).toHaveBeenCalledWith(
      client,
      'company-1',
      '1680',
      'EUR',
      'WooCommerce-saldo',
    )
  })

  it('surfaces a cash-account failure on the connection instead of failing silently', async () => {
    const { client, updates } = makeSupabaseMock()
    listOrdersPage.mockResolvedValueOnce([makeOrder()])
    vi.mocked(ensureManualCashAccount).mockRejectedValueOnce(
      new Error('cash account 1680 exists with currency EUR'),
    )

    await expect(syncWooCommerceOrders(client, makeConnection())).rejects.toThrow(
      /currency EUR/,
    )
    const errorUpdate = updates.find(
      (u) => u.table === 'woocommerce_connections' && 'error_message' in u.values,
    )
    expect(errorUpdate?.values.error_message).toMatch(/1680/)
  })

  it('counts an unparseable order total as an error without stalling the cursor', async () => {
    const { client, updates } = makeSupabaseMock()
    listOrdersPage.mockResolvedValueOnce([makeOrder({ total: 'not-a-number' })])

    const summary = await syncWooCommerceOrders(client, makeConnection())

    expect(summary.errors).toBe(1)
    expect(ingestTransactions).not.toHaveBeenCalled()
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
