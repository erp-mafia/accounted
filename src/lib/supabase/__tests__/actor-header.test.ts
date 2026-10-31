/**
 * The x-accounted-actor header: what every service-role PostgREST request
 * tells the database about who acts, so the audit triggers can name a person
 * a service-role transaction has no session for (migration 20261031120000).
 *
 * The clients here are the production constructors over a real supabase-js,
 * with only the network replaced by a capturing fetch: what reaches the fetch
 * is what PostgREST receives.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runWithActor } from '@/lib/bookkeeping/actor-context-node'
import { ACTOR_HEADER, actorHeaderValue, withActorHeader } from '../actor-header'
import { createServiceRoleClient } from '../service-client'
import { createCompanyScopedClient } from '@/lib/auth/company-scoped-client'

const URL_BASE = 'https://project.supabase.co'
const PERSON = '3f2a9c1e-5b7d-4e8f-9a01-23456789abcd'
const COMPANY = '11111111-1111-4111-8111-111111111111'

interface Captured {
  url: string
  method: string
  headers: Headers
}

/** A fetch that answers every request with an empty success and records what it was sent. */
function capturingFetch(): { fetch: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = []
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({
      url,
      method: init?.method ?? (input instanceof Request ? input.method : 'GET'),
      headers: new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)),
    })
    return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  return { fetch: fn as unknown as typeof fetch, calls }
}

/** The header as the database parses it: JSON, after PostgREST hands it over. */
function parsed(value: string | null): Record<string, unknown> {
  expect(value).not.toBeNull()
  return JSON.parse(value!) as Record<string, unknown>
}

