import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The TIC extension's profile service, as the registry hands it to core.
const { profileService, registryExtensions } = vi.hoisted(() => {
  const profileService = vi.fn()
  return {
    profileService,
    registryExtensions: { list: [{ id: 'tic', services: { fetchCompanyProfile: profileService } }] as unknown[] },
  }
})
vi.mock('@/lib/extensions/registry', () => ({
  extensionRegistry: { getAll: vi.fn(async () => registryExtensions.list) },
}))

import { ensureTicSnapshot } from '../tic-fetch'
import { FISCAL_YEAR_REOPEN_REGISTRY_KEYS } from '@/lib/core/bookkeeping/fiscal-year-reopen'

// `ensureTicSnapshot` is the single chokepoint between core and the TIC
// extension's profile service. Every snapshot fetch goes
// through here, and the 3000/mo Lens budget makes the cache / fallback
// branches load-bearing. These tests cover:
//
//   - cache hit (fresh): no profile call
//   - cache miss (no snapshot): profile fetched + persisted
//   - cache hit but stale (>7d): refetch + persist
//   - cache hit but v1 shape + upgradeV1=true: refetch + persist
//   - cache hit but v1 shape + upgradeV1=false: stays v1 (budget protection)
//   - profile fetch fails: returns existing snapshot (degraded, doesn't crash)
//   - TIC disabled (no provider): returns the cache, never throws
//   - company has no org_number anywhere: returns fallback null

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
  profileService.mockReset()
  registryExtensions.list = [{ id: 'tic', services: { fetchCompanyProfile: profileService } }]
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ensureTicSnapshot: cache hit', () => {
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
    })

    expect(result.source).toBe('cached')
    expect(result.snapshot).toEqual(cached)
    expect(profileService).not.toHaveBeenCalled()
    // Only the companies SELECT should have run: no profile fetch, no update.
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
      // upgradeV1 omitted -> defaults to false
    })

    expect(result.source).toBe('cached')
    expect(result.snapshot).toEqual(v1Snapshot)
    expect(profileService).not.toHaveBeenCalled()
  })
})

describe('ensureTicSnapshot: cache miss & refetch', () => {
  it('fetches /profile and persists when no snapshot exists', async () => {
    const profile = { statuses: [], companyName: 'Fresh AB' }
    profileService.mockResolvedValue(profile)

    const { supabase, updateCalls } = buildSupabase({
      data: { org_number: '5560125790', tic_snapshot: null, tic_snapshot_fetched_at: null },
      error: null,
    })

    const result = await ensureTicSnapshot({
      supabase,
      companyId: COMPANY_ID,
    })

    expect(result.source).toBe('fetched')
    expect(result.snapshot).toEqual(profile)
    // Asked the TIC extension's profile service for the company's org number
    expect(profileService).toHaveBeenCalledTimes(1)
    expect(profileService).toHaveBeenCalledWith('5560125790', { purpose: 'profile' })
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
    profileService.mockResolvedValue(freshProfile)

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
    })

    expect(result.source).toBe('fetched')
    expect(result.snapshot).toEqual(freshProfile)
    expect(profileService).toHaveBeenCalledTimes(1)
  })

  it('refetches v1 snapshot when upgradeV1=true, even if still fresh', async () => {
    const v1Snapshot = { companyName: 'V1 AB' /* no statuses */ }
    const v2Profile = { statuses: [], companyName: 'V2 AB' }
    profileService.mockResolvedValue(v2Profile)

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
      upgradeV1: true,
    })

    expect(result.source).toBe('fetched')
    expect(result.snapshot).toEqual(v2Profile)
    expect(profileService).toHaveBeenCalledTimes(1)
  })
})

