/**
 * The consent request asks for exactly the scope declared in the Google Cloud
 * Console, and nothing more.
 *
 * Google's restricted-scope review matches the `scope` parameter of the
 * authorization URL against the console's Data Access list string for string,
 * and bounced the first submission because the URL also carried
 * `openid email`. These tests pin the request so a well-meaning "just add
 * profile" cannot silently reopen that.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  GMAIL_READONLY_SCOPE,
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  lacksGmailScope,
  revokeGoogleToken,
} from '../google-oauth'

const env = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  redirectUri: 'https://app.example.test/api/extensions/ext/mail/oauth/callback',
}

const mockFetch = vi.fn()
vi.stubGlobal('fetch', (...args: unknown[]) => mockFetch(...args))

beforeEach(() => {
  vi.clearAllMocks()
})

describe('buildAuthorizationUrl', () => {
  it('requests gmail.readonly and no other scope', () => {
    const url = new URL(buildAuthorizationUrl(env, 'state-token'))
    expect(url.searchParams.get('scope')).toBe(GMAIL_READONLY_SCOPE)
  })

  it('asks for an offline grant with explicit consent and no scope inheritance', () => {
    const url = new URL(buildAuthorizationUrl(env, 'state-token'))
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('prompt')).toBe('consent')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('state')).toBe('state-token')
    expect(url.searchParams.get('redirect_uri')).toBe(env.redirectUri)
    expect(url.searchParams.has('include_granted_scopes')).toBe(false)
  })
})

describe('buildAuthorizationUrl with PKCE', () => {
  it('adds the S256 challenge and leaves the reviewed scope untouched', () => {
    const url = new URL(buildAuthorizationUrl(env, 'state-token', 'challenge-abc'))
    expect(url.searchParams.get('code_challenge')).toBe('challenge-abc')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('scope')).toBe(GMAIL_READONLY_SCOPE)
  })

  it('sends no PKCE parameters without a challenge', () => {
    const url = new URL(buildAuthorizationUrl(env, 'state-token'))
    expect(url.searchParams.has('code_challenge')).toBe(false)
    expect(url.searchParams.has('code_challenge_method')).toBe(false)
  })
})

describe('exchangeCodeForTokens', () => {
  it('sends the PKCE verifier when the flow has one, and none otherwise', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ access_token: 'at', refresh_token: 'rt', scope: GMAIL_READONLY_SCOPE }),
    })
    await exchangeCodeForTokens(env, 'auth-code', 'the-verifier')
    await exchangeCodeForTokens(env, 'auth-code')

    const withVerifier = new URLSearchParams(String((mockFetch.mock.calls[0][1] as RequestInit).body))
    const without = new URLSearchParams(String((mockFetch.mock.calls[1][1] as RequestInit).body))
    expect(withVerifier.get('code_verifier')).toBe('the-verifier')
    expect(without.has('code_verifier')).toBe(false)
  })

  it('returns the tokens and granted scopes without needing an id_token', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          access_token: 'at',
          refresh_token: 'rt',
          expires_in: 3600,
          scope: GMAIL_READONLY_SCOPE,
        }),
    })
    const tokens = await exchangeCodeForTokens(env, 'auth-code')
    expect(tokens.accessToken).toBe('at')
    expect(tokens.refreshToken).toBe('rt')
    expect(tokens.scopes).toEqual([GMAIL_READONLY_SCOPE])
    expect(tokens).not.toHaveProperty('email')
  })

  it('reports a grant without a refresh token as null, so the callback can say why', async () => {
    // Throwing here made the callback's no_refresh_token answer unreachable:
    // the person got a generic failure instead of the fix.
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ access_token: 'at', expires_in: 3600, scope: GMAIL_READONLY_SCOPE }),
    })
    const tokens = await exchangeCodeForTokens(env, 'auth-code')
    expect(tokens.refreshToken).toBeNull()
    expect(tokens.accessToken).toBe('at')
  })

  it('still throws when Google refuses the code', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: 'invalid_grant', error_description: 'Bad Request' }),
    })
    await expect(exchangeCodeForTokens(env, 'auth-code')).rejects.toThrow('Bad Request')
  })
})

describe('lacksGmailScope', () => {
  it('is true only for a stated scope list that leaves Gmail out', () => {
    // The shape of the three production rows saved before the consent
    // request was cut to one scope: Gmail unticked, sign-in approved.
    expect(lacksGmailScope(['openid', 'https://www.googleapis.com/auth/userinfo.email'])).toBe(true)
  })

  it('keeps a grant that carries gmail.readonly, alone or with others', () => {
    // The reviewer's demo row carries exactly this.
    expect(lacksGmailScope([GMAIL_READONLY_SCOPE])).toBe(false)
    expect(
      lacksGmailScope(['openid', GMAIL_READONLY_SCOPE, 'https://www.googleapis.com/auth/userinfo.email']),
    ).toBe(false)
  })

  it('never reads an unstated scope list as a missing scope', () => {
    // RFC 6749 5.1: an omitted scope is the scope requested.
    expect(lacksGmailScope([])).toBe(false)
    expect(lacksGmailScope(null)).toBe(false)
    expect(lacksGmailScope(undefined)).toBe(false)
  })
})

describe('revokeGoogleToken', () => {
  it('posts the token form-encoded to the revoke endpoint, never in the URL', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) })

    const result = await revokeGoogleToken('refresh-secret')

    expect(result).toEqual({ outcome: 'revoked', status: 200, error: null })
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://oauth2.googleapis.com/revoke')
    expect(url).not.toContain('refresh-secret')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded')
    expect(String(init.body)).toBe('token=refresh-secret')
    // Bounded like the token calls, so a stalled Google cannot hold a
    // disconnect open.
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('reads invalid_token as a grant Google no longer has', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: 'invalid_token', error_description: 'Token expired or revoked' }),
    })
    expect(await revokeGoogleToken('t')).toEqual({ outcome: 'already_invalid', status: 400, error: 'invalid_token' })
  })

  it('reports any other answer as not confirmed', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503, json: () => Promise.reject(new Error('not json')) })
    expect(await revokeGoogleToken('t')).toEqual({ outcome: 'failed', status: 503, error: null })
  })

  it('never throws on a timeout, and never carries the token into the error', async () => {
    mockFetch.mockRejectedValue(Object.assign(new Error('aborted refresh-secret'), { name: 'TimeoutError' }))
    const result = await revokeGoogleToken('refresh-secret')
    expect(result).toEqual({ outcome: 'failed', status: null, error: 'TimeoutError' })
    expect(JSON.stringify(result)).not.toContain('refresh-secret')
  })
})
