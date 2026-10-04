/**
 * GET /api/collections/sync/cron: the cron secret, and one run over an
 * in-memory database with the fake adapter.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createFakeCollectionsAdapter, createFakeCollectionsStore } from '@/lib/collections/adapters/fake'
import type { CollectionsAdapter } from '@/lib/collections/port'
import { COMPANY_ID, createMemorySupabase, seedCompany, type MemorySupabase } from '@/lib/collections/__tests__/memory-supabase'

let db: MemorySupabase
let adapter: CollectionsAdapter
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => db.client }))
vi.mock('@/lib/collections/adapters', () => ({ collectionsAdapterFor: () => adapter, ensureCollectionsAdapters: () => {} }))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

import { GET } from '../route'

const call = (authorization?: string) =>
  GET(new Request('http://localhost/api/collections/sync/cron', { headers: authorization ? { authorization } : {} }))

beforeEach(() => {
  vi.stubEnv('CRON_SECRET', 'secret')
  db = createMemorySupabase()
  seedCompany(db)
  db.seed('collection_sync_state', [{ id: 1, last_run_at: null, last_error: null }])
  adapter = createFakeCollectionsAdapter({ store: createFakeCollectionsStore() })
})
afterEach(() => vi.unstubAllEnvs())

describe('GET /api/collections/sync/cron', () => {
  it('refuses a call without the cron secret', async () => {
    expect((await call()).status).toBe(401)
    expect((await call('Bearer wrong')).status).toBe(401)
  })

  it('polls only activations that reached the provider and records the run', async () => {
    db.seed('collection_connections', [
      // Sent, waiting at the provider: polled. The fake reads an unseen handle as active.
      {
        id: 'c-1',
        company_id: COMPANY_ID,
        route: 'fake',
        state: 'connecting',
        sub_status: 'in_review',
        connection_handle: 'fake-connection-unseen',
        submitted_at: '2026-10-04T08:00:00.000Z',
        provider_terms: null,
        activated_at: null,
        failures_in_row: 0,
        minimum_amount: 100,
        ladder_days_after_due: 10,
        late_interest_percent: null,
        updated_at: '2026-10-04T08:00:00.000Z',
      },
      // Consent only: nothing at the provider to read.
      {
        id: 'c-2',
        company_id: 'other-company',
        route: 'fake',
        state: 'connecting',
        sub_status: 'not_started',
        connection_handle: null,
        submitted_at: null,
        failures_in_row: 0,
        minimum_amount: 100,
        ladder_days_after_due: 10,
        late_interest_percent: null,
        updated_at: '2026-10-04T08:00:00.000Z',
      },
    ])
    const res = await call('Bearer secret')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: { polled: 1, changed: 1, failed: 0 } })
    const [polled, untouched] = db.rows('collection_connections')
    expect(polled).toMatchObject({ state: 'active', sub_status: null, user_id: null, health: 'ok' })
    expect(untouched).toMatchObject({ state: 'connecting', sub_status: 'not_started' })
    expect(db.rows('collection_sync_state')[0]!.last_run_at).toBeTruthy()
  })

  it('records a failing company on its own row and keeps going', async () => {
    db.seed('collection_connections', [
      {
        id: 'c-1',
        company_id: COMPANY_ID,
        route: 'fake',
        state: 'connecting',
        sub_status: 'in_review',
        connection_handle: 'h',
        submitted_at: '2026-10-04T08:00:00.000Z',
        failures_in_row: 0,
        minimum_amount: 100,
        ladder_days_after_due: 10,
        late_interest_percent: null,
        updated_at: '2026-10-04T08:00:00.000Z',
      },
    ])
    const { CollectionsError } = await import('@/lib/collections/errors')
    vi.spyOn(adapter, 'connection').mockRejectedValue(new CollectionsError('down', { code: 'CONNECTOR_UNREACHABLE', retryable: true }))
    const res = await call('Bearer secret')
    expect(await res.json()).toEqual({ data: { polled: 1, changed: 0, failed: 1 } })
    expect(db.rows('collection_connections')[0]).toMatchObject({ health: 'degraded', failures_in_row: 1, last_error_code: 'CONNECTOR_UNREACHABLE' })
    expect(db.rows('collection_sync_state')[0]!.last_error).toBe('down')
  })
})
