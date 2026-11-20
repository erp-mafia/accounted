import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { encryptHandoffValue } from '../lib/handoff-crypto'

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
  peekOAuthState,
  moveOpenLogins,
  consentHoldsTokens,
  oauthStateRejectionReason,
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
      { data: { provider: 'fortnox', company_id: 'company-1' } },
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
    useResults([{ data: { consent_id: 'consent-1', user_id: 'user-1' } }, { data: { provider: 'visma', company_id: 'company-1' } }])

    await expect(consumeOAuthState('state-token')).resolves.toEqual({
      consentId: 'consent-1',
      provider: 'visma',
      companyId: 'company-1',
      userId: 'user-1',
      origin: null,
    })
  })

  it('reads the provider from provider_consents, never from the caller', async () => {
    const { calls } = useResults([
      { data: { consent_id: 'consent-1', user_id: 'user-1' } },
      { data: { provider: 'fortnox', company_id: 'company-1' } },
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
    useResults([{ data: { consent_id: 'consent-1', user_id: 'user-1' } }, { data: { provider: 'fortnox', company_id: 'company-1' } }])
    await expect(consumeOAuthState('one-time-token')).resolves.toEqual({
      consentId: 'consent-1',
      provider: 'fortnox',
      companyId: 'company-1',
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
    useResults([{ data: { consent_id: 'consent-1', user_id: null } }, { data: { provider: 'fortnox', company_id: 'company-1' } }])

    await expect(consumeOAuthState('state-token')).resolves.toEqual({
      consentId: 'consent-1',
      provider: 'fortnox',
      companyId: 'company-1',
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

/**
 * A cancelled provider login (an error, no code) reads the state and leaves it
 * unspent, so a second delivery of the cancel, or an approval after going Back
 * at the provider, still finds it. The read must see exactly the rows a
 * consume would have taken.
 */
describe('peekOAuthState', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  /** Every predicate on the provider_otc statement, without its timestamps. */
  const predicates = (call: RecordedCall) =>
    call.ops
      .filter(([op]) => op === 'eq' || op === 'is' || op === 'gt')
      .map(([op, args]) => (op === 'gt' ? [op, args[0]] : [op, ...args]))

  it('reads the state row with a SELECT and never writes to it', async () => {
    const { calls } = useResults([
      { data: { consent_id: 'consent-1', user_id: 'user-1' } },
      { data: { provider: 'fortnox', company_id: 'company-1' } },
    ])

    await peekOAuthState('state-token')

    expect(calls[0].table).toBe('provider_otc')
    expect(calls[0].ops[0]).toEqual(['select', ['consent_id, user_id, origin']])
    for (const call of calls) {
      for (const write of ['update', 'delete', 'insert', 'upsert']) {
        expect(findOp(call, write)).toBeUndefined()
      }
    }
  })

  it('sees exactly the rows consumeOAuthState would take: unused, not a handoff, unexpired', async () => {
    const peeked = useResults([{ data: null }])
    await peekOAuthState('state-token')
    const consumed = useResults([{ data: null }])
    await consumeOAuthState('state-token')

    expect(predicates(peeked.calls[0])).toEqual([
      ['eq', 'code', 'state-token'],
      ['is', 'used_at', null],
      ['is', 'provider_code', null],
      ['is', 'provider_error', null],
      ['gt', 'expires_at'],
    ])
    expect(predicates(peeked.calls[0])).toEqual(predicates(consumed.calls[0]))
  })

  it('resolves the same flow a consume would, from the server-side rows', async () => {
    const { calls } = useResults([
      { data: { consent_id: 'consent-1', user_id: 'user-1', origin: 'https://brand-d.accounted.se' } },
      { data: { provider: 'visma', company_id: 'company-1' } },
    ])

    await expect(peekOAuthState('state-token')).resolves.toEqual({
      consentId: 'consent-1',
      provider: 'visma',
      companyId: 'company-1',
      userId: 'user-1',
      origin: 'https://brand-d.accounted.se',
    })
    expect(calls[1].table).toBe('provider_consents')
    expect(findOp(calls[1], 'eq', 'id')?.[1]).toEqual(['id', 'consent-1'])
  })

  it('still resolves on a second read: a peek spends nothing', async () => {
    const rows = [
      { data: { consent_id: 'consent-1', user_id: 'user-1' } },
      { data: { provider: 'fortnox', company_id: 'company-1' } },
    ]
    useResults([...rows, ...rows])

    const first = await peekOAuthState('state-token')
    const second = await peekOAuthState('state-token')

    expect(first).not.toBeNull()
    expect(second).toEqual(first)
  })

  // A used, expired, handoff or unknown row is excluded by the statement's
  // own predicates (pinned in the predicate test above), so each of them
  // reaches this code as the same thing: no row, and no consent is read.
  it('returns null when the statement matches no row', async () => {
    const { calls } = useResults([{ data: null }])

    await expect(peekOAuthState('dead-token')).resolves.toBeNull()
    expect(calls).toHaveLength(1)
  })

  it('returns null when the consent behind a live token is gone', async () => {
    useResults([{ data: { consent_id: 'consent-1', user_id: 'user-1' } }, { data: null }])

    await expect(peekOAuthState('state-token')).resolves.toBeNull()
  })

  it('returns null when the read itself errors', async () => {
    useResults([{ data: null, error: { message: 'boom' } }])

    await expect(peekOAuthState('state-token')).resolves.toBeNull()
  })
})

/**
 * The reason goes to the server log only (the callback answers every dead
 * state with one sentence), so that a rejected callback can be sorted into
 * replay or expiry after its row is purged.
 */
describe('moveOpenLogins', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const predicates = (call: RecordedCall) =>
    call.ops
      .filter(([op]) => op === 'in' || op === 'is' || op === 'gt')
      .map(([op, args]) => (op === 'gt' ? [op, args[0]] : [op, ...args]))

  it('moves only the states a callback could still use, under the same predicates as a peek', async () => {
    const { calls } = useResults([{ data: [{ code: 'state-1' }] }])

    await expect(moveOpenLogins(['consent-1', 'consent-2'], 'consent-new')).resolves.toBe(1)

    expect(calls[0].table).toBe('provider_otc')
    // Only the consent the state resolves to changes: initiator and origin stay.
    expect(findOp(calls[0], 'update')?.[1]).toEqual([{ consent_id: 'consent-new' }])
    expect(predicates(calls[0])).toEqual([
      ['in', 'consent_id', ['consent-1', 'consent-2']],
      ['is', 'used_at', null],
      ['is', 'provider_code', null],
      ['is', 'provider_error', null],
      ['gt', 'expires_at'],
    ])
    for (const write of ['delete', 'insert', 'upsert']) expect(findOp(calls[0], write)).toBeUndefined()
  })

  it('touches nothing for no earlier attempts', async () => {
    const { calls } = useResults([])
    await expect(moveOpenLogins([], 'consent-new')).resolves.toBe(0)
    expect(calls).toHaveLength(0)
  })

  it('moves nothing when the update fails: /connect then cleans up as before', async () => {
    useResults([{ data: null, error: { message: 'boom' } }])
    await expect(moveOpenLogins(['consent-1'], 'consent-new')).resolves.toBe(0)
  })
})

describe('consentHoldsTokens', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reads the token row of the consent alone', async () => {
    const { calls } = useResults([{ data: [{ consent_id: 'consent-1' }] }])
    await expect(consentHoldsTokens('consent-1')).resolves.toBe(true)
    expect(calls[0].table).toBe('provider_consent_tokens')
    expect(findOp(calls[0], 'eq', 'consent_id')?.[1]).toEqual(['consent_id', 'consent-1'])
  })

  it('is false without a token row, and when the read fails', async () => {
    useResults([{ data: [] }])
    await expect(consentHoldsTokens('consent-1')).resolves.toBe(false)
    useResults([{ data: null, error: { message: 'boom' } }])
    await expect(consentHoldsTokens('consent-1')).resolves.toBe(false)
  })
})

describe('oauthStateRejectionReason', () => {
  const past = () => new Date(Date.now() - 60_000).toISOString()
  const future = () => new Date(Date.now() + 60_000).toISOString()
  const stateRow = (overrides: Record<string, unknown>) => ({
    used_at: null, expires_at: future(), provider_code: null, provider_error: null, ...overrides,
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each([
    ['unknown', 'no row has this code', null],
    ['used', 'a code callback already spent it', stateRow({ used_at: past() })],
    ['used', 'it was spent and has since expired', stateRow({ used_at: past(), expires_at: past() })],
    ['expired', 'it outlived its lifetime unused', stateRow({ expires_at: past() })],
    ['handoff', 'it is a live handoff holding a code', stateRow({ provider_code: 'v1:sealed' })],
    ['handoff', 'it is a live handoff holding an error', stateRow({ provider_error: 'v1:sealed' })],
    ['unknown', 'the row is a live state after all', stateRow({})],
  ])('answers %s when %s', async (reason, _why, data) => {
    useResults([{ data }])

    await expect(oauthStateRejectionReason('dead-token')).resolves.toBe(reason)
  })

  it('looks the row up by code alone, once, and writes nothing', async () => {
    const { calls } = useResults([{ data: stateRow({ used_at: past() }) }])

    await oauthStateRejectionReason('dead-token')

    expect(calls).toHaveLength(1)
    expect(calls[0].table).toBe('provider_otc')
    expect(calls[0].ops.map(([op]) => op)).toEqual(['select', 'eq', 'maybeSingle'])
    expect(findOp(calls[0], 'eq', 'code')?.[1]).toEqual(['code', 'dead-token'])
  })

  it('never throws: a failed lookup is unknown', async () => {
    useResults([{ data: null, error: { message: 'boom' } }])
    await expect(oauthStateRejectionReason('dead-token')).resolves.toBe('unknown')

    serviceClient = { from: vi.fn((): unknown => { throw new Error('unavailable') }) }
    await expect(oauthStateRejectionReason('dead-token')).resolves.toBe('unknown')
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

    const { expiresAt } = await generateOtc('consent-1', 'user-1', 'https://brand-d.accounted.se')

    const after = Date.now()
    expect(calls[0].table).toBe('provider_otc')
    const inserted = findOp(calls[0], 'insert')?.[1][0] as { consent_id: string; user_id: string; expires_at: string }
    expect(inserted.consent_id).toBe('consent-1')
    // The initiator travels with the row: the callback binds the completing
    // session to it, so it must be written here and nowhere else.
    expect(inserted.user_id).toBe('user-1')
    expect(inserted).toHaveProperty('origin', 'https://brand-d.accounted.se')

    const tenMinutes = 10 * 60 * 1000
    const expiry = new Date(expiresAt).getTime()
    expect(expiry).toBeGreaterThanOrEqual(before + tenMinutes)
    expect(expiry).toBeLessThanOrEqual(after + tenMinutes)
    expect(new Date(inserted.expires_at).getTime()).toBe(expiry)
  })
})

describe('OAuth handoff storage', () => {
  const origin = 'https://brand-d.accounted.se'

  beforeEach(() => {
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-only-handoff-encryption-key')
  })

  afterEach(() => vi.unstubAllEnvs())

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
      const inserted = findOp(calls[0], 'insert')?.[1][0] as Record<string, unknown>
      expect(inserted).toEqual({
        code: first.code, consent_id: 'consent-1', user_id: 'user-1', origin,
        expires_at: first.expiresAt,
        provider_code: result.providerCode ? expect.stringMatching(/^v1:/) : null,
        provider_error: result.providerError ? expect.stringMatching(/^v1:/) : null,
      })
      expect(JSON.stringify(inserted)).not.toContain(result.providerCode ?? result.providerError)
      useResults([{ data: inserted }, { data: { provider: 'fortnox', company_id: 'company-1' } }])
      await expect(consumeHandoff(first.code, origin)).resolves.toMatchObject({
        providerCode: result.providerCode ?? null, providerError: result.providerError ?? null,
      })
    },
  )

  it('deletes atomically, binding origin, expiry, unused status and handoff purpose', async () => {
    const { calls } = useResults([
      { data: {
        consent_id: 'consent-1', user_id: 'user-1', origin, provider_error: null,
        provider_code: encryptHandoffValue('stored-code', JSON.stringify(['handoff-token', 'consent-1', 'user-1', origin, 'provider_code'])),
      } },
      { data: { provider: 'visma', company_id: 'company-1' } },
    ])
    await expect(consumeHandoff('handoff-token', origin)).resolves.toEqual({
      consentId: 'consent-1', userId: 'user-1', origin, provider: 'visma', companyId: 'company-1',
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

  it('rejects unencrypted or corrupted handoff credentials after deleting the row', async () => {
    const { calls } = useResults([
      { data: { consent_id: 'consent-1', user_id: 'user-1', origin, provider_code: 'plaintext-code', provider_error: null } },
      { data: { provider: 'fortnox', company_id: 'company-1' } },
    ])
    await expect(consumeHandoff('token', origin)).resolves.toBeNull()
    expect(calls[0].ops[0][0]).toBe('delete')
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
