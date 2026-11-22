import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  findPartnerClient,
  partnerClientNames,
  partnerClientValue,
  partnerRowMatches,
  partnerSlugOf,
  redirectUriHost,
  type PartnerClientRow,
} from '../oauth-partner-clients'

const EXACT = { host: 'partner.example.com', path: '/oauth/callback', match: 'exact' as const }
const PREFIX = { host: 'gateway.example.com', path: '/upstream', match: 'prefix' as const }

describe('partnerRowMatches', () => {
  it.each([
    ['https://partner.example.com/oauth/callback', true],
    ['https://partner.example.com/oauth/callback/', false],
    ['https://partner.example.com/oauth/callback?next=x', false],
    ['https://partner.example.com/oauth/callback#x', false],
    ['https://partner.example.com/oauth/callback/extra', false],
    ['https://partner.example.com/oauth/other', false],
    ['https://www.partner.example.com/oauth/callback', false],
    ['https://partner.example.com:8443/oauth/callback', false],
    ['https://partner.example.com.evil.com/oauth/callback', false],
    ['http://partner.example.com/oauth/callback', false],
  ])('exact row: %s -> %s', (uri, expected) => {
    expect(partnerRowMatches(uri, EXACT)).toBe(expected)
  })

  it.each([
    ['https://gateway.example.com/upstream/a/callback', true],
    ['https://gateway.example.com/upstream/qhx4a3nq/user/2x3vdl/callback', true],
    ['https://gateway.example.com/upstream/callback/', true],
    ['https://gateway.example.com/upstream/v1.2/cb_x-y', true],
    // Hardened: the bare prefix, dot segments, percent-encoding, query,
    // fragment, empty segments, a backslash, a longer first segment and
    // other hosts never match.
    ['https://gateway.example.com/upstream', false],
    ['https://gateway.example.com/upstream/', false],
    ['https://gateway.example.com/upstream/../evil', false],
    ['https://gateway.example.com/upstream/a/../../evil', false],
    ['https://gateway.example.com/upstream/./a', false],
    ['https://gateway.example.com/upstream/%2e%2e/evil', false],
    ['https://gateway.example.com/upstream/a?next=https://evil.com', false],
    ['https://gateway.example.com/upstream/a#x', false],
    ['https://gateway.example.com/upstream//evil.com', false],
    ['https://gateway.example.com/upstream/a\\evil', false],
    ['https://gateway.example.com/upstreamx/a', false],
    ['https://app.gateway.example.com/upstream/a', false],
    ['https://gateway.example.com@evil.com/upstream/a', false],
  ])('prefix row: %s -> %s', (uri, expected) => {
    expect(partnerRowMatches(uri, PREFIX)).toBe(expected)
  })

  it('treats a prefix written with a trailing slash like one without', () => {
    expect(partnerRowMatches('https://gateway.example.com/upstream/a', { ...PREFIX, path: '/upstream/' })).toBe(true)
    expect(partnerRowMatches('https://gateway.example.com/upstream/', { ...PREFIX, path: '/upstream/' })).toBe(false)
  })

  it('matches an exact root path only as written', () => {
    const root = { host: 'ext.example.org', path: '/', match: 'exact' as const }
    expect(partnerRowMatches('https://ext.example.org/', root)).toBe(true)
    expect(partnerRowMatches('https://ext.example.org', root)).toBe(false)
    expect(partnerRowMatches('https://ext.example.org/a', root)).toBe(false)
  })

  it('matches nothing for a row the table constraints should have refused', () => {
    // A prefix on a whole host, an upper-case or IP host, a path with a dot
    // segment or a query, an unknown match kind.
    expect(partnerRowMatches('https://gateway.example.com/a', { ...PREFIX, path: '/' })).toBe(false)
    expect(partnerRowMatches('https://Gateway.example.com/upstream/a', { ...PREFIX, host: 'Gateway.example.com' })).toBe(false)
    expect(partnerRowMatches('https://10.0.0.1/upstream/a', { ...PREFIX, host: '10.0.0.1' })).toBe(false)
    expect(partnerRowMatches('https://gateway.example.com/../a', { ...EXACT, host: 'gateway.example.com', path: '/../a' })).toBe(false)
    expect(partnerRowMatches('https://gateway.example.com/a?x', { ...EXACT, host: 'gateway.example.com', path: '/a?x' })).toBe(false)
    expect(partnerRowMatches('https://gateway.example.com/upstream/a', { ...PREFIX, match: 'regex' as never })).toBe(false)
  })
})

describe('redirectUriHost', () => {
  it.each([
    ['https://partner.example.com/cb', 'partner.example.com'],
    ['https://partner.example.com', 'partner.example.com'],
    ['https://partner.example.com:443/cb', null],
    ['https://user@partner.example.com/cb', null],
    ['https://Partner.example.com/cb', null],
    ['http://partner.example.com/cb', null],
    ['cursor://anysphere.cursor-mcp/oauth/callback', null],
    ['https://partner.example.com?x=1', null],
  ])('%s -> %s', (uri, expected) => {
    expect(redirectUriHost(uri)).toBe(expected)
  })
})