describe('ensureTicSnapshot: requireKeys', () => {
  it('refetches a fresh snapshot that lacks a required key', async () => {
    const cached = { statuses: [], financialReports: [] /* no financialReportsComplete */ }
    const profile = { statuses: [], financialReports: [], financialReportsComplete: true }
    profileService.mockResolvedValue(profile)
    const { supabase } = buildSupabase({
      data: { org_number: '5560125790', tic_snapshot: cached, tic_snapshot_fetched_at: new Date().toISOString() },
      error: null,
    })

    const result = await ensureTicSnapshot({
      supabase,
      companyId: COMPANY_ID,
      requireKeys: ['financialReportsComplete'],
    })

    expect(result.source).toBe('fetched')
    expect(result.snapshot).toEqual(profile)
    expect(profileService).toHaveBeenCalledTimes(1)
  })

  it('keeps a fresh snapshot that has every required key', async () => {
    const cached = { statuses: [], financialReports: [], financialReportsComplete: false }
    const { supabase } = buildSupabase({
      data: { org_number: '5560125790', tic_snapshot: cached, tic_snapshot_fetched_at: new Date().toISOString() },
      error: null,
    })

    const result = await ensureTicSnapshot({
      supabase,
      companyId: COMPANY_ID,
      requireKeys: ['financialReportsComplete'],
    })

    expect(result.source).toBe('cached')
    expect(profileService).not.toHaveBeenCalled()
  })
})

describe('ensureTicSnapshot: degraded paths', () => {
  it('returns fallback null when companies row does not exist', async () => {
    const { supabase } = buildSupabase({ data: null, error: null })

    const result = await ensureTicSnapshot({
      supabase,
      companyId: COMPANY_ID,
    })

    expect(result.source).toBe('fallback')
    expect(result.snapshot).toBeNull()
    expect(profileService).not.toHaveBeenCalled()
  })

  it('falls back to company_settings.org_number when companies.org_number is null', async () => {
    const profile = { statuses: [], companyName: 'EF Person' }
    profileService.mockResolvedValue(profile)

    const { supabase } = buildSupabase(
      { data: { org_number: null, tic_snapshot: null, tic_snapshot_fetched_at: null }, error: null },
      { data: { org_number: '8001011231' }, error: null },
    )

    const result = await ensureTicSnapshot({
      supabase,
      companyId: COMPANY_ID,
    })

    expect(result.source).toBe('fetched')
    // Org number from company_settings flowed into the profile call
    expect(profileService).toHaveBeenCalledWith('8001011231', { purpose: 'profile' })
  })

  it('returns fallback null when no org_number is available anywhere', async () => {
    const { supabase } = buildSupabase(
      { data: { org_number: null, tic_snapshot: null, tic_snapshot_fetched_at: null }, error: null },
      { data: { org_number: null }, error: null },
    )

    const result = await ensureTicSnapshot({
      supabase,
      companyId: COMPANY_ID,
    })

    expect(result.source).toBe('fallback')
    expect(result.snapshot).toBeNull()
    expect(profileService).not.toHaveBeenCalled()
  })

  it('returns existing (stale) snapshot when TIC has no such company', async () => {
    const staleSnapshot = { companyName: 'Stale AB' }
    profileService.mockResolvedValue(null)

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
    })

    expect(result.source).toBe('fallback')
    expect(result.reason).toBe('not_found')
    // Degrade to the stale snapshot rather than crash: callers depend on
    // this contract so a TIC outage never blocks them.
    expect(result.snapshot).toEqual(staleSnapshot)
  })

  it('returns existing snapshot when the profile fetch throws (TIC outage, quota)', async () => {
    const staleSnapshot = { companyName: 'Stale AB' }
    profileService.mockRejectedValue(new Error('ECONNREFUSED'))

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
    })

    expect(result.source).toBe('fallback')
    expect(result.reason).toBe('unavailable')
    expect(result.snapshot).toEqual(staleSnapshot)
  })
})

