import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase, createTableMockSupabase } from '@/tests/helpers'
import type { Logger } from '@/lib/logger'
import { CAPABILITY } from '@/lib/entitlements/keys'

vi.mock('@/lib/entitlements/has-capability', () => ({ hasCapability: vi.fn(async () => true) }))

import { hasCapability } from '@/lib/entitlements/has-capability'
import { failureNote, runWebshopOrderCron, TIME_BUDGET_MS, type WebshopOrderCronSpec } from '../order-cron'

type Connection = { id: string; company_id: string }

describe('runWebshopOrderCron without credentials (accounted#115)', () => {
  let mock: ReturnType<typeof createQueuedMockSupabase>
  let log: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; child: ReturnType<typeof vi.fn> }
  const sync = vi.fn()
  const spec: WebshopOrderCronSpec<Connection> = {
    extensionId: 'shopify',
    label: 'Shopify',
    table: 'shopify_connections',
    capability: CAPABILITY.shopify_sync,
    isConfigured: () => false,
    sync,
  }

  async function run() {
    const ctx = { requestId: 'cron_1', log: log as unknown as Logger, supabase: mock.supabase as unknown as SupabaseClient }
    const response = await runWebshopOrderCron(ctx, spec)
    return { status: response.status, body: await response.json() }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mock = createQueuedMockSupabase()
    log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }
  })

  it('reports an error when connections with sync on go unsynced, and answers as before', async () => {
    mock.enqueue({ count: 3 })

    expect(await run()).toEqual({ status: 200, body: { message: 'Shopify not configured', processed: 0 } })

    expect(mock.findCall('shopify_connections', 'select')).toEqual(['id', { count: 'exact', head: true }])
    expect(mock.findCalls('shopify_connections', 'eq')).toEqual([['status', 'active'], ['transaction_sync_enabled', true]])
    expect(log.error).toHaveBeenCalledWith('Shopify is not configured; connections with sync on are not synced', {
      extensionId: 'shopify',
      alert: true,
      connections: 3,
    })
    expect(sync).not.toHaveBeenCalled()
  })

  it('says why it did nothing, at info, when no connection expects a sync', async () => {
    mock.enqueue({ count: 0 })

    expect((await run()).body.processed).toBe(0)

    expect(log.error).not.toHaveBeenCalled()
    expect(log.info).toHaveBeenCalledWith('Shopify is not configured and no connection has sync on; nothing to sync', {
      extensionId: 'shopify',
    })
  })

  it('reports an error when the connections cannot be counted', async () => {
    mock.enqueue({ error: { message: 'permission denied for table shopify_connections' } })

    expect((await run()).status).toBe(200)

    expect(log.error).toHaveBeenCalledWith('Shopify is not configured, and its connections could not be counted',
      expect.objectContaining({ message: 'permission denied for table shopify_connections' }),
      { extensionId: 'shopify', alert: true })
  })
})

