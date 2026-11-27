/**
 * The cron shell around the spend sync: authorization, the no-connector-key
 * exit, the due-connection query, per-connection isolation, the run's time
 * budget, and a lease held by a person's "Hämta nu". The sync itself is
 * covered by lib/spend/__tests__/sync.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createFakeDb, type FakeDb } from '@/lib/spend/__tests__/fake-db'
import { eventBus } from '@/lib/events'

const h = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  configured: true,
  /** Run the real sync instead of the stand-in (the lease case). */
  realSync: false,
  sync: vi.fn(),
}))

vi.mock('@/lib/auth/cron', () => ({ verifyCronSecret: vi.fn(() => null) }))
vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: () => h.db.client }))
vi.mock('@/lib/spend/connect-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/spend/connect-client')>()),
  isSpendConnectConfigured: () => h.configured,
}))
vi.mock('@/lib/spend/sync', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/spend/sync')>()
  return {
    ...real,
    syncSpendConnection: (...args: Parameters<typeof real.syncSpendConnection>) =>
      h.realSync ? real.syncSpendConnection(...args) : h.sync(...args),
  }
})

import { verifyCronSecret } from '@/lib/auth/cron'
import { GET } from '../route'

const request = () => new Request('https://app.accounted.se/api/spend/cron')

const synced = (connectionId: string, received = 0, rejected = 0) => ({
  connectionId,
  status: 'synced',
  received,
  rejected,
  deferred: 0,
  changedAfterBooking: 0,
  masterData: 'unchanged',
})

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  vi.mocked(verifyCronSecret).mockReturnValue(null)
  h.configured = true
  h.realSync = false
  h.db = createFakeDb({
    spend_connections: [
      { id: 'due', company_id: 'company-1', status: 'active', next_run_at: '2026-01-01T00:00:00Z', lease_until: '1970-01-01T00:00:00.000Z' },
      { id: 'later', company_id: 'company-2', status: 'active', next_run_at: '2999-01-01T00:00:00Z', lease_until: '1970-01-01T00:00:00.000Z' },
      { id: 'ended', company_id: 'company-3', status: 'disconnected', next_run_at: '2026-01-01T00:00:00Z', lease_until: '1970-01-01T00:00:00.000Z' },
      { id: 'due-2', company_id: 'company-4', status: 'active', next_run_at: '2026-01-02T00:00:00Z', lease_until: '1970-01-01T00:00:00.000Z' },
    ],
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('GET /api/spend/cron', () => {
  it('refuses a caller without the cron secret', async () => {
    vi.mocked(verifyCronSecret).mockReturnValue(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))
    expect((await GET(request())).status).toBe(401)
    expect(h.sync).not.toHaveBeenCalled()
  })

  it('ends at once on an installation without a connector key', async () => {
    h.configured = false
    const body = await (await GET(request())).json()
    expect(body).toMatchObject({ success: true, skipped: true })
    expect(h.sync).not.toHaveBeenCalled()
  })

  it('receives for every active connection that is due, and only those', async () => {
    h.sync.mockImplementation(async (_db: unknown, id: string) => (id === 'due' ? synced(id, 2, 1) : synced(id, 1)))
    const body = await (await GET(request())).json()
    expect(h.sync.mock.calls.map((call) => call[1]).sort()).toEqual(['due', 'due-2'])
    expect(h.sync.mock.calls[0][0]).toBe(h.db.client)
    expect(body).toMatchObject({ success: true, connections: 2, received: 3, rejected: 1, failed: 0, deferred: 0, errors: 0 })
  })

  it('keeps going when one connection throws, and counts a failed sync', async () => {
    h.sync.mockImplementation(async (_db: unknown, id: string) => {
      if (id === 'due') throw new Error('boom')
      return { ...synced(id), status: 'failed', errorCode: 'CONNECTOR_SPEND_RECONNECT_REQUIRED' }
    })
    const body = await (await GET(request())).json()
    expect(h.sync).toHaveBeenCalledTimes(2)
    expect(body).toMatchObject({ connections: 2, failed: 1, errors: 1 })
  })

  it('stops starting connections when the run is out of time, and says how many wait', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-17T10:00:00Z'))
    h.sync.mockImplementation(async (_db: unknown, id: string) => {
      // The first connection takes four minutes.
      vi.setSystemTime(new Date('2026-10-17T10:04:00Z'))
      return synced(id, 1)
    })
    const body = await (await GET(request())).json()
    expect(h.sync).toHaveBeenCalledTimes(1)
    expect(body).toMatchObject({ connections: 2, received: 1, deferred: 1, errors: 0 })
  })

  it('hands every connection the same deadline inside the budget, and counts the ones it stopped', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-17T10:00:00Z'))
    h.sync.mockImplementation(async (_db: unknown, id: string) => ({ ...synced(id, 1), stoppedEarly: id === 'due-2' }))
    const body = await (await GET(request())).json()
    const deadlines = h.sync.mock.calls.map((call) => (call[2] as { deadlineMs: number }).deadlineMs)
    expect(new Set(deadlines).size).toBe(1)
    expect(deadlines[0]).toBeLessThanOrEqual(Date.parse('2026-10-17T10:00:00Z') + 200_000)
    expect(body).toMatchObject({ connections: 2, received: 2, stoppedEarly: 1, deferred: 0 })
  })

  it('leaves a connection alone while a person holds its lease, without calling Connect', async () => {
    h.realSync = true
    const lease = '2999-01-01T00:00:00.000Z'
    h.db.tables.spend_connections = [{ id: 'due', company_id: 'company-1', status: 'active', next_run_at: '2026-01-01T00:00:00Z', lease_until: lease }]
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const body = await (await GET(request())).json()
    expect(body).toMatchObject({ connections: 1, received: 0, rejected: 0, failed: 0, errors: 0 })
    expect(h.sync).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(h.db.tables.spend_connections[0].lease_until).toBe(lease)
  })
})
