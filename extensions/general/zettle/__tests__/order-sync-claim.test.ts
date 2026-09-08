import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { SupabaseClient } from '@supabase/supabase-js'

const refreshAccessToken = vi.fn()
vi.mock('../lib/oauth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/oauth')>()
  return { ...actual, refreshAccessToken: (...args: unknown[]) => refreshAccessToken(...args) }
})
vi.mock('../lib/credentials', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/credentials')>()
  return { ...actual, refreshTokenOf: () => 'refresh-token', encryptCredential: (v: string) => `enc:${v}` }
})

import { syncZettlePurchases } from '../lib/order-sync'
import type { ZettleConnection } from '../types'

const connection: ZettleConnection = {
  id: 'conn-1',
  company_id: 'company-1',
  user_id: 'user-1',
  organization_uuid: 'org-1',
  organization_name: 'Caféet',
  refresh_token_encrypted: 'enc:old',
  oauth_state: null,
  return_origin: null,
  sync_lock_until: null,
  status: 'active',
  currency: 'SEK',
  transaction_sync_enabled: true,
  last_order_synced_at: null,
  error_message: null,
  connected_at: '2026-09-01T00:00:00.000Z',
  disconnected_at: null,
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z',
}

describe('syncZettlePurchases sync claim', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does not touch the rotating refresh token when another run holds the claim', async () => {
    const { supabase, enqueue, calls } = createQueuedMockSupabase()
    enqueue({ data: [] }) // claim update matched no row: locked by another run

    const summary = await syncZettlePurchases(
      supabase as unknown as SupabaseClient,
      { ...connection },
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    )

    expect(summary.locked).toBe(true)
    expect(refreshAccessToken).not.toHaveBeenCalled()
    const claim = calls.find((c) => c.method === 'update')
    expect(claim?.table).toBe('zettle_connections')
    expect(claim?.args[0]).toHaveProperty('sync_lock_until')
  })
})
