import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { connectorGrantExpiry, syncConnectorEntitlements, CONNECTOR_GRANT_TTL_MS } from '../sync'

/**
 * A purpose-built Supabase mock: `companies` answers the paginated read,
 * `capability_grants` records upserts and deletes (with their filters), so the
 * grant arithmetic can be asserted exactly.
 */
function makeSupabase(companyIds: string[]) {
  const upserts: Array<{ rows: unknown[]; opts: unknown }> = []
  const deletes: Array<{ filters: Array<[string, ...unknown[]]> }> = []
  let deleteCount = 0

  const grantsChain = () => {
    const deleteRecord: { filters: Array<[string, ...unknown[]]> } = { filters: [] }
    const chain: Record<string, unknown> = {}
    chain.upsert = (rows: unknown[], opts: unknown) => {
      upserts.push({ rows, opts })
      return Promise.resolve({ error: null })
    }
    chain.delete = () => {
      deletes.push(deleteRecord)
      const dchain: Record<string, unknown> = {
        eq: (...a: unknown[]) => {
          deleteRecord.filters.push(['eq', ...a])
          return dchain
        },
        not: (...a: unknown[]) => {
          deleteRecord.filters.push(['not', ...a])
          return dchain
        },
        then: (resolve: (v: unknown) => void) => resolve({ error: null, count: deleteCount }),
      }
      return dchain
    }
    return chain
  }
  const companiesChain = () => {
    let rangeFrom = 0
    const chain: Record<string, unknown> = {
      select: () => chain,
      is: () => chain,
      order: () => chain,
      range: (from: number) => {
        rangeFrom = from
        return chain
      },
      then: (resolve: (v: unknown) => void) =>
        resolve({ data: companyIds.slice(rangeFrom, rangeFrom + 1000).map((id) => ({ id })), error: null }),
    }
    return chain
  }
  const supabase = {
    from: (table: string) => (table === 'companies' ? companiesChain() : grantsChain()),
  } as unknown as SupabaseClient
  return {
    supabase,
    upserts,
    deletes,
    setDeleteCount: (n: number) => {
      deleteCount = n
    },
  }
}

const CONFIG = { key: 'gnubok_ck_test', baseUrl: 'https://app.gnubok.se' }
const NOW = new Date('2026-08-20T12:00:00.000Z')
const C1 = '11111111-1111-4111-8111-111111111111'
const C2 = '22222222-2222-4222-8222-222222222222'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

beforeEach(() => vi.clearAllMocks())

describe('connectorGrantExpiry', () => {
  it('is now + 72h without a period end, and the earlier of that and period_end + 3d otherwise', () => {
    expect(connectorGrantExpiry(NOW, null)).toBe(new Date(NOW.getTime() + CONNECTOR_GRANT_TTL_MS).toISOString())
    // period ends in 10 days: 72h wins
    expect(connectorGrantExpiry(NOW, '2026-08-30T00:00:00.000Z')).toBe('2026-08-23T12:00:00.000Z')
    // period ended yesterday: period_end + 3d wins (grace), earlier than 72h
    expect(connectorGrantExpiry(NOW, '2026-08-19T12:00:00.000Z')).toBe('2026-08-22T12:00:00.000Z')
  })
})

