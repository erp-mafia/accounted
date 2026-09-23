import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  hashRequest,
  checkIdempotencyKey,
  storeIdempotencyResponse,
  cleanupExpiredIdempotencyKeys,
  IdempotencyKeyReuseError,
} from '../idempotency'

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
