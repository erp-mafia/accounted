import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  activateIfComplete,
  expireStaleHandshakes,
  HANDSHAKE_TTL_MS,
  HANDSHAKE_EXPIRED_MESSAGE,
  isHandshakeExpired,
} from '../lib/connect'
import { createQueuedMockSupabase } from '@/tests/helpers'

const asClient = (supabase: unknown) => supabase as SupabaseClient

describe('isHandshakeExpired', () => {
  it('is false inside the TTL and true past it', () => {
    const now = Date.parse('2026-09-07T12:00:00Z')
    const fresh = new Date(now - HANDSHAKE_TTL_MS + 1_000).toISOString()
    const stale = new Date(now - HANDSHAKE_TTL_MS - 1_000).toISOString()
    expect(isHandshakeExpired(fresh, now)).toBe(false)
    expect(isHandshakeExpired(stale, now)).toBe(true)
  })
})

describe('activateIfComplete', () => {
  beforeEach(() => vi.clearAllMocks())

  it('flips to active only where the row is pending AND both signals are present', async () => {
    const { supabase, enqueue, calls, findCall } = createQueuedMockSupabase()
    enqueue({
      data: { id: 'conn-1', company_id: 'c1', user_id: 'u1', store_url: 'https://s.example.se' },
    })

    const result = await activateIfComplete(asClient(supabase), 'conn-1')

    expect(result).toEqual({
      outcome: 'activated',
      connection: { id: 'conn-1', company_id: 'c1', user_id: 'u1', store_url: 'https://s.example.se' },
    })
    const patch = findCall('woocommerce_connections', 'update')?.[0] as Record<string, unknown>
    expect(patch).toMatchObject({
      status: 'active',
      transaction_sync_enabled: true,
      oauth_state: null,
      error_message: null,
    })
    expect(typeof patch.connected_at).toBe('string')
    const eqCalls = calls.filter((c) => c.method === 'eq').map((c) => c.args)
    expect(eqCalls).toContainEqual(['id', 'conn-1'])
    expect(eqCalls).toContainEqual(['status', 'pending'])
    const notCalls = calls.filter((c) => c.method === 'not').map((c) => c.args)
    expect(notCalls).toEqual([
      ['consumer_key_encrypted', 'is', null],
      ['consumer_secret_encrypted', 'is', null],
      ['browser_confirmed_at', 'is', null],
    ])
  })

  it('reports incomplete when the conditional update matches no row', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })
    expect(await activateIfComplete(asClient(supabase), 'conn-1')).toEqual({
      outcome: 'incomplete',
    })
  })

  it('distinguishes the one-active-per-store conflict from other failures', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { code: '23505', message: 'duplicate key' } })
    enqueue({ data: null, error: { code: '42P01', message: 'boom' } })
    expect(await activateIfComplete(asClient(supabase), 'conn-1')).toEqual({
      outcome: 'conflict',
      error: { code: '23505', message: 'duplicate key' },
    })
    expect(await activateIfComplete(asClient(supabase), 'conn-1')).toEqual({
      outcome: 'failed',
      error: { code: '42P01', message: 'boom' },
    })
  })
})

describe('expireStaleHandshakes', () => {
  it('parks only pending rows older than the TTL, wiping state and staged keys', async () => {
    const { supabase, enqueue, calls, findCall } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'a' }, { id: 'b' }] })
    const now = Date.parse('2026-09-07T12:00:00Z')

    const result = await expireStaleHandshakes(asClient(supabase), now)

    expect(result).toEqual({ expired: 2, error: null })
    const patch = findCall('woocommerce_connections', 'update')?.[0]
    expect(patch).toEqual({
      status: 'error',
      error_message: HANDSHAKE_EXPIRED_MESSAGE,
      oauth_state: null,
      consumer_key_encrypted: null,
      consumer_secret_encrypted: null,
      store_name: null,
      currency: null,
      prices_include_tax: null,
      wc_version: null,
      key_permissions: null,
    })
    expect(calls.filter((c) => c.method === 'eq').map((c) => c.args)).toEqual([
      ['status', 'pending'],
    ])
    expect(calls.filter((c) => c.method === 'lt').map((c) => c.args)).toEqual([
      ['created_at', new Date(now - HANDSHAKE_TTL_MS).toISOString()],
    ])
  })

  it('surfaces a database error without throwing', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { code: '57014', message: 'canceled' } })
    expect(await expireStaleHandshakes(asClient(supabase))).toEqual({
      expired: 0,
      error: { code: '57014', message: 'canceled' },
    })
  })
})