describe('partner client values', () => {
  it('round-trips a slug through api_keys.client', () => {
    expect(partnerClientValue('acme')).toBe('partner:acme')
    expect(partnerSlugOf('partner:acme')).toBe('acme')
  })

  it('reads no slug from other clients or malformed values', () => {
    for (const value of ['claude', 'registered:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'partner:', 'partner:Acme', 'partner:a', 'partner:acme x', null, undefined]) {
      expect(partnerSlugOf(value)).toBeNull()
    }
  })
})

type Row = Partial<PartnerClientRow> & { revoked_at?: string | null }

function fakeClient(rows: Row[], fail = false) {
  const calls: { method: string; args: unknown[] }[] = []
  const from = vi.fn(() => {
    const filters: ((row: Row) => boolean)[] = []
    const chain: Record<string, unknown> = {}
    const record = (method: string) => (...args: unknown[]) => {
      calls.push({ method, args })
      return chain
    }
    chain.select = record('select')
    chain.order = record('order')
    chain.limit = record('limit')
    chain.eq = (col: keyof Row, val: unknown) => {
      calls.push({ method: 'eq', args: [col, val] })
      filters.push((row) => row[col] === val)
      return chain
    }
    chain.is = (col: keyof Row, val: unknown) => {
      calls.push({ method: 'is', args: [col, val] })
      filters.push((row) => (val === null ? row[col] == null : row[col] === val))
      return chain
    }
    chain.in = (col: keyof Row, vals: unknown[]) => {
      calls.push({ method: 'in', args: [col, vals] })
      filters.push((row) => vals.includes(row[col]))
      return chain
    }
    chain.then = (resolve: (v: unknown) => void) =>
      resolve(fail ? { data: null, error: { message: 'db down' } } : { data: rows.filter((row) => filters.every((f) => f(row))), error: null })
    return chain
  })
  return { client: { from } as unknown as SupabaseClient, from, calls }
}

const ROWS: Row[] = [
  { id: 'p-1', slug: 'gateway', name: 'Gateway', host: 'gateway.example.com', path: '/upstream', match: 'prefix', created_at: '2026-11-19T10:00:00Z', revoked_at: null },
  { id: 'p-2', slug: 'gateway_special', name: 'Gateway Special', host: 'gateway.example.com', path: '/upstream/special/callback', match: 'exact', created_at: '2026-11-19T11:00:00Z', revoked_at: null },
  { id: 'p-3', slug: 'gateway_deep', name: 'Gateway Deep', host: 'gateway.example.com', path: '/upstream/deep', match: 'prefix', created_at: '2026-11-19T12:00:00Z', revoked_at: null },
  { id: 'p-4', slug: 'old', name: 'Old Partner', host: 'old.example.com', path: '/cb', match: 'exact', created_at: '2026-01-01T00:00:00Z', revoked_at: '2026-06-01T00:00:00Z' },
  { id: 'p-5', slug: 'old', name: 'Old Partner AB', host: 'old2.example.com', path: '/cb', match: 'exact', created_at: '2026-02-01T00:00:00Z', revoked_at: '2026-06-01T00:00:00Z' },
]

describe('findPartnerClient', () => {
  it('reads only the active rows of the URI host and returns the matching partner', async () => {
    const { client, calls } = fakeClient(ROWS)
    expect(await findPartnerClient('https://gateway.example.com/upstream/a/callback', client)).toEqual({ id: 'p-1', slug: 'gateway', name: 'Gateway' })
    expect(calls).toContainEqual({ method: 'eq', args: ['host', 'gateway.example.com'] })
    expect(calls).toContainEqual({ method: 'is', args: ['revoked_at', null] })
    expect(calls.some((c) => c.method === 'limit')).toBe(true)
  })

  it('prefers an exact row, then the longer prefix', async () => {
    const { client } = fakeClient(ROWS)
    expect((await findPartnerClient('https://gateway.example.com/upstream/special/callback', client))?.slug).toBe('gateway_special')
    expect((await findPartnerClient('https://gateway.example.com/upstream/deep/x', client))?.slug).toBe('gateway_deep')
  })

  it('finds nothing for a revoked row, another host, or a URI no row covers, and skips the read for a host it cannot use', async () => {
    const { client, from } = fakeClient(ROWS)
    expect(await findPartnerClient('https://old.example.com/cb', client)).toBeNull()
    expect(await findPartnerClient('https://gateway.example.com/other', client)).toBeNull()
    expect(await findPartnerClient('https://unknown.example.com/upstream/a', client)).toBeNull()
    const reads = from.mock.calls.length
    expect(await findPartnerClient('https://gateway.example.com:443/upstream/a', client)).toBeNull()
    expect(await findPartnerClient('http://gateway.example.com/upstream/a', client)).toBeNull()
    expect(from.mock.calls.length).toBe(reads)
  })

  it('throws when the table cannot be read, so the caller decides', async () => {
    const { client } = fakeClient(ROWS, true)
    await expect(findPartnerClient('https://gateway.example.com/upstream/a', client)).rejects.toBeTruthy()
  })
})

describe('partnerClientNames', () => {
  it('names each slug by its newest row, revoked rows included', async () => {
    // The fake returns rows in table order; the query asks newest first.
    const { client, calls } = fakeClient([...ROWS].reverse())
    const names = await partnerClientNames(client, ['old', 'gateway', 'old', 'missing'])
    expect(names).toEqual(new Map([['old', 'Old Partner AB'], ['gateway', 'Gateway']]))
    expect(calls).toContainEqual({ method: 'in', args: ['slug', ['old', 'gateway', 'missing']] })
  })

  it('reads nothing for no slugs and answers empty on a failed read', async () => {
    const { client, from } = fakeClient(ROWS)
    expect(await partnerClientNames(client, [])).toEqual(new Map())
    expect(from).not.toHaveBeenCalled()
    expect(await partnerClientNames(fakeClient(ROWS, true).client, ['gateway'])).toEqual(new Map())
  })
})
