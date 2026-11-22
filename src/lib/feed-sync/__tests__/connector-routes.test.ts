import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/has-capability')>()
  return { ...actual, requireCapability: vi.fn().mockResolvedValue(null) }
})
vi.mock('@/lib/auth/rate-limit-http', () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock('@/lib/auth/api-keys', () => ({
  createServiceClientNoCookies: vi.fn(() => ({ service: true })),
}))
vi.mock('@/lib/bookkeeping/ledger-coverage', () => ({
  ledgerCoveredThrough: vi.fn().mockResolvedValue(null),
}))

import { createQueuedMockSupabase } from '@/tests/helpers'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { CAPABILITY } from '@/lib/entitlements/keys'
import type { ExtensionContext } from '@/lib/extensions/types'
import { ledgerCoveredThrough } from '@/lib/bookkeeping/ledger-coverage'
import {
  feedBackfillRoute,
  feedConnectorRoutes,
  feedDisconnectRoute,
  feedStatusRoute,
  feedSyncRoute,
  feedTransactionSyncRoute,
  type FeedConnectorSpec,
} from '../connector-routes'

type Row = { id: string; company_id: string; status: string; cursor_at: string | null }
type Summary = { fetched: number; locked?: boolean }

function spec(overrides: Partial<FeedConnectorSpec<Row, Summary>> = {}): FeedConnectorSpec<Row, Summary> {
  return {
    extensionId: 'shopify',
    table: 'feed_connections',
    capability: CAPABILITY.shopify_sync,
    cursorColumn: 'cursor_at',
    maxBackfillYears: 3,
    settlementAccounts: ['1686'],
    notConnectedMessage: 'Ingen anslutning.',
    statusColumns: 'id, status',
    isConfigured: () => true,
    sync: vi.fn().mockResolvedValue({ fetched: 2 }),
    disconnect: {
      columns: 'shop_domain',
      clearColumns: ['secret_encrypted'],
      eventIdentity: (c) => ({ shopDomain: (c.shop_domain as string | null) ?? null }),
    },
    ...overrides,
  }
}

function request(method: string, body?: unknown): Request {
  return new Request('https://test.local/api/extensions/ext/shopify/x', {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

function context(supabase: unknown): ExtensionContext {
  return {
    userId: 'user-1',
    companyId: 'company-1',
    extensionId: 'shopify',
    supabase,
    emit: vi.fn().mockResolvedValue(undefined),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

function serviceReturning(...results: Array<{ data?: unknown; error?: unknown }>) {
  const service = createQueuedMockSupabase()
  for (const result of results) service.enqueue(result)
  vi.mocked(createServiceClientNoCookies).mockReturnValueOnce(service.supabase as never)
  return service
}

const ACTIVE: Row = { id: 'c1', company_id: 'company-1', status: 'active', cursor_at: '2026-09-01T00:00:00.000Z' }
/** What a sync throws when no run can get through (the Stripe feed's status). */
const TOO_LARGE = 'Historiken hos Stripe är för stor för att hämtas automatiskt. Supporten har fått veta det.'

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(ledgerCoveredThrough).mockResolvedValue(null)
})

describe('feedConnectorRoutes', () => {
  it('serves the five shared routes', () => {
    expect(feedConnectorRoutes(spec()).map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /status',
      'POST /sync',
      'POST /backfill',
      'POST /transaction-sync',
      'DELETE /disconnect',
    ])
  })
})

describe('GET /status', () => {
  async function status(rows: unknown[]) {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: rows })
    const res = await feedStatusRoute(spec()).handler(request('GET'), context(supabase))
    return (await res.json()).connection
  }

  it('shows the active connection over the failed attempts before it', async () => {
    const connection = await status([
      { id: 'retry', status: 'error', connected_at: null },
      { id: 'live', status: 'active', connected_at: '2026-11-01T10:00:00.000Z' },
    ])
    expect(connection.id).toBe('live')
  })

  it('shows a disconnected connection so the panel can say so', async () => {
    const connection = await status([{ id: 'gone', status: 'revoked', connected_at: '2026-11-01T10:00:00.000Z' }])
    expect(connection.id).toBe('gone')
  })

  it('does not bring back a failed attempt the user removed (crm#2056)', async () => {
    const connection = await status([
      { id: 'removed', status: 'revoked', connected_at: null },
      { id: 'older', status: 'error', connected_at: null },
    ])
    expect(connection).toBeNull()
  })
})

describe('POST /sync', () => {
  it('answers 409 when every connection lost the sync lock, so nothing ran', async () => {
    const { supabase } = createQueuedMockSupabase()
    serviceReturning({ data: [ACTIVE] })
    const s = spec({ sync: vi.fn().mockResolvedValue({ fetched: 0, locked: true }) })
    const res = await feedSyncRoute(s).handler(request('POST'), context(supabase))
    expect(res.status).toBe(409)
  })

  it('runs every active connection and reports each one', async () => {
    const { supabase } = createQueuedMockSupabase()
    const service = serviceReturning({ data: [ACTIVE, { ...ACTIVE, id: 'c2' }] })
    const s = spec()
    const res = await feedSyncRoute(s).handler(request('POST'), context(supabase))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.results.map((r: { connection_id: string }) => r.connection_id)).toEqual(['c1', 'c2'])
    expect(body.skipped).toBe(0)
    expect(body.transactions).toEqual({ fetched: 2 })
    expect(vi.mocked(s.sync).mock.calls[0][0]).toBe(service.supabase)
    expect(typeof vi.mocked(s.sync).mock.calls[0][2]).toBe('number')
  })

  it('runs without a deadline when the connector opts out of the budget', async () => {
    const { supabase } = createQueuedMockSupabase()
    serviceReturning({ data: [ACTIVE] })
    const s = spec({ manualSyncBudgetMs: null })
    await feedSyncRoute(s).handler(request('POST'), context(supabase))
    expect(vi.mocked(s.sync).mock.calls[0][2]).toBeUndefined()
  })

  it('answers 404 with the connector copy when nothing is connected', async () => {
    const { supabase } = createQueuedMockSupabase()
    serviceReturning({ data: [] })
    const res = await feedSyncRoute(spec()).handler(request('POST'), context(supabase))
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('Ingen anslutning.')
  })

  it('answers the Swedish sentence a sync failed with, not a "try again" that fails the same way', async () => {
    const { supabase } = createQueuedMockSupabase()
    serviceReturning({ data: [ACTIVE] })
    const res = await feedSyncRoute(spec({ sync: vi.fn().mockRejectedValue(new Error(TOO_LARGE)) })).handler(
      request('POST'),
      context(supabase),
    )
    expect(res.status).toBe(502)
    expect((await res.json()).error).toBe(TOO_LARGE)

    // A provider's own English still reads as the generic sentence.
    serviceReturning({ data: [ACTIVE] })
    const english = await feedSyncRoute(spec({ sync: vi.fn().mockRejectedValue(new Error('upstream exploded')) })).handler(
      request('POST'),
      context(supabase),
    )
    expect((await english.json()).error).toBe('Synkroniseringen misslyckades. Försök igen.')
  })
})