// Before: a sync that threw every night was logged and nothing more, so the
// only trace in the settings panel was a last-synced date that stopped moving.
describe('runWebshopOrderCron writes a failed sync on its connection', () => {
  type Row = { id: string; company_id: string; error_message: string | null }
  const LEAD = 'Den senaste automatiska hämtningen från Shopify misslyckades.'
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }
  const sync = vi.fn()
  const spec: WebshopOrderCronSpec<Row> = {
    extensionId: 'shopify',
    label: 'Shopify',
    table: 'shopify_connections',
    capability: CAPABILITY.shopify_sync,
    isConfigured: () => true,
    sync,
  }

  async function run(rows: Row[]) {
    // One candidate page, then the answer to each update.
    const mock = createTableMockSupabase({ shopify_connections: [{ data: rows }, { data: null }] })
    const ctx = { requestId: 'cron_1', log: log as unknown as Logger, supabase: mock.supabase as unknown as SupabaseClient }
    const response = await runWebshopOrderCron(ctx, spec)
    return { mock, body: await response.json() }
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('stores a Swedish text, never the raw exception, on the active connection', async () => {
    sync.mockRejectedValue(new Error('connect ECONNRESET 10.0.0.1:443'))

    const { mock, body } = await run([{ id: 'c1', company_id: 'co1', error_message: null }])

    expect(body.results).toEqual([{ connectionId: 'c1', inserted: 0, updated: 0, status: 'error' }])
    expect(mock.payloads('shopify_connections', 'update')).toEqual([
      { error_message: `${LEAD} Vi försöker igen nästa natt.` },
    ])
    expect(mock.findCalls('shopify_connections', 'eq')).toEqual(
      expect.arrayContaining([['id', 'c1'], ['status', 'active']]),
    )
    expect(log.error).toHaveBeenCalledWith('shopify order sync failed for connection', expect.any(Error), {
      connectionId: 'c1',
      companyId: 'co1',
    })
  })

  it('writes the failure even when the row read at the start already carried it', async () => {
    // An order sync clears the text when an early page moves its cursor; a
    // throw on a later page must put it back.
    sync.mockRejectedValue(new Error('boom'))

    const { mock } = await run([{ id: 'c1', company_id: 'co1', error_message: `${LEAD} Vi försöker igen nästa natt.` }])

    expect(mock.payloads('shopify_connections', 'update')).toHaveLength(1)
  })

  it('clears the text when the next sync runs through', async () => {
    sync.mockResolvedValue({ inserted: 2, updated: 0 })

    const { mock, body } = await run([{ id: 'c1', company_id: 'co1', error_message: `${LEAD} Vi försöker igen nästa natt.` }])

    expect(body.results[0].status).toBe('synced')
    expect(mock.payloads('shopify_connections', 'update')).toEqual([{ error_message: null }])
  })

  it('keeps the text when the budget stopped the sync: it has not shown that the feed works again', async () => {
    sync.mockResolvedValue({ inserted: 0, updated: 0, deadlineReached: true })

    const { mock } = await run([{ id: 'c1', company_id: 'co1', error_message: `${LEAD} Vi försöker igen nästa natt.` }])

    expect(mock.payloads('shopify_connections', 'update')).toEqual([])
  })

  it('writes nothing for a healthy connection, and leaves a revoked one its own text', async () => {
    sync.mockResolvedValueOnce({ inserted: 0, updated: 0 }).mockResolvedValueOnce({ inserted: 0, updated: 0, revoked: true })

    const { mock } = await run([
      { id: 'c1', company_id: 'co1', error_message: null },
      { id: 'c2', company_id: 'co2', error_message: 'Butiken avvisade appens uppgifter. Anslut butiken igen.' },
    ])

    expect(mock.payloads('shopify_connections', 'update')).toEqual([])
  })

  it('a text that cannot be stored does not fail the run', async () => {
    sync.mockRejectedValue(new Error('boom'))
    const mock = createTableMockSupabase({
      shopify_connections: [{ data: [{ id: 'c1', company_id: 'co1', error_message: null }] }, { error: { message: 'timeout' } }],
    })
    const ctx = { requestId: 'cron_1', log: log as unknown as Logger, supabase: mock.supabase as unknown as SupabaseClient }

    const response = await runWebshopOrderCron(ctx, spec)

    expect(response.status).toBe(200)
    expect(log.warn).toHaveBeenCalledWith('could not write the sync failure text on the connection', {
      connectionId: 'c1',
      error: 'timeout',
    })
  })

  describe('failureNote', () => {
    it('keeps a sentence written for the user', () => {
      expect(failureNote('Zettle', new Error('Zettle svarade inte. Kontrollera att kontot är aktivt.'))).toBe(
        'Den senaste automatiska hämtningen från Zettle misslyckades. Zettle svarade inte. Kontrollera att kontot är aktivt.',
      )
    })

    it('drops provider English, also when it carries a word the mapping lets through', () => {
      // getErrorMessage passes "session" as a Swedish keyword.
      for (const raw of ['No such checkout session: cs_123', 'fetch failed', 'Request failed with status 502']) {
        expect(failureNote('Stripe Connect', new Error(raw))).toBe(
          'Den senaste automatiska hämtningen från Stripe Connect misslyckades. Vi försöker igen nästa natt.',
        )
      }
    })

    it('maps a database error to its sentence, never its text', () => {
      const note = failureNote('WooCommerce', { code: '23505', message: 'duplicate key value violates unique constraint "x"' })
      expect(note).toBe('Den senaste automatiska hämtningen från WooCommerce misslyckades. En post med samma uppgifter finns redan.')
    })
  })
})