describe('ensureTicSnapshot: no TIC provider', () => {
  it('returns the cached snapshot when the TIC extension is not enabled', async () => {
    registryExtensions.list = []
    const staleSnapshot = { companyName: 'Stale AB' }
    const { supabase, updateCalls } = buildSupabase({
      data: {
        org_number: '5560125790',
        tic_snapshot: staleSnapshot,
        tic_snapshot_fetched_at: new Date(Date.now() - 8 * 24 * 3600_000).toISOString(),
      },
      error: null,
    })

    const result = await ensureTicSnapshot({ supabase, companyId: COMPANY_ID })

    expect(result).toEqual({ snapshot: staleSnapshot, source: 'fallback', reason: 'unavailable' })
    expect(updateCalls).toHaveLength(0)
  })

  it('stops waiting at the timeout and keeps the cache', async () => {
    profileService.mockReturnValue(new Promise(() => {}))
    const { supabase } = buildSupabase({
      data: { org_number: '5560125790', tic_snapshot: null, tic_snapshot_fetched_at: null },
      error: null,
    })

    const result = await ensureTicSnapshot({ supabase, companyId: COMPANY_ID, timeoutMs: 10 })

    expect(result).toEqual({ snapshot: null, source: 'fallback', reason: 'unavailable' })
  })
})