describe('POST /backfill', () => {
  it('puts the cursor back and answers 409 when another run holds the lock', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    serviceReturning({ data: [ACTIVE] })
    enqueue({ data: [] }) // cursor moved back to the chosen date
    enqueue({ data: [] }) // cursor restored
    const s = spec({ sync: vi.fn().mockResolvedValue({ fetched: 0, locked: true }) })
    const res = await feedBackfillRoute(s).handler(request('POST', { from: '2026-01-01' }), context(supabase))
    expect(res.status).toBe(409)
    const updates = findCalls('feed_connections', 'update')
    expect(updates[0][0]).toEqual({ cursor_at: '2026-01-01T00:00:00.000Z', error_message: null })
    expect(updates[1][0]).toEqual({ cursor_at: '2026-09-01T00:00:00.000Z' })
  })

  it('refuses to guess between several active connections', async () => {
    const { supabase } = createQueuedMockSupabase()
    serviceReturning({ data: [ACTIVE, { ...ACTIVE, id: 'c2' }] })
    const s = spec()
    const res = await feedBackfillRoute(s).handler(request('POST', { from: '2026-01-01' }), context(supabase))
    expect(res.status).toBe(400)
    expect(s.sync).not.toHaveBeenCalled()
  })

  it('syncs from the chosen date', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const service = serviceReturning({ data: [ACTIVE] })
    enqueue({ data: [] })
    const s = spec()
    const res = await feedBackfillRoute(s).handler(request('POST', { from: '2026-01-01' }), context(supabase))
    expect(res.status).toBe(200)
    expect(vi.mocked(s.sync).mock.calls[0][1].cursor_at).toBe('2026-01-01T00:00:00.000Z')
    expect(ledgerCoveredThrough).toHaveBeenCalledWith(service.supabase, 'company-1', ['1686'], '2026-01-01')
    expect((await res.json()).booked_through).toBeNull()
  })

  it('answers the Swedish sentence the sync failed with', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    serviceReturning({ data: [ACTIVE] })
    enqueue({ data: [] })
    const s = spec({ sync: vi.fn().mockRejectedValue(new Error(TOO_LARGE)) })
    const res = await feedBackfillRoute(s).handler(request('POST', { from: '2026-01-01' }), context(supabase))
    expect(res.status).toBe(502)
    expect((await res.json()).error).toBe(TOO_LARGE)
  })

  it('starts after the days the books already hold, never inside them (crm#1386)', async () => {
    // A hand-entered samlingsverifikat on 1686 covers 1-17 October; the user
    // asked from the 17th to catch one payment of the 18th.
    vi.mocked(ledgerCoveredThrough).mockResolvedValueOnce('2026-10-17')
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    serviceReturning({ data: [ACTIVE] })
    enqueue({ data: [] })
    const s = spec({ backfillCursor: (day) => `${day}T-start` })
    const res = await feedBackfillRoute(s).handler(request('POST', { from: '2026-10-17' }), context(supabase))
    expect(res.status).toBe(200)
    expect(findCalls('feed_connections', 'update')[0][0]).toEqual({ cursor_at: '2026-10-18T-start', error_message: null })
    expect(vi.mocked(s.sync).mock.calls[0][1].cursor_at).toBe('2026-10-18T-start')
    const body = await res.json()
    expect(body.from).toBe('2026-10-18T-start')
    expect(body.booked_through).toBe('2026-10-17')
  })

  it('reaches into booked days only when the caller says include_booked', async () => {
    vi.mocked(ledgerCoveredThrough).mockResolvedValue('2026-10-17')
    const { supabase, enqueue } = createQueuedMockSupabase()
    serviceReturning({ data: [ACTIVE] })
    enqueue({ data: [] })
    const s = spec()
    const res = await feedBackfillRoute(s).handler(
      request('POST', { from: '2026-10-01', include_booked: true }),
      context(supabase),
    )
    expect(res.status).toBe(200)
    expect(ledgerCoveredThrough).not.toHaveBeenCalled()
    expect(vi.mocked(s.sync).mock.calls[0][1].cursor_at).toBe('2026-10-01T00:00:00.000Z')
    expect((await res.json()).booked_through).toBeNull()
  })

  it('leaves the cursor alone when the books already hold every day asked for', async () => {
    vi.mocked(ledgerCoveredThrough).mockResolvedValueOnce('2999-12-31')
    const { supabase, findCalls } = createQueuedMockSupabase()
    serviceReturning({ data: [ACTIVE] })
    const s = spec()
    const res = await feedBackfillRoute(s).handler(request('POST', { from: '2026-10-01' }), context(supabase))
    expect(res.status).toBe(200)
    expect(findCalls('feed_connections', 'update')).toHaveLength(0)
    // An ordinary sync from where the feed stands.
    expect(vi.mocked(s.sync).mock.calls[0][1].cursor_at).toBe(ACTIVE.cursor_at)
    const body = await res.json()
    expect(body.from).toBeNull()
    expect(body.booked_through).toBe('2999-12-31')
  })

  it('moves nothing when the books cannot be read', async () => {
    vi.mocked(ledgerCoveredThrough).mockRejectedValueOnce(new Error('statement timeout'))
    const { supabase, findCalls } = createQueuedMockSupabase()
    serviceReturning({ data: [ACTIVE] })
    const s = spec()
    const res = await feedBackfillRoute(s).handler(request('POST', { from: '2026-10-01' }), context(supabase))
    expect(res.status).toBe(500)
    expect(findCalls('feed_connections', 'update')).toHaveLength(0)
    expect(s.sync).not.toHaveBeenCalled()
  })

  it("lets a connector say where the chosen day starts (validated day in, cursor out)", async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    serviceReturning({ data: [ACTIVE] })
    enqueue({ data: [] })
    const backfillCursor = vi.fn(() => '2025-12-31T23:00:00.000Z')
    const s = spec({ backfillCursor })
    const res = await feedBackfillRoute(s).handler(request('POST', { from: '2026-01-01' }), context(supabase))
    expect(res.status).toBe(200)
    expect(backfillCursor).toHaveBeenCalledWith('2026-01-01')
    expect(findCalls('feed_connections', 'update')[0][0]).toEqual({
      cursor_at: '2025-12-31T23:00:00.000Z',
      error_message: null,
    })
    expect(vi.mocked(s.sync).mock.calls[0][1].cursor_at).toBe('2025-12-31T23:00:00.000Z')
    expect((await res.json()).from).toBe('2025-12-31T23:00:00.000Z')
  })
})

