import { describe, it, expect, vi } from 'vitest'
import { isBuiltInRedirectUri, isAllowedRedirectUri } from '../oauth-allowlist'
import type { SupabaseClient } from '@supabase/supabase-js'

describe('isBuiltInRedirectUri', () => {
  it.each([
    ['https://claude.ai/api/oauth/callback', true],
    ['https://claude.com/api/oauth/callback', true],
    ['http://localhost:3000/cb', true],
    ['http://localhost/cb', true],
    ['http://127.0.0.1:8080/cb', true],
    ['https://evil.com/cb', false],
    ['https://example.com/api/foo', false],
    ['ftp://localhost/cb', false],
    ['', false],
  ])('classifies %s as %s', (uri, expected) => {
    expect(isBuiltInRedirectUri(uri)).toBe(expected)
  })
})

function makeFakeSupabase(rows: Array<{ id: string }>): SupabaseClient {
  // Chainable thenable that resolves to { data, error } when awaited via
  // .maybeSingle(). Matches the shape isAllowedRedirectUri actually invokes.
  const chain = {
    from() { return chain },
    select() { return chain },
    eq() { return chain },
    is() { return chain },
    limit() { return chain },
    async maybeSingle() {
      return { data: rows[0] ?? null, error: null }
    },
  }
  return chain as unknown as SupabaseClient
}

describe('isAllowedRedirectUri', () => {
  it('short-circuits to true for built-in patterns without touching the DB', async () => {
    const sb = {
      from: vi.fn(() => {
        throw new Error('should not be called')
      }),
    } as unknown as SupabaseClient
    expect(await isAllowedRedirectUri('https://claude.ai/api/cb', sb)).toBe(true)
    expect(await isAllowedRedirectUri('http://localhost:3000/cb', sb)).toBe(true)
  })

  it('returns true when the DB has a registration for the URI', async () => {
    const sb = makeFakeSupabase([{ id: 'reg-1' }])
    expect(await isAllowedRedirectUri('https://myapp.example.com/cb', sb)).toBe(true)
  })

  it('returns false when no registration exists', async () => {
    const sb = makeFakeSupabase([])
    expect(await isAllowedRedirectUri('https://evil.com/cb', sb)).toBe(false)
  })

  it('returns false for empty / non-string inputs', async () => {
    expect(await isAllowedRedirectUri('')).toBe(false)
    expect(await isAllowedRedirectUri(undefined as unknown as string)).toBe(false)
  })
})