// A detail call that failed (budget spent, timeout) leaves its section empty.
// The profile names those keys in incompleteSections, so an empty board reads
// as "could not ask", never as "no board".
describe('ensureTicSnapshot: incomplete sections', () => {
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString()

  it('reuses an incomplete snapshot for an hour, then asks again', async () => {
    const cached = { statuses: [], representatives: [], incompleteSections: ['representatives', 'statuses'] }
    const recent = buildSupabase({
      data: { org_number: '5560125790', tic_snapshot: cached, tic_snapshot_fetched_at: hoursAgo(0.5) },
      error: null,
    })
    expect((await ensureTicSnapshot({ supabase: recent.supabase, companyId: COMPANY_ID })).source).toBe('cached')
    expect(profileService).not.toHaveBeenCalled()

    const complete = { statuses: [{ code: 'isActive' }], representatives: [{ name: 'Anna' }], incompleteSections: [] }
    profileService.mockResolvedValue(complete)
    const older = buildSupabase({
      data: { org_number: '5560125790', tic_snapshot: cached, tic_snapshot_fetched_at: hoursAgo(2) },
      error: null,
    })
    const result = await ensureTicSnapshot({ supabase: older.supabase, companyId: COMPANY_ID })
    expect(result.source).toBe('fetched')
    expect(result.snapshot).toEqual(complete)
  })

  it('keeps a complete snapshot for the full week', async () => {
    const cached = { statuses: [], incompleteSections: [] }
    const { supabase } = buildSupabase({
      data: { org_number: '5560125790', tic_snapshot: cached, tic_snapshot_fetched_at: hoursAgo(48) },
      error: null,
    })
    expect((await ensureTicSnapshot({ supabase, companyId: COMPANY_ID })).source).toBe('cached')
    expect(profileService).not.toHaveBeenCalled()
  })

  it('keeps the last answered board and statuses when a refetch cannot fetch them', async () => {
    const previous = {
      orgNumber: '5560125790',
      companyName: 'Old AB',
      statuses: [{ code: 'isActive' }],
      board: { numberOfBoardMembers: 2 },
      representatives: [{ name: 'Anna' }],
      payrolls: [],
      incompleteSections: [],
    }
    const partial = {
      orgNumber: '5560125790',
      companyName: 'New AB',
      statuses: [],
      board: null,
      representatives: [],
      payrolls: [],
      incompleteSections: ['board', 'representatives', 'statuses', 'payrolls'],
    }
    profileService.mockResolvedValue(partial)
    const { supabase, updateCalls } = buildSupabase({
      data: { org_number: '5560125790', tic_snapshot: previous, tic_snapshot_fetched_at: null },
      error: null,
    })

    const result = await ensureTicSnapshot({ supabase, companyId: COMPANY_ID })

    const expected = {
      orgNumber: '5560125790',
      companyName: 'New AB',
      statuses: [{ code: 'isActive' }],
      board: { numberOfBoardMembers: 2 },
      representatives: [{ name: 'Anna' }],
      payrolls: [],
      // An empty previous value is no answer to keep: it stays missing.
      incompleteSections: ['payrolls'],
    }
    expect(result.source).toBe('fetched')
    expect(result.snapshot).toEqual(expected)
    expect((updateCalls[0][0] as Record<string, unknown>).tic_snapshot).toEqual(expected)
  })

  it('does not keep a section the previous snapshot could not fetch either', async () => {
    const previous = { orgNumber: '5560125790', statuses: [{ code: 'old' }], incompleteSections: ['statuses'] }
    const partial = { orgNumber: '5560125790', statuses: [], incompleteSections: ['statuses'] }
    profileService.mockResolvedValue(partial)
    const { supabase } = buildSupabase({
      data: { org_number: '5560125790', tic_snapshot: previous, tic_snapshot_fetched_at: null },
      error: null,
    })

    const result = await ensureTicSnapshot({ supabase, companyId: COMPANY_ID })

    expect(result.snapshot).toEqual(partial)
  })

  // The reopen gate reads the report list as of tic_snapshot_fetched_at, which
  // a refetch sets to now: a list carried from an older fetch would read as
  // fresh, and an empty one as "no report registered". Every key the gate
  // reads is answered in the previous fetch and missing from this one, so a
  // key it starts reading later is held to the same rule.
  it.each([
    ['a known report', [{ periodEnd: '2025-12-31', isInterimReport: false }]],
    ['no report', []],
  ])('never carries a key the closed-year reopen gate reads (%s)', async (_label, reports) => {
    const answered: Record<string, unknown> = { financialReports: reports, financialReportsComplete: true }
    const unanswered: Record<string, unknown> = { financialReports: [], financialReportsComplete: false }
    const previous: Record<string, unknown> = { orgNumber: '5560125790', statuses: [{ code: 'isActive' }], incompleteSections: [] }
    const partial: Record<string, unknown> = {
      orgNumber: '5560125790',
      statuses: [],
      incompleteSections: [...FISCAL_YEAR_REOPEN_REGISTRY_KEYS, 'statuses'],
    }
    for (const key of FISCAL_YEAR_REOPEN_REGISTRY_KEYS) {
      previous[key] = key in answered ? answered[key] : [{ answeredBy: 'the previous fetch' }]
      partial[key] = key in unanswered ? unanswered[key] : null
    }
    profileService.mockResolvedValue(partial)
    const { supabase, updateCalls } = buildSupabase({
      data: { org_number: '5560125790', tic_snapshot: previous, tic_snapshot_fetched_at: hoursAgo(24 * 8) },
      error: null,
    })

    const result = await ensureTicSnapshot({ supabase, companyId: COMPANY_ID })
    const snapshot = result.snapshot as Record<string, unknown>

    // What the gate will read: the saved row, not just the returned value.
    expect((updateCalls[0][0] as Record<string, unknown>).tic_snapshot).toEqual(snapshot)
    for (const key of FISCAL_YEAR_REOPEN_REGISTRY_KEYS) expect(snapshot[key]).toEqual(partial[key])
    expect(snapshot.incompleteSections).toEqual([...FISCAL_YEAR_REOPEN_REGISTRY_KEYS])
    // The sections nothing decides on are still kept.
    expect(snapshot.statuses).toEqual([{ code: 'isActive' }])
  })

  it('takes nothing from a snapshot of another firm', async () => {
    // The number was corrected since (tic-refresh): the old snapshot's board
    // belongs to another company.
    const previous = {
      orgNumber: '5566778899',
      board: { numberOfBoardMembers: 3 },
      representatives: [{ name: 'Someone Else' }],
      incompleteSections: [],
    }
    const partial = {
      orgNumber: '5560125790',
      board: null,
      representatives: [],
      incompleteSections: ['board', 'representatives'],
    }
    profileService.mockResolvedValue(partial)
    const { supabase } = buildSupabase({
      data: { org_number: '5560125790', tic_snapshot: previous, tic_snapshot_fetched_at: null },
      error: null,
    })

    const result = await ensureTicSnapshot({ supabase, companyId: COMPANY_ID })

    expect(result.snapshot).toEqual(partial)
  })
})
