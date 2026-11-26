/**
 * refreshStaleGraphs for the nightly lint with `*` in the rollout.
 *
 * The lint cron passes every company, up to 500, and the snapshots are read
 * by company id with `.in()`: supabase-js puts the ids in the GET query
 * string, so 500 uuids (about 19.5 KB) were refused by the gateway and no
 * graph was rebuilt that night. The fake gateway (tests/gateway-supabase.ts)
 * refuses a URL past a self-hosted Kong's 8 KB.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createGatewaySupabase, GATEWAY_URL_LIMIT, inListOf } from '@/tests/gateway-supabase'

vi.mock('../build', () => ({ buildCompanyGraph: vi.fn(), GRAPH_VERSION: 2 }))

import { buildCompanyGraph } from '../build'
import { refreshStaleGraphs } from '../snapshot'

const COMPANIES = 500
const REBUILDS = 100
const HOUR = 3600 * 1000

const uuid = (n: number) => `cccccccc-0000-4000-8000-${String(n).padStart(12, '0')}`
const built = { company: { ref: 'company:c', name: 'X' }, computed_at: '2026-10-01T10:00:00Z', period: { from: '', to: '' }, months: [], series: {}, clusters: [], nodes: [], links: [], truncated: false }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(buildCompanyGraph).mockResolvedValue(built as never)
})

/**
 * Every tenth company of the even ones has no snapshot, the odd ones have a
 * fresh one, and the other even ones one drawn more than a day ago, the
 * higher the number the older.
 */
function snapshots() {
  const now = Date.now()
  const rows = []
  for (let n = 1; n <= COMPANIES; n++) {
    if (n % 50 === 0) continue
    const age = n % 2 === 1 ? HOUR : 25 * HOUR + n * 60_000
    rows.push({ company_id: uuid(n), stale: false, computed_at: new Date(now - age).toISOString() })
  }
  return rows
}

describe('refreshStaleGraphs: every company in the rollout', () => {
  it('rebuilds the missing snapshots and then the oldest, in requests the gateway takes', async () => {
    const companyIds = Array.from({ length: COMPANIES }, (_, i) => uuid(i + 1))
    const { supabase, requests, requestsTo, unmodelled } = createGatewaySupabase({ arkiv_graph_snapshots: snapshots() })

    await expect(refreshStaleGraphs(supabase, companyIds, REBUILDS, '2026-10-01')).resolves.toEqual({ refreshed: REBUILDS, failed: 0 })

    const missing = Array.from({ length: COMPANIES / 50 }, (_, i) => uuid((i + 1) * 50))
    const oldestFirst: string[] = []
    for (let n = COMPANIES; n >= 1; n--) if (n % 2 === 0 && n % 50 !== 0) oldestFirst.push(uuid(n))
    expect(vi.mocked(buildCompanyGraph).mock.calls.map((call) => call[1])).toEqual([...missing, ...oldestFirst].slice(0, REBUILDS))
    expect(requests.every((r) => r.url.length <= GATEWAY_URL_LIMIT)).toBe(true)
    const reads = requestsTo('arkiv_graph_snapshots').filter((r) => r.method === 'GET')
    expect(reads.map((r) => inListOf(r, 'company_id').length)).toEqual([100, 100, 100, 100, 100])
    expect(unmodelled).toEqual([])
  })
})
