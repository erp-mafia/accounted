import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import { readTicBudgetStatus, readTicPurposeSpent, readTicUpstreamLimits } from '../status'

const PROXY_URL = 'https://proxy.example.com/api/tic/proxy'
const NOW = new Date('2026-10-28T10:00:00Z')

describe('readTicUpstreamLimits', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
    vi.stubEnv('TIC_API_PROXY_URL', PROXY_URL)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('reads the free health endpoint with the proxy secret', async () => {
    vi.stubEnv('TIC_API_PROXY_SECRET', 's3cret')
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ limits: { rateLimit: 3000, rateLimitRemaining: 2400, rateLimitReset: '2026-11-22' } })),
    )
    await expect(readTicUpstreamLimits()).resolves.toEqual({
      rateLimit: 3000,
      rateLimitRemaining: 2400,
      rateLimitReset: '2026-11-22',
    })
    expect(fetch).toHaveBeenCalledWith(
      `${PROXY_URL}?endpoint=%2Ffree%2Fhealth`,
      expect.objectContaining({ headers: { Accept: 'application/json', 'x-proxy-secret': 's3cret' } }),
    )
  })

  it('is null when the proxy is unconfigured, down or answers garbage', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('nope', { status: 502 }))
    await expect(readTicUpstreamLimits()).resolves.toBeNull()
    vi.mocked(fetch).mockRejectedValue(new Error('down'))
    await expect(readTicUpstreamLimits()).resolves.toBeNull()
    vi.stubEnv('TIC_API_PROXY_URL', '')
    await expect(readTicUpstreamLimits()).resolves.toBeNull()
  })
})

describe('readTicBudgetStatus', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
    vi.stubEnv('TIC_API_PROXY_URL', PROXY_URL)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('puts our counters next to TIC count and reports the unattributed gap', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ limits: { rateLimit: 3000, rateLimitRemaining: 2000, rateLimitReset: null } })),
    )
    const mock = createTableMockSupabase({
      external_call_budget: {
        data: [
          { purpose: '_total', calls: 700 },
          { purpose: 'composer', calls: 500 },
          { purpose: 'onboarding_lookup', calls: 200 },
        ],
      },
    })
    const status = await readTicBudgetStatus(mock.supabase as unknown as SupabaseClient, NOW)
    expect(status.cycleStart).toBe('2026-10-22')
    expect(status.local?.total).toBe(700)
    expect(status.local?.byPurpose.composer).toBe(500)
    expect(status.local?.byPurpose.mcp_lookup).toBe(0)
    expect(status.unattributed).toBe(300)
    expect(mock.findCalls('external_call_budget', 'eq')).toEqual([
      ['provider', 'tic'],
      ['cycle_start', '2026-10-22'],
    ])
  })

  it('leaves the gap unknown when either side is missing', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('down'))
    const mock = createTableMockSupabase({ external_call_budget: { error: { code: '42P01' } } })
    const status = await readTicBudgetStatus(mock.supabase as unknown as SupabaseClient, NOW)
    expect(status.local).toBeNull()
    expect(status.upstream).toBeNull()
    expect(status.unattributed).toBeNull()
  })
})

describe('readTicPurposeSpent', () => {
  const NOV = new Date('2026-11-19T18:00:00Z')
  const counters = (rows: { purpose: string; calls: number }[]) =>
    createTableMockSupabase({ external_call_budget: { data: rows } }).supabase as unknown as SupabaseClient

  it('is spent once the total reaches what a non-priority purpose may use, and names the next cycle', async () => {
    const client = counters([
      { purpose: '_total', calls: 2661 },
      { purpose: 'refresh', calls: 275 },
    ])
    await expect(readTicPurposeSpent('refresh', client, NOV)).resolves.toEqual({ spent: true, resumesOn: '2026-11-22' })
    // The onboarding lookup may still spend the reserve.
    await expect(readTicPurposeSpent('onboarding_lookup', client, NOV)).resolves.toEqual({ spent: false, resumesOn: '2026-11-22' })
  })

  it('is spent when the purpose cap is reached under the total', async () => {
    const client = counters([
      { purpose: '_total', calls: 1300 },
      { purpose: 'composer', calls: 1200 },
    ])
    await expect(readTicPurposeSpent('composer', client, NOV)).resolves.toMatchObject({ spent: true })
    await expect(readTicPurposeSpent('refresh', client, NOV)).resolves.toMatchObject({ spent: false })
  })

  it('claims nothing when the counters cannot be read or there is no client', async () => {
    const broken = createTableMockSupabase({ external_call_budget: { error: { code: '42P01' } } })
    await expect(readTicPurposeSpent('refresh', broken.supabase as unknown as SupabaseClient, NOV)).resolves.toBeNull()
    await expect(readTicPurposeSpent('refresh', null, NOV)).resolves.toBeNull()
  })
})
