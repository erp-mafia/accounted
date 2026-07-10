import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  getOAuthEnv,
  GoogleTokenRefreshError,
} from '../google-oauth'

beforeEach(() => {
  process.env.GOOGLE_CLIENT_ID = 'test-client-id'
  process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret'
  vi.restoreAllMocks()
})

describe('getOAuthEnv', () => {
  it('builds redirect URI from origin', () => {
    const env = getOAuthEnv('https://app.example.com')
    expect(env.redirectUri).toBe(
      'https://app.example.com/api/extensions/ext/cloud-backup/oauth/callback'
    )
    expect(env.clientId).toBe('test-client-id')
  })

  it('throws when env vars missing', () => {
    delete process.env.GOOGLE_CLIENT_ID
    expect(() => getOAuthEnv('http://localhost:3000')).toThrow(/GOOGLE_CLIENT_ID/)
  })
})

describe('buildAuthorizationUrl', () => {
  it('includes scope, offline access, consent prompt, and state', () => {
    const env = getOAuthEnv('http://localhost:3000')
    const url = buildAuthorizationUrl(env, 'abc123state')
    const parsed = new URL(url)
    expect(parsed.origin + parsed.pathname).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth'
    )
    expect(parsed.searchParams.get('access_type')).toBe('offline')
    expect(parsed.searchParams.get('prompt')).toBe('consent')
    expect(parsed.searchParams.get('state')).toBe('abc123state')
    expect(parsed.searchParams.get('scope')).toContain(
      'https://www.googleapis.com/auth/drive.file'
    )
  })
})

describe('exchangeCodeForTokens', () => {
  it('posts form-encoded body and parses token response', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'at',
          refresh_token: 'rt',
          expires_in: 3600,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )
    const env = getOAuthEnv('http://localhost:3000')
    const result = await exchangeCodeForTokens(env, 'auth-code')

    expect(result.refresh_token).toBe('rt')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://oauth2.googleapis.com/token')
    expect((init as RequestInit).method).toBe('POST')
    expect(String((init as RequestInit).body)).toContain('grant_type=authorization_code')
    expect(String((init as RequestInit).body)).toContain('code=auth-code')
  })

  it('throws a clear error when no refresh_token is returned', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )
    const env = getOAuthEnv('http://localhost:3000')
    await expect(exchangeCodeForTokens(env, 'code')).rejects.toThrow(/refresh token/i)
  })

  it('throws on non-OK response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Bad Request', { status: 400 })
    )
    const env = getOAuthEnv('http://localhost:3000')
    await expect(exchangeCodeForTokens(env, 'code')).rejects.toThrow(/400/)
  })
})

describe('refreshAccessToken', () => {
  it('returns a fresh access token', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'new-at', expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )
    const env = getOAuthEnv('http://localhost:3000')
    const result = await refreshAccessToken(env, 'old-refresh')
    expect(result.access_token).toBe('new-at')
  })

  it('throws GoogleTokenRefreshError carrying status and body on non-OK response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"error":"invalid_grant"}', { status: 400 })
    )
    const env = getOAuthEnv('http://localhost:3000')
    const err = await refreshAccessToken(env, 'dead-refresh').catch((e) => e)
    expect(err).toBeInstanceOf(GoogleTokenRefreshError)
    expect(err.status).toBe(400)
    expect(err.body).toContain('invalid_grant')
    expect(err.message).toContain('400')
  })
})

describe('GoogleTokenRefreshError.isInvalidGrant', () => {
  it('is true only for a 400 whose body mentions invalid_grant', () => {
    expect(
      new GoogleTokenRefreshError(400, '{"error":"invalid_grant"}').isInvalidGrant
    ).toBe(true)
    expect(
      new GoogleTokenRefreshError(400, '{"error":"invalid_request"}').isInvalidGrant
    ).toBe(false)
    expect(
      new GoogleTokenRefreshError(500, '{"error":"invalid_grant"}').isInvalidGrant
    ).toBe(false)
    expect(new GoogleTokenRefreshError(503, 'Service Unavailable').isInvalidGrant).toBe(
      false
    )
  })
})
