import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Unit-level guard on the two tenant boundaries in provider-client:
 *
 *  1. consumeOAuthState() must consume the OAuth state row with a SINGLE
 *     conditional UPDATE (`used_at IS NULL` + `expires_at > now` in the WHERE
 *     clause). A read-then-write would leave a window where two concurrent
 *     callbacks both see an unused row and both bind tokens.
 *  2. getConsent() must filter on company_id. It runs on the service client,
 *     which bypasses RLS, so that predicate is the only thing stopping an
 *     authenticated user from reading another tenant's consent status.
 */

type QueryResult = { data?: unknown; error?: unknown }
type RecordedCall = { table: string; ops: [string, unknown[]][] }

/**
 * Chainable Supabase stub that RECORDS the predicates it was given. The shared
 * helper in tests/helpers.ts intentionally discards arguments; here the
 * arguments are the thing under test.
 */
function createRecordingSupabase(results: QueryResult[]) {
  const calls: RecordedCall[] = []
  let index = 0

  const from = (table: string) => {
    const result = results[index++] ?? {}
    const record: RecordedCall = { table, ops: [] }
    calls.push(record)

    const chain: unknown = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') {
            return (resolve: (v: unknown) => void) =>
              resolve({ data: result.data ?? null, error: result.error ?? null })
          }
          return (...args: unknown[]) => {
            record.ops.push([String(prop), args])
            return chain
          }
        },
      },
    )
    return chain
  }

  return { supabase: { from: vi.fn(from) }, calls }
}

const findOp = (call: RecordedCall, name: string, firstArg?: unknown) =>
  call.ops.find(([op, args]) => op === name && (firstArg === undefined || args[0] === firstArg))

let serviceClient: { from: ReturnType<typeof vi.fn> }

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => serviceClient,
  createServiceClientNoCookies: () => serviceClient,
  createClient: vi.fn(),
}))

import {
  consumeOAuthState,
  mintHandoff,
  consumeHandoff,
  generateOtc,
  getConsent,
  ConsentNotFoundError,
} from '../lib/provider-client'

function useResults(results: QueryResult[]) {
  const recording = createRecordingSupabase(results)
  serviceClient = recording.supabase
  return recording
}

