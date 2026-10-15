import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  hashRequest,
  checkIdempotencyKey,
  claimIdempotencyKey,
  storeIdempotencyResponse,
  cleanupExpiredIdempotencyKeys,
  checkUserScopedIdempotencyKey,
  IDEMPOTENCY_CLAIM_TTL_SECONDS,
  IdempotencyKeyInProgressError,
  IdempotencyKeyReuseError,
  type IdempotencyClaim,
  type IdempotencyClaimTarget,
} from '../idempotency'
import { createIdempotencyKeysFake } from '@/tests/idempotency-fake'

describe('hashRequest', () => {
  it('produces stable SHA-256 for the same payload', () => {
    expect(hashRequest({ a: 1, b: 'x' })).toBe(hashRequest({ a: 1, b: 'x' }))
  })

  it('is order-independent', () => {
    expect(hashRequest({ a: 1, b: 2 })).toBe(hashRequest({ b: 2, a: 1 }))
  })

  it('detects different values', () => {
    expect(hashRequest({ a: 1 })).not.toBe(hashRequest({ a: 2 }))
  })

  it('handles nested objects deterministically', () => {
    const h1 = hashRequest({ outer: { x: 1, y: 2 }, list: [1, 2, 3] })
    const h2 = hashRequest({ list: [1, 2, 3], outer: { y: 2, x: 1 } })
    expect(h1).toBe(h2)
  })
})

function mockClient(maybeSingleResult: { data: Record<string, unknown> | null; error: unknown }) {
  const select = vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue(maybeSingleResult),
        }),
      }),
    }),
  })
  const insert = vi.fn().mockResolvedValue({ error: null })
  const deleteFn = vi.fn().mockReturnValue({
    lt: vi.fn().mockResolvedValue({ error: null, count: 5 }),
  })
  return {
    client: {
      from: vi.fn().mockReturnValue({
        select,
        insert,
        delete: deleteFn,
      }),
    } as never,
    select,
    insert,
    deleteFn,
  }
}

describe('checkIdempotencyKey', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns null when no cached row exists', async () => {
    const { client } = mockClient({ data: null, error: null })
    const result = await checkIdempotencyKey(client, 'user-1', 'company-1', 'key-1', 'hash-1')
    expect(result).toBeNull()
  })

  it('returns cached body when key + hash match', async () => {
    const future = new Date(Date.now() + 60_000).toISOString()
    const { client } = mockClient({
      data: {
        request_hash: 'hash-1',
        response_status: 'success',
        response_body: { foo: 'bar' },
        expires_at: future,
      },
      error: null,
    })
    const result = await checkIdempotencyKey(client, 'user-1', 'company-1', 'key-1', 'hash-1')
    expect(result).toEqual({ status: 'success', body: { foo: 'bar' } })
  })

  it('throws IdempotencyKeyReuseError on hash mismatch', async () => {
    const future = new Date(Date.now() + 60_000).toISOString()
    const { client } = mockClient({
      data: {
        request_hash: 'hash-old',
        response_status: 'success',
        response_body: { foo: 'old' },
        expires_at: future,
      },
      error: null,
    })
    await expect(
      checkIdempotencyKey(client, 'user-1', 'company-1', 'key-1', 'hash-new')
    ).rejects.toBeInstanceOf(IdempotencyKeyReuseError)
  })

  it('refuses a claim in progress with the same hash as IdempotencyKeyInProgressError, never replaying it', async () => {
    const future = new Date(Date.now() + 60_000).toISOString()
    const { client } = mockClient({
      data: { request_hash: 'hash-1', response_status: null, response_body: {}, expires_at: future, state: 'in_progress' },
      error: null,
    })
    await expect(checkIdempotencyKey(client, 'user-1', 'company-1', 'key-1', 'hash-1')).rejects.toBeInstanceOf(
      IdempotencyKeyInProgressError,
    )
  })

  it('treats expired rows as misses', async () => {
    const past = new Date(Date.now() - 60_000).toISOString()
    const { client } = mockClient({
      data: {
        request_hash: 'hash-1',
        response_status: 'success',
        response_body: { foo: 'bar' },
        expires_at: past,
      },
      error: null,
    })
    const result = await checkIdempotencyKey(client, 'user-1', 'company-1', 'key-1', 'hash-1')
    expect(result).toBeNull()
  })
})