// crm#2164: a run stopped after 50 synced connections, whatever was left of
// its budget, so the 51st entitled connection was left out of a night that
// had time for it.
describe('runWebshopOrderCron syncs connections until its budget runs out', () => {
  type Row = { id: string; company_id: string; error_message: string | null }
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }
  const sync = vi.fn()
  const spec: WebshopOrderCronSpec<Row> = {
    extensionId: 'stripe',
    label: 'Stripe Connect',
    table: 'stripe_connections',
    cursorColumn: 'last_balance_txn_synced_at',
    capability: CAPABILITY.stripe_payments,
    isConfigured: () => true,
    sync,
  }

  const rows = (prefix: string, n: number): Row[] =>
    Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i}`, company_id: `${prefix}-company-${i}`, error_message: null }))

  // The candidates as the database orders them, least recently synced first.
  async function run(candidates: Row[], now?: () => number) {
    const mock = createTableMockSupabase({ stripe_connections: [{ data: candidates }] })
    const ctx = { requestId: 'cron_1', log: log as unknown as Logger, supabase: mock.supabase as unknown as SupabaseClient }
    const response = await runWebshopOrderCron(ctx, spec, now)
    return { mock, body: await response.json() }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    sync.mockResolvedValue({ inserted: 0, updated: 0 })
  })

  afterEach(() => {
    vi.mocked(hasCapability).mockImplementation(async () => true)
  })

  it('syncs every entitled connection while there is time, also past 50', async () => {
    // As in production, connections that are not entitled sit among the entitled.
    const entitled = rows('paid', 51)
    const free = rows('free', 13)
    const candidates = entitled.flatMap((row, i) => (i < free.length ? [free[i], row] : [row]))
    vi.mocked(hasCapability).mockImplementation(async (_supabase, companyId) => companyId.startsWith('paid-'))

    const { mock, body } = await run(candidates)

    expect(mock.findCall('stripe_connections', 'order')).toEqual(['last_balance_txn_synced_at', { ascending: true, nullsFirst: true }])
    expect(sync.mock.calls.map(([, connection]) => connection.id)).toEqual(entitled.map((row) => row.id))
    expect(body.processed).toBe(51)
    expect(log.info).toHaveBeenCalledWith('stripe order sync summary', expect.objectContaining({ processed: 51, scanned: 64 }))
  })

  it('stops when the budget runs out and leaves the rest untouched for the next night', async () => {
    // Each sync takes a third of the budget: three start, the other two wait.
    // Each row carries an earlier night's failure text, which the runner
    // clears on a connection whose sync ran through, so a write shows which
    // connections it touched.
    let clock = 0
    sync.mockImplementation(async () => {
      clock += TIME_BUDGET_MS / 3
      return { inserted: 1, updated: 0 }
    })
    const candidates = rows('c', 5).map((row) => ({ ...row, error_message: failureNote('Stripe Connect', new Error('boom')) }))

    const { mock, body } = await run(candidates, () => clock)

    expect(sync.mock.calls.map(([, connection]) => connection.id)).toEqual(['c-0', 'c-1', 'c-2'])
    expect(body.results.map((result: { connectionId: string }) => result.connectionId)).toEqual(['c-0', 'c-1', 'c-2'])
    expect(mock.payloads('stripe_connections', 'update')).toEqual([{ error_message: null }, { error_message: null }, { error_message: null }])
    expect(mock.findCalls('stripe_connections', 'eq').filter(([column]) => column === 'id')).toEqual([['id', 'c-0'], ['id', 'c-1'], ['id', 'c-2']])
    expect(log.info).toHaveBeenCalledWith('time budget reached', { processedSoFar: 3, scanned: 3 })
  })
})