describe('POST /transaction-sync', () => {
  it('requires a boolean', async () => {
    const { supabase } = createQueuedMockSupabase()
    const res = await feedTransactionSyncRoute(spec()).handler(request('POST', { enabled: 'yes' }), context(supabase))
    expect(res.status).toBe(400)
  })

  it('answers 404 when no active connection was updated', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [] })
    const res = await feedTransactionSyncRoute(spec()).handler(request('POST', { enabled: true }), context(supabase))
    expect(res.status).toBe(404)
  })
})

describe('DELETE /disconnect', () => {
  it('revokes locally when the remote revoke throws, clears the credentials and emits', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'c1', status: 'active', shop_domain: 'shop.example' }] })
    enqueue({ data: null, error: null })
    const revokeRemote = vi.fn().mockRejectedValue(new Error('gone'))
    const s = spec({ disconnect: { ...spec().disconnect, revokeRemote } })
    const ctx = context(supabase)
    const res = await feedDisconnectRoute(s).handler(request('DELETE', {}), ctx)
    expect(res.status).toBe(200)
    expect(revokeRemote).toHaveBeenCalled()
    const update = findCalls('feed_connections', 'update')[0][0]
    expect(update).toMatchObject({ status: 'revoked', secret_encrypted: null })
    expect(ctx.emit).toHaveBeenCalledWith({
      type: 'shopify.disconnected',
      payload: {
        connectionId: 'c1',
        shopDomain: 'shop.example',
        reason: 'user',
        userId: 'user-1',
        companyId: 'company-1',
      },
    })
  })

  it('answers 404 when there is nothing to disconnect', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [] })
    const res = await feedDisconnectRoute(spec()).handler(request('DELETE', {}), context(supabase))
    expect(res.status).toBe(404)
  })
})
