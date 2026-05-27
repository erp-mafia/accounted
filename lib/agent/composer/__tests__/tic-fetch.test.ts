import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ensureTicSnapshot } from '../tic-fetch'

// `ensureTicSnapshot` is the single chokepoint between the agent build path
// and the TIC /profile endpoint. Every TIC call from agent onboarding goes
// through here, and the 3000/mo Lens budget makes the cache / fallback
// branches load-bearing. These tests cover:
//
//   - cache hit (fresh): no /profile call
//   - cache miss (no snapshot): /profile fetched + persisted
//   - cache hit but stale (>7d): refetch + persist
//   - cache hit but v1 shape + upgradeV1=true: refetch + persist
//   - cache hit but v1 shape + upgradeV1=false: stays v1 (budget protection)
//   - /profile fetch fails: returns existing snapshot (degraded, doesn't crash)
//   - company has no org_number anywhere: returns fallback null

const ORIGIN = 'http://localhost:3000'
const COMPANY_ID = 'company-uuid'

function buildSupabase(
  selectResult: { data: unknown; error: unknown } = { data: null, error: null },
  settingsSelectResult: { data: unknown; error: unknown } = { data: null, error: null },
  updateResult: { error: unknown } = { error: null },
) {
  const updateCalls: unknown[][] = []
  const fromCalls: string[] = []
  const from = vi.fn().mockImplementation((table: string) => {
    fromCalls.push(table)
    // Build a chain that resolves to whichever select result matches the
    // table. The function under test queries `companies` first, then
    // optionally `company_settings`, then `companies.update`.
    const chain: Record<string, unknown> = {}
    const methods = ['select', 'eq', 'limit', 'maybeSingle', 'single']
    for (const m of methods) {
      chain[m] = () => {
        if (m === 'single') {
          return Promise.resolve(table === 'companies' ? selectResult : settingsSelectResult)
        }
        if (m === 'maybeSingle') {
          return Promise.resolve(table === 'companies' ? selectResult : settingsSelectResult)
        }
        return chain
      }
    }
    chain.update = (payload: unknown) => {
      updateCalls.push([payload])
      const updateChain: Record<string, unknown> = {}
      updateChain.eq = () => Promise.resolve(updateResult)
      return updateChain
    }
    return chain
  })
  return {
    supabase: { from } as never,
    fromCalls,
    updateCalls,
  }
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ensureTicSnapshot — cache hit', () => {
  it('returns cached snapshot without hitting TIC when the row is fresh and v2-shaped', async () => {
    const fetchedAt = new Date(Date.now() - 60_000).toISOString() // 1 min ago
    const cached = { statuses: [], companyName: 'Cached AB' }
    const { supabase, fromCalls } = buildSupabase({
      data: { org_number: '5560125790', tic_snapshot: cached, tic_snapshot_fetched_at: fetchedAt },
      error: null,
    })

    const result = await ensureTicSnapshot({
      supabase,
      companyId: COMPANY_ID,
      cookieHeader: '',
      origin: ORIGIN,
    })

    expect(result.source).toBe('cached')
    expect(result.snapshot).toEqual(cached)
    expect(fetch).not.toHaveBeenCalled()
    // Only the companies SELECT should have run — no profile fetch, no update.
    expect(fromCalls).toEqual(['companies'])
  })

  it('does NOT call /profile when cache is fresh and upgradeV1=false, even if snapshot is v1', async () => {
    // V1 snapshot = no `statuses` key. Without upgradeV1=true, we accept it
    // as-is to protect the TIC budget across the customer base.
    const v1Snapshot = { companyName: 'V1 AB' /* no `statuses` */ }
    const fetchedAt = new Date(Date.now() - 60_000).toISOString()
    const { supabase } = buildSupabase({
      data: { org_number: '5560125790', tic_snapshot: v1Snapshot, tic_snapshot_fetched_at: fetchedAt },
      error: null,
    })

    const result = await ensureTicSnapshot({
      supabase,
      companyId: COMPANY_ID,
      cookieHeader: '',
      origin: ORIGIN,
      // upgradeV1 omitted -> defaults to false
    })

    expect(result.source).toBe('cached')
    expect(result.snapshot).toEqual(v1Snapshot)
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('ensureTicSnapshot — cache miss & refetch', () => {
  it('fetches /profile and persists when no snapshot exists', async () => {
    const profile = { statuses: [], companyName: 'Fresh AB' }
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ data: profile }), { status: 200 }),
    )

    const { supabase, updateCalls } = buildSupabase({
      data: { org_number: '5560125790', tic_snapshot: null, tic_snapshot_fetched_at: null },
      error: null,
    })

    const result = await ensureTicSnapshot({
      supabase,
      companyId: COMPANY_ID,
      cookieHeader: 'sb-auth=abc',
      origin: ORIGIN,
    })

    expect(result.source).toBe('fetched')
    expect(result.snapshot).toEqual(profile)
    // Hit the /profile endpoint with cookie forwarded
    expect(fetch).toHaveBeenCalledTimes(1)
    const fetchUrl = vi.mocked(fetch).mock.calls[0][0] as string
    expect(fetchUrl).toContain('/api/extensions/ext/tic/profile')
    expect(fetchUrl).toContain('org_number=5560125790')
    // Persisted via UPDATE
    expect(updateCalls).toHaveLength(1)
    const persisted = updateCalls[0][0] as Record<string, unknown>
    expect(persisted.tic_snapshot).toEqual(profile)
    expect(persisted.tic_snapshot_fetched_at).toBeDefined()
  })

  it('refetches when cached snapshot is stale (>7 days)', async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3600_000).toISOString()
    const oldSnapshot = { statuses: [], companyName: 'Old AB' }
    const freshProfile = { statuses: [], companyName: 'Fresh AB' }
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ data: freshProfile }), { status: 200 }),
    )

    const { supabase } = buildSupabase({
      data: {
        org_number: '5560125790',
        tic_snapshot: oldSnapshot,
        tic_snapshot_fetched_at: eightDaysAgo,
      },
      error: null,
    })

    const result = await ensureTicSnapshot({
      supabase,
      companyId: COMPANY_ID,
      cookieHeader: '',
      origin: ORIGIN,
    })

    expect(result.source).toBe('fetched')
    expect(result.snapshot).toEqual(freshProfile)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('refetches v1 snapshot when upgradeV1=true, even if still fresh', async () => {
    const v1Snapshot = { companyName: 'V1 AB' /* no statuses */ }
    const v2Profile = { statuses: [], companyName: 'V2 AB' }
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ data: v2Profile }), { status: 200 }),
    )

    const { supabase } = buildSupabase({
      data: {
        org_number: '5560125790',
        tic_snapshot: v1Snapshot,
        tic_snapshot_fetched_at: new Date().toISOString(),
      },
      error: null,
    })

    const result = await ensureTicSnapshot({
      supabase,
      companyId: COMPANY_ID,
      cookieHeader: '',
      origin: ORIGIN,
      upgradeV1: true,
    })

    expect(result.source).toBe('fetched')
    expect(result.snapshot).toEqual(v2Profile)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('ensureTicSnapshot — degraded paths', () => {
  it('returns fallback null when companies row does not exist', async () => {
    const { supabase } = buildSupabase({ data: null, error: null })

    const result = await ensureTicSnapshot({
      supabase,
      companyId: COMPANY_ID,
      cookieHeader: '',
      origin: ORIGIN,
    })

    expect(result.source).toBe('fallback')
    expect(result.snapshot).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('falls back to company_settings.org_number when companies.org_number is null', async () => {
    const profile = { statuses: [], companyName: 'EF Person' }
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ data: profile }), { status: 200 }),
    )

    const { supabase } = buildSupabase(
      { data: { org_number: null, tic_snapshot: null, tic_snapshot_fetched_at: null }, error: null },
      { data: { org_number: '8001011231' }, error: null },
    )

    const result = await ensureTicSnapshot({
      supabase,
      companyId: COMPANY_ID,
      cookieHeader: '',
      origin: ORIGIN,
    })

    expect(result.source).toBe('fetched')
    // Org number from company_settings flowed into the profile URL
    const fetchUrl = vi.mocked(fetch).mock.calls[0][0] as string
    expect(fetchUrl).toContain('org_number=8001011231')
  })

  it('returns fallback null when no org_number is available anywhere', async () => {
    const { supabase } = buildSupabase(
      { data: { org_number: null, tic_snapshot: null, tic_snapshot_fetched_at: null }, error: null },
      { data: { org_number: null }, error: null },
    )

    const result = await ensureTicSnapshot({
      supabase,
      companyId: COMPANY_ID,
      cookieHeader: '',
      origin: ORIGIN,
    })

    expect(result.source).toBe('fallback')
    expect(result.snapshot).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('returns existing (stale) snapshot when /profile fetch fails', async () => {
    const staleSnapshot = { companyName: 'Stale AB' }
    vi.mocked(fetch).mockResolvedValue(new Response('upstream down', { status: 502 }))

    const { supabase } = buildSupabase({
      data: {
        org_number: '5560125790',
        tic_snapshot: staleSnapshot,
        tic_snapshot_fetched_at: new Date(Date.now() - 8 * 24 * 3600_000).toISOString(), // forces refetch
      },
      error: null,
    })

    const result = await ensureTicSnapshot({
      supabase,
      companyId: COMPANY_ID,
      cookieHeader: '',
      origin: ORIGIN,
    })

    expect(result.source).toBe('fallback')
    // Degrade to the stale snapshot rather than crash — the agent build path
    // depends on this contract so a TIC outage never blocks onboarding.
    expect(result.snapshot).toEqual(staleSnapshot)
  })

  it('returns existing snapshot when /profile fetch throws (network error / timeout)', async () => {
    const staleSnapshot = { companyName: 'Stale AB' }
    vi.mocked(fetch).mockRejectedValue(new Error('ECONNREFUSED'))

    const { supabase } = buildSupabase({
      data: {
        org_number: '5560125790',
        tic_snapshot: staleSnapshot,
        tic_snapshot_fetched_at: new Date(Date.now() - 8 * 24 * 3600_000).toISOString(),
      },
      error: null,
    })

    const result = await ensureTicSnapshot({
      supabase,
      companyId: COMPANY_ID,
      cookieHeader: '',
      origin: ORIGIN,
    })

    expect(result.source).toBe('fallback')
    expect(result.snapshot).toEqual(staleSnapshot)
  })
})