// supabase-js resolves a WebSocket when it builds its realtime client; Node 20
// (CI) has none. Nothing here subscribes, so an inert one is enough.
beforeEach(() => {
  if (!('WebSocket' in globalThis)) vi.stubGlobal('WebSocket', class {})
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('actorHeaderValue', () => {
  it('is null outside any actor scope', () => {
    expect(actorHeaderValue(undefined)).toBeNull()
  })

  it('names the credential and the person it acts for', () => {
    const value = actorHeaderValue({ type: 'mcp_oauth', label: 'Claude (Anthropic)', userId: PERSON })
    expect(parsed(value)).toEqual({ type: 'mcp_oauth', user_id: PERSON, label: 'Claude (Anthropic)' })
  })

  it('names a cron run without a person', () => {
    expect(parsed(actorHeaderValue({ type: 'cron', label: 'invoice.reminders' }))).toEqual({
      type: 'cron',
      label: 'invoice.reminders',
    })
  })

  it('names a person by id only: their label (an e-mail on the approval door) would only repeat them', () => {
    expect(parsed(actorHeaderValue({ type: 'user', label: 'anna@example.se', userId: PERSON }))).toEqual({
      type: 'user',
      user_id: PERSON,
    })
  })

  it('leaves the unattended ceiling out: the database records who acts, not what they may do', () => {
    const value = actorHeaderValue({ type: 'api_key', label: 'Lager', userId: PERSON, unattendedCommitLimit: 5000 })
    expect(parsed(value)).toEqual({ type: 'api_key', user_id: PERSON, label: 'Lager' })
  })

  it('is ASCII, so fetch accepts it, and parses back to the same Swedish text and emoji', () => {
    const label = 'Lagerskript åt Åsa Öberg 🚀'
    const value = actorHeaderValue({ type: 'api_key', label, userId: PERSON })!
    expect(value).toMatch(/^[\x20-\x7e]+$/)
    expect(() => new Headers({ [ACTOR_HEADER]: value })).not.toThrow()
    expect(parsed(value).label).toBe(label)
  })

  it('drops what Postgres would refuse in JSON: control characters and lone surrogates', () => {
    const value = actorHeaderValue({ type: 'api_key', label: 'Rad\u0000ett\nrad två \ud800slut', userId: PERSON })!
    expect(value).not.toMatch(/\\u0000|\\ud800/i)
    expect(parsed(value).label).toBe('Rad ett rad två �slut')
  })

  it('caps the label at 200 characters without splitting one', () => {
    const value = actorHeaderValue({ type: 'api_key', label: `${'a'.repeat(199)}🚀🚀`, userId: PERSON })
    expect(parsed(value).label).toBe(`${'a'.repeat(199)}🚀`)
  })

  it('sends no label for a blank one', () => {
    expect(parsed(actorHeaderValue({ type: 'api_key', label: '  \n ', userId: PERSON }))).toEqual({
      type: 'api_key',
      user_id: PERSON,
    })
  })
})

describe('withActorHeader', () => {
  it('passes a request outside any scope through untouched', async () => {
    const { fetch, calls } = capturingFetch()
    const init = { method: 'PATCH', headers: { apikey: 'k' } }
    await withActorHeader(fetch)(`${URL_BASE}/rest/v1/customers?id=eq.1`, init)
    expect(calls[0]!.headers.has(ACTOR_HEADER)).toBe(false)
    expect(vi.mocked(fetch).mock.calls[0]![1]).toBe(init)
  })

  it('adds the scope actor to a PostgREST request and keeps its other headers', async () => {
    const { fetch, calls } = capturingFetch()
    await runWithActor({ type: 'api_key', label: 'Integration', userId: PERSON }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
      await withActorHeader(fetch)(`${URL_BASE}/rest/v1/rpc/commit_journal_entry`, {
        method: 'POST',
        headers: { apikey: 'k', Authorization: 'Bearer k' },
      })
    })
    expect(parsed(calls[0]!.headers.get(ACTOR_HEADER))).toEqual({ type: 'api_key', user_id: PERSON, label: 'Integration' })
    expect(calls[0]!.headers.get('apikey')).toBe('k')
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer k')
  })

  it('reads the headers of a Request input', async () => {
    const { fetch, calls } = capturingFetch()
    await runWithActor({ type: 'user', userId: PERSON }, () =>
      withActorHeader(fetch)(new Request(`${URL_BASE}/rest/v1/customers`, { method: 'DELETE', headers: { apikey: 'k' } })),
    )
    expect(calls[0]!.headers.get('apikey')).toBe('k')
    expect(parsed(calls[0]!.headers.get(ACTOR_HEADER))).toEqual({ type: 'user', user_id: PERSON })
  })

  it('tells storage, auth and edge functions nothing', async () => {
    const { fetch, calls } = capturingFetch()
    await runWithActor({ type: 'api_key', label: 'Integration', userId: PERSON }, async () => {
      for (const path of ['/storage/v1/object/documents/a.pdf', '/auth/v1/admin/users/1', '/functions/v1/x']) {
        await withActorHeader(fetch)(`${URL_BASE}${path}`, { method: 'POST' })
      }
    })
    expect(calls.map((c) => c.headers.has(ACTOR_HEADER))).toEqual([false, false, false])
  })

  it('sends with the global fetch of the moment when given none, as supabase-js does', async () => {
    const wrapped = withActorHeader()
    const { fetch, calls } = capturingFetch()
    vi.stubGlobal('fetch', fetch)
    await runWithActor({ type: 'cron', label: 'bank.sync' }, () => wrapped(`${URL_BASE}/rest/v1/transactions`))
    expect(parsed(calls[0]!.headers.get(ACTOR_HEADER))).toEqual({ type: 'cron', label: 'bank.sync' })
  })
})

describe('service-role clients name the scope actor on every PostgREST request', () => {
  it('createServiceRoleClient: an update through the API-key / MCP client carries the person and the key', async () => {
    const { fetch, calls } = capturingFetch()
    const supabase = createServiceRoleClient(URL_BASE, 'service-role-key', { global: { fetch } })

    await runWithActor({ type: 'mcp_oauth', label: 'Claude (Anthropic)', userId: PERSON }, async () => {
      await supabase.from('company_settings').update({ bookkeeping_locked_through: '2026-03-31' }).eq('company_id', COMPANY)
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe('PATCH')
    expect(calls[0]!.headers.get('apikey')).toBe('service-role-key')
    expect(parsed(calls[0]!.headers.get(ACTOR_HEADER))).toEqual({
      type: 'mcp_oauth',
      user_id: PERSON,
      label: 'Claude (Anthropic)',
    })
  })

  it('createServiceRoleClient: a client made at module load names whoever acts when it sends', async () => {
    const { fetch, calls } = capturingFetch()
    const shared = createServiceRoleClient(URL_BASE, 'service-role-key', { global: { fetch } })
    const other = '9b1f6a2c-0d3e-4f5a-8b7c-6d5e4f3a2b1c'

    // Awaited inside the scope: a PostgREST builder sends when it is awaited.
    await Promise.all([
      runWithActor({ type: 'api_key', label: 'A', userId: PERSON }, async () => {
        await shared.from('customers').delete().eq('id', 'c1')
      }),
      runWithActor({ type: 'api_key', label: 'B', userId: other }, async () => {
        await shared.from('customers').delete().eq('id', 'c2')
      }),
    ])
    await shared.from('customers').delete().eq('id', 'c3')

    const byRow = Object.fromEntries(
      calls.map((c) => [new URL(c.url).searchParams.get('id'), c.headers.get(ACTOR_HEADER)]),
    )
    expect(parsed(byRow['eq.c1']!).user_id).toBe(PERSON)
    expect(parsed(byRow['eq.c2']!).user_id).toBe(other)
    expect(byRow['eq.c3']).toBeNull()
  })

  it("the invoicer role's scoped client: the signed-in invoicer, and the company filter still applied", async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', URL_BASE)
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key')
    const { fetch, calls } = capturingFetch()
    vi.stubGlobal('fetch', fetch)
    try {
      const scoped = createCompanyScopedClient({ companyId: COMPANY, userId: PERSON })
      // withRouteContext binds this scope for every cookie-session handler.
      await runWithActor({ type: 'user', userId: PERSON }, async () => {
        await scoped.from('invoices').update({ notes: 'x' }).eq('id', 'inv-1')
      })
    } finally {
      vi.unstubAllEnvs()
    }

    expect(calls).toHaveLength(1)
    expect(new URL(calls[0]!.url).searchParams.getAll('company_id')).toEqual([`eq.${COMPANY}`])
    expect(parsed(calls[0]!.headers.get(ACTOR_HEADER))).toEqual({ type: 'user', user_id: PERSON })
  })
})
