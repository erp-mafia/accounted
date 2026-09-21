import { describe, it, expect, beforeEach, vi } from 'vitest'

// Stub the supabase service-role client so token-store doesn't need real env.
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: vi.fn(),
  })),
}))

import { getTokens } from '../lib/token-store'

const fakeSupabase = {} as never

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key'
  process.env.SKATTEVERKET_TOKEN_ENCRYPTION_KEY = 'test-encryption-key'
  vi.restoreAllMocks()
})

async function mockSelectReturning(row: unknown) {
  const { createClient } = await import('@supabase/supabase-js')
  // getTokens chains .eq('user_id', …).eq('company_id', …).maybeSingle():
  // a self-referencing eq keeps the chain length out of the mock's contract.
  const eqChain: { eq: ReturnType<typeof vi.fn>; maybeSingle: ReturnType<typeof vi.fn> } = {
    eq: vi.fn(() => eqChain),
    maybeSingle: vi.fn(async () => row),
  }
  ;(createClient as unknown as { mockReturnValue: (v: unknown) => void }).mockReturnValue({
    from: vi.fn(() => ({
      select: vi.fn(() => eqChain),
    })),
  })
}

describe('getTokens', () => {
  it('returns null when no row exists (NOT_CONNECTED state)', async () => {
    await mockSelectReturning({ data: null, error: { message: 'no rows' } })
    // Module-level _serviceClient cache means we need a fresh import after
    // mock changes. Use vitest's resetModules to force re-import.
    vi.resetModules()
    const { getTokens: fresh } = await import('../lib/token-store')
    const result = await fresh(fakeSupabase, 'user-1', 'comp-1')
    expect(result).toBeNull()
  })

  it('throws TOKEN_CORRUPTED when stored ciphertext cannot be decrypted', async () => {
    // Arrange: the row exists but its access_token is not valid AES-256-GCM
    // ciphertext (e.g. encryption key was rotated). With vi.resetModules()
    // the SkatteverketAuthError class identity diverges across re-imports,
    // so we assert by .name + .code instead of instanceof.
    await mockSelectReturning({
      data: {
        access_token: 'this-is-not-valid-base64url-ciphertext',
        refresh_token: null,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        refresh_count: 0,
        scope: 'momsdeklaration',
      },
      error: null,
    })
    vi.resetModules()
    const { getTokens: fresh } = await import('../lib/token-store')

    try {
      await fresh(fakeSupabase, 'user-1', 'comp-1')
      expect.fail('expected throw')
    } catch (e) {
      const err = e as { name: string; code: string; message: string }
      expect(err.name).toBe('SkatteverketAuthError')
      expect(err.code).toBe('TOKEN_CORRUPTED')
      expect(err.message).toMatch(/BankID/)
    }
  })
})

// Export-ensure: getTokens itself is the only exported symbol we need to
// verify the new behavior. The full storeTokens flow (DELETE+INSERT, SELECT
// failure handling per commit 8865f61) is exercised by integration tests
// against pg-real and not duplicated here.
void getTokens

/**
 * The health latch is what turns an auth failure into a permanent
 * "this connection is broken" across every surface, so what may latch is a
 * contract, not a call-site detail (#2567). The guard lives in
 * markNeedsReconsent itself: a future caller cannot re-latch ordinary session
 * expiry by forgetting to filter on RECONSENT_ERROR_CODES.
 */
describe('markNeedsReconsent', () => {
  async function mockUpdate() {
    const { createClient } = await import('@supabase/supabase-js')
    const eqChain: { eq: ReturnType<typeof vi.fn> } & PromiseLike<unknown> = {
      eq: vi.fn(() => eqChain),
      then: (resolve: (value: unknown) => void) => resolve({ error: null }),
    } as never
    const update = vi.fn((_payload: Record<string, unknown>) => eqChain)
    ;(createClient as unknown as { mockReturnValue: (v: unknown) => void }).mockReturnValue({
      from: vi.fn(() => ({ update })),
    })
    return update
  }

  it('does not write for SESSION_EXPIRED: the hourly BankID expiry is not a fault', async () => {
    const update = await mockUpdate()
    vi.resetModules()
    const { markNeedsReconsent } = await import('../lib/token-store')

    await markNeedsReconsent(fakeSupabase, 'user-1', 'comp-1', 'SESSION_EXPIRED')

    expect(update).not.toHaveBeenCalled()
  })

  it.each(['REFRESH_EXHAUSTED', 'MISSING_SCOPE', 'TOKEN_CORRUPTED'])(
    'still latches %s: only a fresh BankID consent clears it',
    async (code) => {
      const update = await mockUpdate()
      vi.resetModules()
      const { markNeedsReconsent } = await import('../lib/token-store')

      await markNeedsReconsent(fakeSupabase, 'user-1', 'comp-1', code)

      expect(update).toHaveBeenCalledTimes(1)
      expect(update.mock.calls[0][0]).toMatchObject({
        status: 'needs_reconsent',
        last_error_code: code,
      })
    },
  )

  it('ignores an unknown code rather than inventing a health fault', async () => {
    const update = await mockUpdate()
    vi.resetModules()
    const { markNeedsReconsent } = await import('../lib/token-store')

    await markNeedsReconsent(fakeSupabase, 'user-1', 'comp-1', 'SOMETHING_NEW')

    expect(update).not.toHaveBeenCalled()
  })
})

describe('RECONSENT_ERROR_CODES', () => {
  it('no longer carries SESSION_EXPIRED (#2567)', async () => {
    const { RECONSENT_ERROR_CODES } = await import('../lib/token-store')
    expect(RECONSENT_ERROR_CODES).not.toContain('SESSION_EXPIRED')
    expect([...RECONSENT_ERROR_CODES]).toEqual([
      'REFRESH_EXHAUSTED',
      'MISSING_SCOPE',
      'TOKEN_CORRUPTED',
    ])
  })
})