describe('claimIdempotencyKey', () => {
  // The decision itself (and its locking) is claim_idempotency_key in SQL,
  // proven against Postgres in tests/pg/idempotency-claims.pg.test.ts. These
  // pin the TypeScript side against the fake that mirrors it.
  function seeded() {
    const fake = createIdempotencyKeysFake()
    const client = { from: () => fake.table(), rpc: fake.rpc } as never
    return { fake, client }
  }
  const companyKey = (over: Partial<IdempotencyClaimTarget> = {}): IdempotencyClaimTarget => ({
    userId: 'user-1',
    companyId: 'company-1',
    scope: 'api_route',
    key: 'k',
    requestHash: 'h',
    ...over,
  })
  const createKey = (over: Partial<IdempotencyClaimTarget> = {}) =>
    companyKey({ companyId: null, scope: 'company_create', ...over })
  async function holding(client: never, target: IdempotencyClaimTarget): Promise<IdempotencyClaim> {
    const outcome = await claimIdempotencyKey(client, target)
    if (!('claim' in outcome)) throw new Error('expected to hold the claim')
    return outcome.claim
  }

  it('claims a key never seen, with the claim TTL, and marks the row in progress', async () => {
    const fake = createIdempotencyKeysFake()
    const rpc = vi.fn(fake.rpc)
    await holding({ from: () => fake.table(), rpc } as never, companyKey())
    expect(rpc).toHaveBeenCalledWith('claim_idempotency_key', {
      p_user_id: 'user-1',
      p_company_id: 'company-1',
      p_scope: 'api_route',
      p_key: 'k',
      p_request_hash: 'h',
      p_claim_ttl_seconds: IDEMPOTENCY_CLAIM_TTL_SECONDS,
    })
    expect(fake.rows).toHaveLength(1)
    expect(fake.rows[0]).toMatchObject({ company_id: 'company-1', state: 'in_progress', response_status: null })
  })

  it('refuses the same key and request while the claim is held, with a 2 s retry hint', async () => {
    const { client } = seeded()
    await holding(client, companyKey())
    await expect(claimIdempotencyKey(client, companyKey())).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_IN_PROGRESS',
      retryAfterSeconds: 2,
    })
  })

  it('replays the completed response, 24 h from completion, and refuses another hash as key reuse', async () => {
    const { fake, client } = seeded()
    const claim = await holding(client, companyKey())
    await claim.complete('success', { data: { id: 'inv-1' } })

    expect(fake.rows[0]).toMatchObject({ state: 'completed', response_status: 'success', response_body: { data: { id: 'inv-1' } } })
    const ttlHours = (new Date(fake.rows[0].expires_at).getTime() - Date.now()) / 3_600_000
    expect(ttlHours).toBeGreaterThan(23.9)
    expect(await claimIdempotencyKey(client, companyKey())).toEqual({
      replay: { status: 'success', body: { data: { id: 'inv-1' } } },
    })
    await expect(claimIdempotencyKey(client, companyKey({ requestHash: 'other' }))).rejects.toBeInstanceOf(
      IdempotencyKeyReuseError,
    )
  })

  it('gives the key back on release, so a retry claims it again', async () => {
    const { fake, client } = seeded()
    const claim = await holding(client, companyKey())
    await claim.release()
    expect(fake.rows).toHaveLength(0)
    await holding(client, companyKey())
  })

  it('takes over a claim past its TTL, whatever body it carried', async () => {
    const { fake, client } = seeded()
    const abandoned = await holding(client, companyKey())
    fake.expireAll()
    const fresh = await holding(client, companyKey({ requestHash: 'another body' }))
    expect(fake.rows).toHaveLength(1)
    expect(fake.rows[0]).toMatchObject({ request_hash: 'another body', state: 'in_progress' })

    // The overtaken request settling late touches nothing of the new claim.
    await abandoned.complete('success', { late: true })
    await abandoned.release()
    expect(fake.rows[0]).toMatchObject({ request_hash: 'another body', state: 'in_progress' })
    await fresh.complete('success', { fresh: true })
    expect(fake.rows[0]).toMatchObject({ state: 'completed', response_body: { fresh: true } })
  })

  // A company create has no company until it runs: the key is claimed per
  // (user, scope) and the response stored under the company the write created.
  it('replays a company create stored under the created company, whatever company it names', async () => {
    const { fake, client } = seeded()
    const claim = await holding(client, createKey())
    expect(fake.rows[0]).toMatchObject({ company_id: null, scope: 'company_create', state: 'in_progress' })
    await claim.complete('success', { data: { id: 'company-new' } }, { companyId: 'company-new' })

    expect(fake.rows[0]).toMatchObject({ company_id: 'company-new', state: 'completed' })
    expect(await claimIdempotencyKey(client, createKey())).toEqual({
      replay: { status: 'success', body: { data: { id: 'company-new' } } },
    })
    await expect(claimIdempotencyKey(client, createKey({ requestHash: 'other' }))).rejects.toBeInstanceOf(
      IdempotencyKeyReuseError,
    )
  })

  it('never matches a company create to a key spent on a company-scoped write, nor another user', async () => {
    const { client } = seeded()
    await (await holding(client, companyKey({ companyId: 'company-a' }))).complete('success', {})
    await (await holding(client, createKey({ userId: 'user-2' }))).complete('success', {}, { companyId: 'company-b' })
    await holding(client, createKey())
  })

  it('falls back to the lookup of step 1 when the claim cannot be made, and stores after the write', async () => {
    const fake = createIdempotencyKeysFake()
    const client = {
      from: () => fake.table(),
      rpc: vi.fn().mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }),
    } as never

    const claim = await holding(client, companyKey())
    expect(fake.rows).toHaveLength(0)
    await claim.complete('success', { data: { id: 'inv-1' } })
    await claim.release()
    expect(fake.rows).toHaveLength(1)
    expect(fake.rows[0]).toMatchObject({ company_id: 'company-1', key: 'k', scope: 'api_route', state: 'completed' })

    // The stored response replays, and another body is still key reuse.
    expect(await claimIdempotencyKey(client, companyKey())).toEqual({
      replay: { status: 'success', body: { data: { id: 'inv-1' } } },
    })
    await expect(claimIdempotencyKey(client, companyKey({ requestHash: 'other' }))).rejects.toBeInstanceOf(
      IdempotencyKeyReuseError,
    )
  })

  it('falls back for a company create too: looked up per (user, scope), stored under the created company', async () => {
    const fake = createIdempotencyKeysFake()
    const client = { from: () => fake.table(), rpc: vi.fn().mockRejectedValue(new Error('fetch failed')) } as never

    const claim = await holding(client, createKey())
    await claim.complete('success', { data: { id: 'company-new' } }, { companyId: 'company-new' })
    expect(fake.rows[0]).toMatchObject({ company_id: 'company-new', scope: 'company_create' })
    expect(await claimIdempotencyKey(client, createKey())).toEqual({
      replay: { status: 'success', body: { data: { id: 'company-new' } } },
    })
  })

  it('falls back when the claim answers nothing usable, never treating it as held', async () => {
    const fake = createIdempotencyKeysFake()
    const client = { from: () => fake.table(), rpc: vi.fn().mockResolvedValue({ data: null, error: null }) } as never
    const claim = await holding(client, companyKey())
    await claim.complete('success', {})
    expect(fake.rows[0]).toMatchObject({ state: 'completed', response_status: 'success' })
  })

  it('settles without throwing when the database refuses: the write already ran, or already failed', async () => {
    const failing = () => {
      const chain: Record<string, unknown> = {}
      for (const method of ['update', 'delete', 'eq']) chain[method] = vi.fn(() => chain)
      chain.then = (_resolve: unknown, reject: (reason: unknown) => unknown) => reject(new Error('connection reset'))
      return chain
    }
    const client = {
      rpc: vi.fn().mockResolvedValue({ data: { outcome: 'claimed', claim_id: 'claim-1' }, error: null }),
      from: vi.fn(failing),
    } as never
    const claim = await holding(client, companyKey())
    await expect(claim.complete('success', {})).resolves.toBeUndefined()
    await expect(claim.release()).resolves.toBeUndefined()
  })
})

