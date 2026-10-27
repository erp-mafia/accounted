import { describe, expect, it, vi } from 'vitest'
import { AuthApiError, AuthRetryableFetchError, AuthSessionMissingError } from '@supabase/supabase-js'
import { quietRejectedRefreshTokenErrors, rejectedRefreshTokenCode } from '../refresh-token-errors'

const notFound = () => new AuthApiError('Invalid Refresh Token: Refresh Token Not Found', 400, 'refresh_token_not_found')
const alreadyUsed = () => new AuthApiError('Invalid Refresh Token: Already Used', 400, 'refresh_token_already_used')

function fakeConsole() {
  const original = vi.fn()
  const target = { error: original as (...args: unknown[]) => void }
  const report = vi.fn()
  quietRejectedRefreshTokenErrors(target, report)
  return { target, original, report }
}

describe('rejected refresh tokens', () => {
  it('recognises the two codes GoTrue answers a dead or rotated refresh token with', () => {
    expect(rejectedRefreshTokenCode(notFound())).toBe('refresh_token_not_found')
    expect(rejectedRefreshTokenCode(alreadyUsed())).toBe('refresh_token_already_used')
  })

  it('leaves every other error alone, auth errors included', () => {
    for (const value of [
      new AuthApiError('Invalid login credentials', 400, 'invalid_credentials'),
      new AuthSessionMissingError(),
      new AuthRetryableFetchError('fetch failed', 0),
      new Error('refresh_token_not_found'),
      { code: 'refresh_token_not_found' },
      'refresh_token_not_found',
      null,
      undefined,
    ]) {
      expect(rejectedRefreshTokenCode(value)).toBeNull()
    }
  })

  it('turns the auth-js console.error of a rejected refresh into one report, without the stack', () => {
    const { target, original, report } = fakeConsole()

    target.error(notFound())
    target.error(alreadyUsed())

    expect(report.mock.calls).toEqual([['refresh_token_not_found'], ['refresh_token_already_used']])
    expect(original).not.toHaveBeenCalled()
  })

  it('passes every other console.error through unchanged, arguments and all', () => {
    const { target, original, report } = fakeConsole()
    const other = new AuthApiError('Invalid login credentials', 400, 'invalid_credentials')
    const withContext = notFound()

    target.error(other)
    target.error('[middleware] getClaims failed', withContext)
    target.error('plain message', 42)

    expect(original.mock.calls).toHaveLength(3)
    expect(original.mock.calls[0][0]).toBe(other)
    expect(original.mock.calls[1][1]).toBe(withContext)
    expect(original.mock.calls[2]).toEqual(['plain message', 42])
    expect(report).not.toHaveBeenCalled()
  })

  it('installs once: a second install does not stack another wrapper', () => {
    const { target, original, report } = fakeConsole()
    const installed = target.error
    quietRejectedRefreshTokenErrors(target, vi.fn())

    expect(target.error).toBe(installed)
    target.error(notFound())
    expect(report).toHaveBeenCalledTimes(1)
    expect(original).not.toHaveBeenCalled()
  })
})

// The real client, not a mock: proof that the console.error comes from
// auth-js itself when the proxy's createServerClient meets a refresh token
// GoTrue refuses, and that the filter catches exactly that call.
describe('the proxy client meeting a refused refresh token', () => {
  const SUPABASE_URL = 'https://abcdefgh.supabase.co'

  function deadSessionCookie(): { name: string; value: string } {
    const session = {
      access_token: 'expired.access.token',
      refresh_token: 'dead-refresh-token',
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) - 60,
      user: { id: 'user-1', aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '' },
    }
    const encoded = Buffer.from(JSON.stringify(session)).toString('base64url')
    return { name: 'sb-abcdefgh-auth-token', value: `base64-${encoded}` }
  }

  async function signInWithDeadToken(errorCode: string) {
    const { createServerClient } = await import('@supabase/ssr')
    const refused = vi.fn(async () =>
      new Response(JSON.stringify({ code: 400, error_code: errorCode, msg: 'Invalid Refresh Token' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const written: Array<{ name: string; value: string }> = []
    const client = createServerClient(SUPABASE_URL, 'anon-key', {
      global: { fetch: refused as unknown as typeof fetch },
      // CI runs Node 20, which has no native WebSocket; this client never opens a channel.
      realtime: { transport: class {} as never },
      cookies: {
        getAll: () => [deadSessionCookie()],
        setAll: (cookies) => {
          written.push(...cookies)
        },
      },
    })
    const result = await client.auth.getUser()
    // INITIAL_SESSION runs beside getUser(); let it settle.
    await new Promise((resolve) => setTimeout(resolve, 0))
    return { result, written, refused }
  }

  it('is logged by auth-js with console.error, and lands in the quiet report instead', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const report = vi.fn()
    try {
      quietRejectedRefreshTokenErrors(console, report)

      const { result, written, refused } = await signInWithDeadToken('refresh_token_not_found')

      // getUser() and the INITIAL_SESSION load share one refresh attempt:
      // nothing inside a single proxy request races itself.
      expect(refused).toHaveBeenCalledTimes(1)

      // Signed out: no user, and the dead session cookie is queued for deletion.
      expect(result.data.user).toBeNull()
      expect(written.some((cookie) => cookie.name === 'sb-abcdefgh-auth-token' && cookie.value === '')).toBe(true)
      expect(report).toHaveBeenCalledWith('refresh_token_not_found')
      const leaked = errorSpy.mock.calls.filter(([first]) => rejectedRefreshTokenCode(first) !== null)
      expect(leaked).toEqual([])
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('without the filter the same refusal reaches console.error, which is what production counted', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await signInWithDeadToken('refresh_token_already_used')

      const codes = errorSpy.mock.calls.map(([first]) => rejectedRefreshTokenCode(first)).filter(Boolean)
      expect(codes).toContain('refresh_token_already_used')
    } finally {
      errorSpy.mockRestore()
    }
  })
})