describe('syncConnectorEntitlements', () => {
  it('is a no-op without a key', async () => {
    const { supabase, upserts } = makeSupabase([C1])
    const fetchImpl = vi.fn()
    const result = await syncConnectorEntitlements(supabase, { config: null, fetchImpl })
    expect(result.outcome).toBe('not_configured')
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(upserts).toHaveLength(0)
  })

  it('reports the active company count with the key and writes one connector grant per company and scope', async () => {
    const { supabase, upserts, deletes } = makeSupabase([C1, C2])
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        data: {
          status: 'active',
          scopes: ['bank_sync', 'skatteverket', 'not_a_connector_scope'],
          current_period_end: '2027-01-01T00:00:00.000Z',
          org_number: '5561234567',
          instance_url: 'https://bokforing.example.se',
          server_time: NOW.toISOString(),
        },
      }),
    )
    const result = await syncConnectorEntitlements(supabase, {
      config: CONFIG,
      fetchImpl,
      now: NOW,
      instanceUrl: 'https://bokforing.example.se',
      appVersion: '1.0.0',
    })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://app.gnubok.se/api/connect/entitlements')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer gnubok_ck_test')
    expect(JSON.parse(String(init.body))).toEqual({
      active_company_count: 2,
      instance_url: 'https://bokforing.example.se',
      app_version: '1.0.0',
    })

    expect(result).toMatchObject({ outcome: 'synced', companies: 2, grantsUpserted: 4, scopes: ['bank_sync', 'skatteverket'] })
    expect(result.expiresAt).toBe('2026-08-23T12:00:00.000Z')
    expect(upserts).toHaveLength(1)
    expect(upserts[0].opts).toEqual({ onConflict: 'company_id,team_id,capability_key,source' })
    expect(upserts[0].rows).toEqual(
      expect.arrayContaining([
        { company_id: C1, team_id: null, capability_key: 'bank_sync', source: 'connector', expires_at: '2026-08-23T12:00:00.000Z' },
        { company_id: C2, team_id: null, capability_key: 'skatteverket', source: 'connector', expires_at: '2026-08-23T12:00:00.000Z' },
      ]),
    )
    // scopes no longer covered are dropped: delete source=connector NOT IN (kept)
    expect(deletes).toHaveLength(1)
    expect(deletes[0].filters).toEqual([
      ['eq', 'source', 'connector'],
      ['not', 'capability_key', 'in', '(bank_sync,skatteverket)'],
    ])
  })

  it('removes every connector grant on a 401/403 carrying a connector rejection code (freeze-and-retain)', async () => {
    for (const [status, code] of [[401, 'CONNECTOR_KEY_INVALID'], [403, 'CONNECTOR_KEY_SUSPENDED'], [401, 'CONNECTOR_KEY_MISSING']] as const) {
      const { supabase, upserts, deletes, setDeleteCount } = makeSupabase([C1])
      setDeleteCount(4)
      const result = await syncConnectorEntitlements(supabase, {
        config: CONFIG,
        fetchImpl: vi.fn().mockResolvedValue(jsonResponse(status, { error: 'rejected', code })),
        now: NOW,
      })
      expect(result).toMatchObject({ outcome: 'revoked', httpStatus: status, grantsDeleted: 4 })
      expect(upserts).toHaveLength(0)
      expect(deletes[0].filters).toEqual([['eq', 'source', 'connector']])
    }
  })

  it('keeps every grant on a 401/403 WITHOUT a connector rejection code (WAF challenge, edge protection, egress proxy)', async () => {
    // A bare-status 401/403 can come from layers where the hosted app never
    // ran. Only the hosted route's own rejection code proves revocation;
    // anything else must not destroy the 72h offline cache.
    const bodies: Array<[number, () => Response]> = [
      [403, () => new Response('<html>Attack challenge</html>', { status: 403, headers: { 'content-type': 'text/html' } })],
      [401, () => new Response('Authentication Required', { status: 401 })],
      [401, () => jsonResponse(401, { error: 'edge auth', code: 'SOME_OTHER_CODE' })],
      [403, () => jsonResponse(403, { message: 'forbidden by proxy' })],
    ]
    for (const [status, make] of bodies) {
      const { supabase, upserts, deletes } = makeSupabase([C1])
      const result = await syncConnectorEntitlements(supabase, {
        config: CONFIG,
        fetchImpl: vi.fn().mockResolvedValue(make()),
        now: NOW,
      })
      expect(result).toMatchObject({ outcome: 'server_error', httpStatus: status, grantsDeleted: 0 })
      expect(upserts).toHaveLength(0)
      expect(deletes).toHaveLength(0)
    }
  })

  it('removes every connector grant when the key is not active', async () => {
    const { supabase, deletes } = makeSupabase([C1])
    const result = await syncConnectorEntitlements(supabase, {
      config: CONFIG,
      fetchImpl: vi.fn().mockResolvedValue(
        jsonResponse(200, { data: { status: 'suspended', scopes: ['bank_sync'], current_period_end: null, org_number: 'x', instance_url: null, server_time: 'x' } }),
      ),
      now: NOW,
    })
    expect(result).toMatchObject({ outcome: 'revoked', status: 'suspended' })
    expect(deletes).toHaveLength(1)
  })

  // The offline grace: a hosted outage must not touch the grants.
  it('leaves grants alone on a network error, a 5xx and a 429', async () => {
    const { supabase: s1, upserts: u1, deletes: d1 } = makeSupabase([C1])
    const r1 = await syncConnectorEntitlements(s1, { config: CONFIG, fetchImpl: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')), now: NOW })
    expect(r1.outcome).toBe('network_error')
    expect(u1).toHaveLength(0)
    expect(d1).toHaveLength(0)

    for (const status of [500, 503, 429]) {
      const { supabase, upserts, deletes } = makeSupabase([C1])
      const r = await syncConnectorEntitlements(supabase, { config: CONFIG, fetchImpl: vi.fn().mockResolvedValue(jsonResponse(status, {})), now: NOW })
      expect(r).toMatchObject({ outcome: 'server_error', httpStatus: status })
      expect(upserts).toHaveLength(0)
      expect(deletes).toHaveLength(0)
    }
  })

  it('treats an unreadable 200 payload as a server error, not a revocation', async () => {
    const { supabase, deletes } = makeSupabase([C1])
    const r = await syncConnectorEntitlements(supabase, { config: CONFIG, fetchImpl: vi.fn().mockResolvedValue(jsonResponse(200, { data: { nope: true } })), now: NOW })
    expect(r.outcome).toBe('server_error')
    expect(deletes).toHaveLength(0)
  })

  it('with an empty scope list writes nothing and drops every connector grant', async () => {
    const { supabase, upserts, deletes } = makeSupabase([C1])
    const r = await syncConnectorEntitlements(supabase, {
      config: CONFIG,
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse(200, { data: { status: 'active', scopes: [], current_period_end: null, org_number: 'x', instance_url: null, server_time: 'x' } })),
      now: NOW,
    })
    expect(r).toMatchObject({ outcome: 'synced', grantsUpserted: 0 })
    expect(upserts).toHaveLength(0)
    expect(deletes[0].filters).toEqual([['eq', 'source', 'connector']])
  })
})
