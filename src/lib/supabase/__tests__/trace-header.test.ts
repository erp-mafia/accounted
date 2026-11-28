/**
 * The x-accounted-trace header: what every server client's PostgREST request
 * tells the database about the request it belongs to, so the audit log can
 * keep the trace id on each row (migration 20261128110000).
 *
 * The clients here are the production constructors over a real supabase-js,
 * with only the network replaced by a capturing fetch: what reaches the fetch
 * is what PostgREST receives.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runWithTrace } from '@/lib/observability/trace-context-node'
import { runWithActor } from '@/lib/bookkeeping/actor-context-node'
import { ACTOR_HEADER } from '../actor-header'
import { TRACE_HEADER, withTraceHeader } from '../trace-header'
import { createServiceRoleClient } from '../service-client'

const URL_BASE = 'https://project.supabase.co'
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736'
const OTHER_TRACE = '0af7651916cd43dd8448eb211c80319c'
const PERSON = '3f2a9c1e-5b7d-4e8f-9a01-23456789abcd'

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

// supabase-js resolves a WebSocket when it builds its realtime client; Node 20
// (CI) has none. Nothing here subscribes, so an inert one is enough.
beforeEach(() => {
  if (!('WebSocket' in globalThis)) vi.stubGlobal('WebSocket', class {})
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('withTraceHeader', () => {
  it('passes a request outside any trace scope through untouched', async () => {
    const { fetch, calls } = capturingFetch()
    const init = { method: 'PATCH', headers: { apikey: 'k' } }
    await withTraceHeader(fetch)(`${URL_BASE}/rest/v1/customers?id=eq.1`, init)
    expect(calls[0]!.headers.has(TRACE_HEADER)).toBe(false)
    expect(vi.mocked(fetch).mock.calls[0]![1]).toBe(init)
  })

  it('adds the scope trace id to a PostgREST request and keeps its other headers', async () => {
    const { fetch, calls } = capturingFetch()
    await runWithTrace(TRACE, async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
      await withTraceHeader(fetch)(`${URL_BASE}/rest/v1/rpc/commit_journal_entry`, {
        method: 'POST',
        headers: { apikey: 'k', Authorization: 'Bearer k' },
      })
    })
    expect(calls[0]!.headers.get(TRACE_HEADER)).toBe(TRACE)
    expect(calls[0]!.headers.get('apikey')).toBe('k')
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer k')
  })

  it('reads the headers of a Request input', async () => {
    const { fetch, calls } = capturingFetch()
    await runWithTrace(TRACE, () =>
      withTraceHeader(fetch)(new Request(`${URL_BASE}/rest/v1/customers`, { method: 'DELETE', headers: { apikey: 'k' } })),
    )
    expect(calls[0]!.headers.get('apikey')).toBe('k')
    expect(calls[0]!.headers.get(TRACE_HEADER)).toBe(TRACE)
  })

  it('tells storage, auth and edge functions nothing', async () => {
    const { fetch, calls } = capturingFetch()
    await runWithTrace(TRACE, async () => {
      for (const path of ['/storage/v1/object/documents/a.pdf', '/auth/v1/admin/users/1', '/functions/v1/x']) {
        await withTraceHeader(fetch)(`${URL_BASE}${path}`, { method: 'POST' })
      }
    })
    expect(calls.map((c) => c.headers.has(TRACE_HEADER))).toEqual([false, false, false])
  })

  it('sends nothing for a scope id that is not a trace id', async () => {
    const { fetch, calls } = capturingFetch()
    await runWithTrace('4BF92F3577B34DA6A3CE929D0E0E4736', () => withTraceHeader(fetch)(`${URL_BASE}/rest/v1/customers`))
    expect(calls[0]!.headers.has(TRACE_HEADER)).toBe(false)
  })

  it('sends with the global fetch of the moment when given none, as supabase-js does', async () => {
    const wrapped = withTraceHeader()
    const { fetch, calls } = capturingFetch()
    vi.stubGlobal('fetch', fetch)
    await runWithTrace(TRACE, () => wrapped(`${URL_BASE}/rest/v1/transactions`))
    expect(calls[0]!.headers.get(TRACE_HEADER)).toBe(TRACE)
  })
})

describe('service-role clients name the scope trace on every PostgREST request', () => {
  it('createServiceRoleClient: carries the trace beside the actor', async () => {
    const { fetch, calls } = capturingFetch()
    const supabase = createServiceRoleClient(URL_BASE, 'service-role-key', { global: { fetch } })

    await runWithTrace(TRACE, () =>
      runWithActor({ type: 'api_key', label: 'Integration', userId: PERSON }, async () => {
        await supabase.from('categorization_templates').update({ debit_account: '6540' }).eq('id', 't1')
      }),
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]!.headers.get(TRACE_HEADER)).toBe(TRACE)
    expect(calls[0]!.headers.has(ACTOR_HEADER)).toBe(true)
    expect(calls[0]!.headers.get('apikey')).toBe('service-role-key')
  })

  it('createServiceRoleClient: a client made at module load names the trace of whoever sends', async () => {
    const { fetch, calls } = capturingFetch()
    const shared = createServiceRoleClient(URL_BASE, 'service-role-key', { global: { fetch } })

    // Awaited inside the scope: a PostgREST builder sends when it is awaited.
    await Promise.all([
      runWithTrace(TRACE, async () => {
        await shared.from('customers').delete().eq('id', 'c1')
      }),
      runWithTrace(OTHER_TRACE, async () => {
        await shared.from('customers').delete().eq('id', 'c2')
      }),
    ])
    await shared.from('customers').delete().eq('id', 'c3')

    const byRow = Object.fromEntries(calls.map((c) => [new URL(c.url).searchParams.get('id'), c.headers.get(TRACE_HEADER)]))
    expect(byRow).toEqual({ 'eq.c1': TRACE, 'eq.c2': OTHER_TRACE, 'eq.c3': null })
  })
})
