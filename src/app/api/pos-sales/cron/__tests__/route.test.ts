/**
 * The cron shell around the POS fetch: authorization, the no-connector-key
 * exit, the due-connection query, and per-connection isolation. The fetch
 * itself is covered by lib/pos-sales/__tests__/sync.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createFakeDb, type FakeDb } from '@/lib/pos-sales/__tests__/fake-db'

const h = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  configured: true,
  sync: vi.fn(),
}))

vi.mock('@/lib/auth/cron', () => ({ verifyCronSecret: vi.fn(() => null) }))
vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: () => h.db.client }))
vi.mock('@/lib/pos-sales/connect-client', () => ({ isPosConnectConfigured: () => h.configured }))
vi.mock('@/lib/pos-sales/sync', () => ({ syncPosConnection: (...args: unknown[]) => h.sync(...args) }))

import { verifyCronSecret } from '@/lib/auth/cron'
import { GET } from '../route'

const request = () => new Request('https://app.accounted.se/api/pos-sales/cron')

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyCronSecret).mockReturnValue(null)
  h.configured = true
  h.db = createFakeDb({
    pos_connections: [
      { id: 'due', status: 'active', next_run_at: '2026-01-01T00:00:00Z' },
      { id: 'later', status: 'active', next_run_at: '2999-01-01T00:00:00Z' },
      { id: 'ended', status: 'disconnected', next_run_at: '2026-01-01T00:00:00Z' },
      { id: 'due-2', status: 'active', next_run_at: '2026-01-02T00:00:00Z' },
    ],
  })
})

describe('GET /api/pos-sales/cron', () => {
  it('refuses a caller without the cron secret', async () => {
    vi.mocked(verifyCronSecret).mockReturnValue(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))
    expect((await GET(request())).status).toBe(401)
    expect(h.sync).not.toHaveBeenCalled()
  })

  it('ends at once on an installation without a connector key', async () => {
    h.configured = false
    const body = await (await GET(request())).json()
    expect(body).toMatchObject({ skipped: true })
    expect(h.sync).not.toHaveBeenCalled()
  })

  it('fetches every active connection that is due, and only those', async () => {
    h.sync.mockImplementation(async (_db: unknown, id: string) => ({ connectionId: id, status: 'synced', fetched: ['2026-10-02'], changed: [], changedAfterBooking: [] }))
    const body = await (await GET(request())).json()
    expect(h.sync.mock.calls.map((c) => c[1]).sort()).toEqual(['due', 'due-2'])
    expect(body).toMatchObject({ success: true, connections: 2, fetched: 2, failed: 0 })
  })

  it('keeps going when one connection throws', async () => {
    h.sync.mockImplementation(async (_db: unknown, id: string) => {
      if (id === 'due') throw new Error('boom')
      return { connectionId: id, status: 'synced', fetched: [], changed: [], changedAfterBooking: [] }
    })
    const body = await (await GET(request())).json()
    expect(h.sync).toHaveBeenCalledTimes(2)
    expect(body).toMatchObject({ connections: 2, errors: 1 })
  })
})
