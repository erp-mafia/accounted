/**
 * The shared Google OAuth requests: one consent URL and one token endpoint for
 * mail and cloud backup. Codes and tokens travel in a form body, never a URL.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  buildGoogleConsentUrl,
  exchangeGoogleCode,
  refreshGoogleAccessToken,
} from '../google-oauth'

const client = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  redirectUri: 'https://app.example.test/api/extensions/ext/x/oauth/callback',
}

const mockFetch = vi.fn()
vi.stubGlobal('fetch', (...args: unknown[]) => mockFetch(...args))

beforeEach(() => {
  vi.clearAllMocks()
  mockFetch.mockResolvedValue(new Response('{}', { status: 200 }))
})

describe('buildGoogleConsentUrl', () => {
  it('asks for an offline grant with explicit consent and exactly the given scope', () => {
    const url = new URL(buildGoogleConsentUrl(client, { scope: 'scope-a scope-b', state: 'st' }))
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'client-id',
      redirect_uri: client.redirectUri,
      response_type: 'code',
      scope: 'scope-a scope-b',
      access_type: 'offline',
      prompt: 'consent',
      state: 'st',
    })
  })

  it('adds scope inheritance and PKCE only when asked', () => {
    const url = new URL(
      buildGoogleConsentUrl(client, { scope: 's', state: 'st', includeGrantedScopes: true, codeChallenge: 'ch' }),
    )
    expect(url.searchParams.get('include_granted_scopes')).toBe('true')
    expect(url.searchParams.get('code_challenge')).toBe('ch')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
  })
})

describe('token requests', () => {
  it('posts the code exchange form-encoded to the token endpoint, verifier included when given', async () => {
    await exchangeGoogleCode(client, 'the-code', { codeVerifier: 'ver', timeoutMs: 1000, description: 'x' })
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://oauth2.googleapis.com/token')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded')
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({
      code: 'the-code',
      client_id: 'client-id',
      client_secret: 'client-secret',
      redirect_uri: client.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: 'ver',
    })
  })

  it('sends no verifier without one', async () => {
    await exchangeGoogleCode(client, 'the-code', { codeVerifier: null, timeoutMs: 1000, description: 'x' })
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(new URLSearchParams(String(init.body)).has('code_verifier')).toBe(false)
  })

  it('posts the refresh with the token in the body, never the URL', async () => {
    await refreshGoogleAccessToken(client, 'refresh-secret', { timeoutMs: 1000, description: 'x' })
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).not.toContain('refresh-secret')
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({
      refresh_token: 'refresh-secret',
      client_id: 'client-id',
      client_secret: 'client-secret',
      grant_type: 'refresh_token',
    })
  })

  it('names the call when the deadline passes', async () => {
    mockFetch.mockImplementation((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })),
        )
      }),
    )
    await expect(
      refreshGoogleAccessToken(client, 'rt', { timeoutMs: 10, description: 'Gmail token refresh' }),
    ).rejects.toThrow('Gmail token refresh timed out after 10ms')
  })

  it('hands back Google\'s answer untouched', async () => {
    const answer = new Response('{"error":"invalid_grant"}', { status: 400 })
    mockFetch.mockResolvedValue(answer)
    const res = await refreshGoogleAccessToken(client, 'rt', { timeoutMs: 1000, description: 'x' })
    expect(res).toBe(answer)
  })
})
