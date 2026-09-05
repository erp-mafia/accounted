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
import { GMAIL_READONLY_SCOPE, buildAuthorizationUrl, exchangeCodeForTokens } from '../google-oauth'

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

describe('exchangeCodeForTokens', () => {
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

  it('refuses a grant that came back without a refresh token', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ access_token: 'at', expires_in: 3600 }),
    })
    await expect(exchangeCodeForTokens(env, 'auth-code')).rejects.toThrow(/refresh token/)
  })
})
