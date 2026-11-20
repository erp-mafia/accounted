import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import { readTicResponseCache, ticCacheKey, writeTicResponseCache } from '../cache'

const NOW = new Date('2026-10-28T10:00:00Z')
const ENDPOINT = '/search-public/companies?q=5560000001&query_by=registrationNumber'

describe('ticCacheKey', () => {
  it('is the SHA-256 hex of the endpoint, so no org number sits in the key', () => {
    const key = ticCacheKey(ENDPOINT)
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(key).not.toContain('5560000001')
    expect(ticCacheKey(ENDPOINT)).toBe(key)
    expect(ticCacheKey('/companies/1/status')).not.toBe(key)
  })
})

describe('readTicResponseCache', () => {
  beforeEach(() => vi.clearAllMocks())

  it('hits an unexpired row for this provider and key', async () => {
    const mock = createTableMockSupabase({ external_call_cache: { data: { response: { found: 1 } } } })
    const read = await readTicResponseCache(ENDPOINT, mock.supabase as unknown as SupabaseClient, NOW)
    expect(read).toEqual({ hit: true, value: { found: 1 } })
    expect(mock.findCall('external_call_cache', 'gt')).toEqual(['expires_at', NOW.toISOString()])
    expect(mock.findCalls('external_call_cache', 'eq')).toEqual([
      ['provider', 'tic'],
      ['cache_key', ticCacheKey(ENDPOINT)],
    ])
  })

  it('misses on no row, an error (table not deployed yet) or no database', async () => {
    const none = createTableMockSupabase({ external_call_cache: { data: null } })
    expect(await readTicResponseCache(ENDPOINT, none.supabase as unknown as SupabaseClient, NOW)).toEqual({ hit: false })
    const broken = createTableMockSupabase({ external_call_cache: { error: { code: '42P01' } } })
    expect(await readTicResponseCache(ENDPOINT, broken.supabase as unknown as SupabaseClient, NOW)).toEqual({
      hit: false,
    })
    expect(await readTicResponseCache(ENDPOINT, null, NOW)).toEqual({ hit: false })
  })
})

describe('writeTicResponseCache', () => {
  beforeEach(() => vi.clearAllMocks())

  it('upserts with a 24 h expiry and purges expired rows', async () => {
    const mock = createTableMockSupabase({ external_call_cache: { data: null } })
    await writeTicResponseCache(ENDPOINT, { found: 1 }, mock.supabase as unknown as SupabaseClient, NOW)
    expect(mock.payloads('external_call_cache', 'upsert')).toEqual([
      {
        provider: 'tic',
        cache_key: ticCacheKey(ENDPOINT),
        response: { found: 1 },
        fetched_at: NOW.toISOString(),
        expires_at: '2026-10-29T10:00:00.000Z',
      },
    ])
    expect(mock.findCall('external_call_cache', 'lt')).toEqual(['expires_at', NOW.toISOString()])
  })

  it('never writes a null answer and swallows a failed write', async () => {
    const mock = createTableMockSupabase({ external_call_cache: { error: { code: '42P01', message: 'missing' } } })
    await writeTicResponseCache(ENDPOINT, null, mock.supabase as unknown as SupabaseClient, NOW)
    expect(mock.supabase.from).not.toHaveBeenCalled()
    await expect(
      writeTicResponseCache(ENDPOINT, { found: 1 }, mock.supabase as unknown as SupabaseClient, NOW),
    ).resolves.toBeUndefined()
    expect(mock.findCalls('external_call_cache', 'delete')).toEqual([])
  })
})
