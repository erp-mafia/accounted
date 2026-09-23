/**
 * Every v1 write runs inside the commit-actor scope.
 *
 * `commitEntry()` reads `getActor()` as its fallback and forwards it to the
 * commit_journal_entry RPC, which stamps `journal_entries.committed_actor_*`
 * and the audit_log COMMIT row. Before this, `runWithActor` had exactly one
 * production call site (the pending-operations commit), so anything reaching
 * the ledger by another route committed anonymously.
 *
 * Measured on production over 90 days: 99.8% of `storno` entries and 100% of
 * `correction` entries had no actor. Those are the two sanctioned rättelse
 * paths under BFL 5 kap. 5 §, which makes them the entries where "who did
 * this" is a legal question and the ones with the least attribution.
 *
 * The test asserts the scope is visible from INSIDE the handler, which is what
 * a helper several frames down (reverseEntry, correctEntry) actually sees.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return { ...actual, validateApiKey: vi.fn(), createServiceClientNoCookies: vi.fn() }
})

vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn().mockReturnValue({}) }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { getActor } from '@/lib/bookkeeping/actor-context'
import { withApiV1 } from '../with-api-v1'
import { ok } from '../response'

const mockValidate = vi.mocked(validateApiKey)
const mockServiceClient = vi.mocked(createServiceClientNoCookies)

const COMPANY = '11111111-1111-4111-8111-111111111111'

/**
 * `companies.list` is the authenticated static route the sibling suite uses.
 * The wrapper resolves the operation against the registry before it reaches
 * the handler, so an invented path 404s and the handler never runs.
 */
const OPERATION = 'companies.list'
const URL_FOR = 'https://x.test/api/v1/companies'

/** Minimal flexible supabase double: every chain resolves to a membership row. */
function makeSupabase() {
  const chain: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) =>
            resolve({ data: { company_id: COMPANY, role: 'owner' }, error: null })
        }
        return () => chain
      },
    },
  )
  return { from: () => chain, rpc: () => chain }
}

function makeRequest(url: string, init?: RequestInit) {
  return new Request(url, {
    headers: { Authorization: 'Bearer gnubok_sk_live_x', ...(init?.headers ?? {}) },
    ...init,
  }) as never
}

/** Next.js 16 hands a static route `{ params: undefined }`. */
function staticParams() {
  return { params: undefined } as never
}

describe('v1 handlers run inside the commit-actor scope', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockServiceClient.mockReturnValue(makeSupabase() as never)
    mockValidate.mockResolvedValue({
      userId: 'user-1',
      companyId: COMPANY,
      scopes: ['companies:read'],
      apiKeyId: 'key-1',
      apiKeyName: 'DueCue automation stager',
      mode: 'live',
    } as Awaited<ReturnType<typeof validateApiKey>>)
  })

  it('exposes an api_key actor to code running inside the handler', async () => {
    let seen: ReturnType<typeof getActor>
    const handler = withApiV1(OPERATION, async (_req, ctx) => {
      // This is what commitEntry() sees, several frames down.
      seen = getActor()
      return ok({ ok: true }, { requestId: ctx.requestId })
    })

    await handler(makeRequest(URL_FOR), staticParams())

    expect(seen).toBeDefined()
    expect(seen?.type).toBe('api_key')
  })

  it('carries the key name through to the actor label', async () => {
    let seen: ReturnType<typeof getActor>
    const handler = withApiV1(OPERATION, async (_req, ctx) => {
      seen = getActor()
      return ok({ ok: true }, { requestId: ctx.requestId })
    })

    await handler(makeRequest(URL_FOR), staticParams())

    expect(seen?.label).toBe('DueCue automation stager')
  })

  it('falls back to a stable label when the key is unnamed', async () => {
    mockValidate.mockResolvedValue({
      userId: 'user-1',
      companyId: COMPANY,
      scopes: ['companies:read'],
      apiKeyId: 'key-1',
      apiKeyName: undefined,
      mode: 'live',
    } as Awaited<ReturnType<typeof validateApiKey>>)

    let seen: ReturnType<typeof getActor>
    const handler = withApiV1(OPERATION, async (_req, ctx) => {
      seen = getActor()
      return ok({ ok: true }, { requestId: ctx.requestId })
    })

    await handler(makeRequest(URL_FOR), staticParams())

    expect(seen?.label).toBe('Unnamed API key')
  })

  it('leaves no actor bound after the request completes', async () => {
    // AsyncLocalStorage must not leak across requests: a later unattributed
    // path must stay unattributed rather than inherit the previous caller.
    const handler = withApiV1(OPERATION, async (_req, ctx) =>
      ok({ ok: true }, { requestId: ctx.requestId }),
    )
    await handler(makeRequest(URL_FOR), staticParams())

    expect(getActor()).toBeUndefined()
  })
})