describe('consumeOAuthState', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('consumes the state row with one conditional UPDATE, not a read then a write', async () => {
    const { calls } = useResults([
      { data: { consent_id: 'consent-1', user_id: 'user-1' } },
      { data: { provider: 'fortnox' } },
    ])

    await consumeOAuthState('state-token')

    const otcCall = calls[0]
    expect(otcCall.table).toBe('provider_otc')
    // The very first thing done to the row is the UPDATE: there is no
    // select-then-decide window for a concurrent replay to slip through.
    expect(otcCall.ops[0][0]).toBe('update')
    expect(findOp(otcCall, 'eq', 'code')?.[1]).toEqual(['code', 'state-token'])
    // Single-use: the row is only claimed while it is still unclaimed.
    expect(findOp(otcCall, 'is', 'used_at')?.[1]).toEqual(['used_at', null])
    // Expiry is enforced in the same statement, not in JavaScript afterwards.
    expect(findOp(otcCall, 'gt', 'expires_at')).toBeDefined()
    expect(findOp(otcCall, 'select', 'consent_id, user_id, origin')).toBeDefined()
    expect(findOp(otcCall, 'is', 'provider_code')?.[1]).toEqual(['provider_code', null])
    expect(findOp(otcCall, 'is', 'provider_error')?.[1]).toEqual(['provider_error', null])
  })

  it('returns the consent and the provider read from the server-side rows', async () => {
    useResults([{ data: { consent_id: 'consent-1', user_id: 'user-1' } }, { data: { provider: 'visma' } }])

    await expect(consumeOAuthState('state-token')).resolves.toEqual({
      consentId: 'consent-1',
      provider: 'visma',
      userId: 'user-1',
      origin: null,
    })
  })

  it('reads the provider from provider_consents, never from the caller', async () => {
    const { calls } = useResults([
      { data: { consent_id: 'consent-1', user_id: 'user-1' } },
      { data: { provider: 'fortnox' } },
    ])

    await consumeOAuthState('state-token')

    expect(calls[1].table).toBe('provider_consents')
    expect(findOp(calls[1], 'eq', 'id')?.[1]).toEqual(['id', 'consent-1'])
  })

  it('returns null for an unknown or forged state token', async () => {
    // No row matched the code: PostgREST answers with no representation.
    useResults([{ data: null }])

    await expect(consumeOAuthState('forged-token')).resolves.toBeNull()
  })

  it('returns null for an expired state token', async () => {
    // The `expires_at > now` predicate excluded the row, so 0 rows updated.
    useResults([{ data: null }])

    await expect(consumeOAuthState('expired-token')).resolves.toBeNull()
  })

  it('returns null on replay: the second consume of the same token loses', async () => {
    useResults([{ data: { consent_id: 'consent-1', user_id: 'user-1' } }, { data: { provider: 'fortnox' } }])
    await expect(consumeOAuthState('one-time-token')).resolves.toEqual({
      consentId: 'consent-1',
      provider: 'fortnox',
      userId: 'user-1',
      origin: null,
    })

    // Replay: used_at is now set, so `is('used_at', null)` matches nothing.
    useResults([{ data: null }])
    await expect(consumeOAuthState('one-time-token')).resolves.toBeNull()
  })

  it('returns userId null for a row minted before the initiator column existed', async () => {
    // The callback refuses these (nobody to bind the completion to); this
    // function only has to report the absence honestly, never invent a user.
    useResults([{ data: { consent_id: 'consent-1', user_id: null } }, { data: { provider: 'fortnox' } }])

    await expect(consumeOAuthState('state-token')).resolves.toEqual({
      consentId: 'consent-1',
      provider: 'fortnox',
      userId: null,
      origin: null,
    })
  })

  it('returns null when the consent behind a valid token is gone', async () => {
    useResults([{ data: { consent_id: 'consent-1', user_id: 'user-1' } }, { data: null }])

    await expect(consumeOAuthState('state-token')).resolves.toBeNull()
  })

  it('returns null when the update itself errors', async () => {
    useResults([{ data: null, error: { message: 'boom' } }])

    await expect(consumeOAuthState('state-token')).resolves.toBeNull()
  })
})

describe('generateOtc', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('defaults the OAuth state lifetime to 10 minutes', async () => {
    // The state only has to survive the round trip to the provider's login
    // page. The old 60-minute default left a phished or leaked state
    // consumable for an hour.
    const { calls } = useResults([{ data: null }])
    const before = Date.now()

    const { expiresAt } = await generateOtc('consent-1', 'user-1', 'https://solbo.accounted.se')

    const after = Date.now()
    expect(calls[0].table).toBe('provider_otc')
    const inserted = findOp(calls[0], 'insert')?.[1][0] as { consent_id: string; user_id: string; expires_at: string }
    expect(inserted.consent_id).toBe('consent-1')
    // The initiator travels with the row: the callback binds the completing
    // session to it, so it must be written here and nowhere else.
    expect(inserted.user_id).toBe('user-1')
    expect(inserted).toHaveProperty('origin', 'https://solbo.accounted.se')

    const tenMinutes = 10 * 60 * 1000
    const expiry = new Date(expiresAt).getTime()
    expect(expiry).toBeGreaterThanOrEqual(before + tenMinutes)
    expect(expiry).toBeLessThanOrEqual(after + tenMinutes)
    expect(new Date(inserted.expires_at).getTime()).toBe(expiry)
  })
})