describe('checkUserScopedIdempotencyKey', () => {
  // A company create has no company until it runs: the key is looked up per
  // (user, scope) and the row is stored under the company the write created.
  function seeded() {
    const fake = createIdempotencyKeysFake()
    const client = { from: () => fake.table() } as never
    return { fake, client }
  }

  it('misses for a key never stored', async () => {
    const { client } = seeded()
    expect(await checkUserScopedIdempotencyKey(client, 'user-1', 'company_create', 'k', 'h')).toBeNull()
  })

  it('replays the row stored under the created company, whatever company it names', async () => {
    const { client } = seeded()
    await storeIdempotencyResponse(client, 'user-1', 'company-new', 'k', 'h', 'success', { data: { id: 'company-new' } }, 'company_create')
    expect(await checkUserScopedIdempotencyKey(client, 'user-1', 'company_create', 'k', 'h')).toEqual({
      status: 'success',
      body: { data: { id: 'company-new' } },
    })
  })

  it('throws IdempotencyKeyReuseError for the same key with another hash', async () => {
    const { client } = seeded()
    await storeIdempotencyResponse(client, 'user-1', 'company-new', 'k', 'h', 'success', {}, 'company_create')
    await expect(checkUserScopedIdempotencyKey(client, 'user-1', 'company_create', 'k', 'other')).rejects.toBeInstanceOf(
      IdempotencyKeyReuseError,
    )
  })

  it('never matches a key spent on a company-scoped write, nor another user', async () => {
    const { client } = seeded()
    await storeIdempotencyResponse(client, 'user-1', 'company-a', 'k', 'h', 'success', {}, 'api_route')
    await storeIdempotencyResponse(client, 'user-2', 'company-b', 'k', 'h', 'success', {}, 'company_create')
    expect(await checkUserScopedIdempotencyKey(client, 'user-1', 'company_create', 'k', 'h')).toBeNull()
  })
})

describe('storeIdempotencyResponse', () => {
  beforeEach(() => vi.clearAllMocks())

  it('writes the response row', async () => {
    const { client, insert } = mockClient({ data: null, error: null })
    await storeIdempotencyResponse(client, 'user-1', 'company-1', 'key-1', 'hash-1', 'success', { ok: true })
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      user_id: 'user-1',
      company_id: 'company-1',
      key: 'key-1',
      request_hash: 'hash-1',
      response_status: 'success',
      response_body: { ok: true },
      scope: 'mcp_tool',
    }))
  })

  it('swallows duplicate-row races (23505)', async () => {
    const { client, insert } = mockClient({ data: null, error: null })
    insert.mockResolvedValueOnce({ error: { code: '23505', message: 'unique_violation' } })
    await expect(
      storeIdempotencyResponse(client, 'user-1', 'company-1', 'key-1', 'hash-1', 'success', {})
    ).resolves.toBeUndefined()
  })
})

describe('cleanupExpiredIdempotencyKeys', () => {
  it('returns delete count', async () => {
    const { client } = mockClient({ data: null, error: null })
    const count = await cleanupExpiredIdempotencyKeys(client)
    expect(count).toBe(5)
  })
})