describe('OAuth handoff storage', () => {
  const origin = 'https://solbo.accounted.se'

  it.each([{ providerCode: 'auth-code' }, { providerError: 'access denied' }])(
    'mints a fresh two-minute handoff holding %j', async (result) => {
      const { calls } = useResults([{}, {}])
      const before = Date.now()
      const first = await mintHandoff('consent-1', 'user-1', origin, result)
      const second = await mintHandoff('consent-1', 'user-1', origin, result)
      expect(first.code).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(first.code).not.toBe(second.code)
      expect(Date.parse(first.expiresAt)).toBeGreaterThanOrEqual(before + 120_000)
      expect(Date.parse(first.expiresAt)).toBeLessThanOrEqual(Date.now() + 120_000)
      expect(findOp(calls[0], 'insert')?.[1][0]).toEqual({
        code: first.code, consent_id: 'consent-1', user_id: 'user-1', origin,
        expires_at: first.expiresAt,
        provider_code: result.providerCode ?? null,
        provider_error: result.providerError ?? null,
      })
    },
  )

  it('deletes atomically, binding origin, expiry, unused status and handoff purpose', async () => {
    const { calls } = useResults([
      { data: { consent_id: 'consent-1', user_id: 'user-1', origin, provider_code: 'stored-code', provider_error: null } },
      { data: { provider: 'visma' } },
    ])
    await expect(consumeHandoff('handoff-token', origin)).resolves.toEqual({
      consentId: 'consent-1', userId: 'user-1', origin, provider: 'visma',
      providerCode: 'stored-code', providerError: null,
    })
    expect(calls[0].ops[0][0]).toBe('delete')
    expect(findOp(calls[0], 'eq', 'code')?.[1]).toEqual(['code', 'handoff-token'])
    expect(findOp(calls[0], 'eq', 'origin')?.[1]).toEqual(['origin', origin])
    expect(findOp(calls[0], 'is', 'used_at')?.[1]).toEqual(['used_at', null])
    expect(findOp(calls[0], 'gt', 'expires_at')).toBeDefined()
    expect(findOp(calls[0], 'or')?.[1]).toEqual(['provider_code.not.is.null,provider_error.not.is.null'])
    expect(calls[1].table).toBe('provider_consents')
    expect(findOp(calls[1], 'eq', 'id')?.[1]).toEqual(['id', 'consent-1'])
  })

  it('rejects unmatched or already consumed handoffs without reading a consent', async () => {
    const { calls } = useResults([{ data: null }])
    await expect(consumeHandoff('spent-token', origin)).resolves.toBeNull()
    expect(calls).toHaveLength(1)
  })

  it('fails closed when the delete errors or the consent no longer exists', async () => {
    useResults([{ error: { message: 'unavailable' } }])
    await expect(consumeHandoff('token', origin)).resolves.toBeNull()
    useResults([{ data: { consent_id: 'deleted-consent' } }, { data: null }])
    await expect(consumeHandoff('token', origin)).resolves.toBeNull()
  })

  it('fails the flow if the handoff cannot be stored', async () => {
    useResults([{ error: { message: 'unavailable' } }])
    await expect(mintHandoff('consent-1', 'user-1', origin, { providerCode: 'code' }))
      .rejects.toThrow('Failed to mint OAuth handoff')
  })
})

describe('getConsent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('filters on the owning company', async () => {
    const { calls } = useResults([
      { data: { id: 'consent-1', name: 'n', provider: 'fortnox', status: 1 } },
    ])

    await getConsent('consent-1', 'company-1')

    expect(calls[0].table).toBe('provider_consents')
    expect(findOp(calls[0], 'eq', 'id')?.[1]).toEqual(['id', 'consent-1'])
    expect(findOp(calls[0], 'eq', 'company_id')?.[1]).toEqual(['company_id', 'company-1'])
  })

  it('throws ConsentNotFoundError when the consent belongs to another company', async () => {
    // The company_id predicate excluded the row: indistinguishable from a
    // consent id that does not exist at all, which is the point.
    useResults([{ data: null }])

    await expect(getConsent('other-tenants-consent', 'company-1')).rejects.toBeInstanceOf(
      ConsentNotFoundError,
    )
  })

  it('leaks no consent state in the not-found error', async () => {
    useResults([{ data: null }])

    const error = await getConsent('other-tenants-consent', 'company-1').catch((e) => e)

    expect(error).toBeInstanceOf(ConsentNotFoundError)
    expect((error as Error).message).toBe('Consent not found')
    expect((error as Error).message).not.toContain('other-tenants-consent')
  })

  it('returns the consent when the caller owns it', async () => {
    useResults([
      {
        data: {
          id: 'consent-1',
          name: 'gnubok-migration-user-1',
          provider: 'fortnox',
          status: 1,
          org_number: '5566778899',
          company_name: 'Test AB',
        },
      },
    ])

    await expect(getConsent('consent-1', 'company-1')).resolves.toEqual({
      id: 'consent-1',
      name: 'gnubok-migration-user-1',
      provider: 'fortnox',
      status: 1,
      orgNumber: '5566778899',
      companyName: 'Test AB',
    })
  })
})
