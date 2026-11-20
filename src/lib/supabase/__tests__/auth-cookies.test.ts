import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import {
  AUTH_COOKIE_FLAGS_MARKER,
  authCookieExpiresAt,
  isAuthTokenCookieName,
  readAuthCookieValue,
  supabaseAuthStorageKey,
  upgradeLegacyAuthCookies,
} from '../auth-cookies'

const KEY = 'sb-project-auth-token'
const NOW = Date.UTC(2026, 8, 28, 12, 0, 0)

function encodeSession(expiresAt: number, extra: Record<string, unknown> = {}): string {
  const json = JSON.stringify({
    access_token: 'header.payload.signature',
    refresh_token: 'refresh-1',
    expires_at: expiresAt,
    user: { id: 'user-1', user_metadata: { name: 'Åsa Öberg' } },
    ...extra,
  })
  const bytes = new TextEncoder().encode(json)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `base64-${btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')}`
}

function requestWith(cookies: Record<string, string>): NextRequest {
  const header = Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ')
  return new NextRequest('https://app.accounted.se/transactions', {
    headers: header ? { cookie: header } : {},
  })
}

function setCookieHeaders(response: NextResponse): string[] {
  return response.headers.getSetCookie()
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.co')
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('session cookie naming', () => {
  it('derives the storage key the way supabase-js does', () => {
    expect(supabaseAuthStorageKey()).toBe(KEY)
    expect(supabaseAuthStorageKey('http://127.0.0.1:54321')).toBe('sb-127-auth-token')
    expect(supabaseAuthStorageKey('not a url')).toBeNull()
  })

  it('matches the cookie and its numbered chunks, never the PKCE verifier', () => {
    expect(isAuthTokenCookieName(KEY, KEY)).toBe(true)
    expect(isAuthTokenCookieName(`${KEY}.0`, KEY)).toBe(true)
    expect(isAuthTokenCookieName(`${KEY}.12`, KEY)).toBe(true)
    expect(isAuthTokenCookieName(`${KEY}-code-verifier`, KEY)).toBe(false)
    expect(isAuthTokenCookieName(`${KEY}.x`, KEY)).toBe(false)
  })
})

describe('reading the session cookie', () => {
  it('reassembles chunks in order', () => {
    const value = encodeSession(NOW / 1000 + 3600)
    const request = requestWith({ [`${KEY}.0`]: value.slice(0, 20), [`${KEY}.1`]: value.slice(20) })
    expect(readAuthCookieValue(request.cookies, KEY)).toBe(value)
  })

  it('reads expires_at from base64 and raw JSON encodings (UTF-8 intact)', () => {
    expect(authCookieExpiresAt(encodeSession(1234))).toBe(1234)
    expect(authCookieExpiresAt(JSON.stringify({ expires_at: 99 }))).toBe(99)
    expect(authCookieExpiresAt('base64-%%%')).toBeNull()
    expect(authCookieExpiresAt('garbage')).toBeNull()
  })
})

describe('upgradeLegacyAuthCookies', () => {
  it('rewrites a pre-HttpOnly session cookie verbatim with the new attributes and marks it', async () => {
    const value = encodeSession(NOW / 1000 + 3600)
    const request = requestWith({ [KEY]: value })
    const response = NextResponse.next()

    await upgradeLegacyAuthCookies(request, response, 'https', NOW)

    const rewritten = response.cookies.get(KEY)
    expect(rewritten?.value).toBe(value)
    expect(rewritten).toMatchObject({ httpOnly: true, secure: true, sameSite: 'lax', path: '/' })
    const marker = response.cookies.get(AUTH_COOKIE_FLAGS_MARKER)
    expect(marker?.value).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(marker).toMatchObject({ httpOnly: true, secure: true })
    for (const header of setCookieHeaders(response)) {
      expect(header).toMatch(/HttpOnly/i)
      expect(header).toMatch(/Secure/i)
    }
  })

  it('rewrites every chunk of a chunked cookie', async () => {
    const value = encodeSession(NOW / 1000 + 3600)
    const request = requestWith({ [`${KEY}.0`]: value.slice(0, 30), [`${KEY}.1`]: value.slice(30) })
    const response = NextResponse.next()

    await upgradeLegacyAuthCookies(request, response, 'https', NOW)

    expect(response.cookies.get(`${KEY}.0`)?.value).toBe(value.slice(0, 30))
    expect(response.cookies.get(`${KEY}.1`)?.value).toBe(value.slice(30))
    expect(response.cookies.get(`${KEY}.1`)?.httpOnly).toBe(true)
  })

  it('does nothing once the marker vouches for the exact cookie value', async () => {
    const value = encodeSession(NOW / 1000 + 3600)
    const first = NextResponse.next()
    await upgradeLegacyAuthCookies(requestWith({ [KEY]: value }), first, 'https', NOW)
    const marker = first.cookies.get(AUTH_COOKIE_FLAGS_MARKER)!.value

    const second = NextResponse.next()
    await upgradeLegacyAuthCookies(
      requestWith({ [KEY]: value, [AUTH_COOKIE_FLAGS_MARKER]: marker }),
      second,
      'https',
      NOW,
    )
    expect(setCookieHeaders(second)).toEqual([])
  })

  it('rewrites again when the cookie changed behind the marker (an old tab wrote a new one)', async () => {
    const request = requestWith({
      [KEY]: encodeSession(NOW / 1000 + 3600, { refresh_token: 'refresh-2' }),
      [AUTH_COOKIE_FLAGS_MARKER]: 'stale-fingerprint-value',
    })
    const response = NextResponse.next()
    await upgradeLegacyAuthCookies(request, response, 'https', NOW)
    expect(response.cookies.get(KEY)?.httpOnly).toBe(true)
  })

  it('does not rewrite on a state-changing request (a sign-out must not race a re-emit)', async () => {
    const value = encodeSession(NOW / 1000 + 3600)
    const post = new NextRequest('https://app.accounted.se/api/auth/logout', {
      method: 'POST',
      headers: { cookie: `${KEY}=${value}` },
    })
    const response = NextResponse.next()
    await upgradeLegacyAuthCookies(post, response, 'https', NOW)
    expect(response.cookies.get(KEY)).toBeUndefined()
    expect(response.cookies.get(AUTH_COOKIE_FLAGS_MARKER)).toBeUndefined()
  })

  it('leaves a cookie close to expiry alone: the imminent refresh writes it with the new attributes', async () => {
    const request = requestWith({ [KEY]: encodeSession(NOW / 1000 + 120) })
    const response = NextResponse.next()
    await upgradeLegacyAuthCookies(request, response, 'https', NOW)
    expect(setCookieHeaders(response)).toEqual([])
  })

  it('only moves the marker when auth-js already rewrote the cookie on this response', async () => {
    const refreshed = encodeSession(NOW / 1000 + 3600, { refresh_token: 'refresh-3' })
    // What the proxy's setAll leaves behind after a refresh: the new value
    // mirrored into the request and written on the response.
    const request = requestWith({ [KEY]: refreshed })
    const response = NextResponse.next()
    response.cookies.set(KEY, refreshed, { httpOnly: true, secure: true, path: '/', sameSite: 'lax', maxAge: 60 })

    await upgradeLegacyAuthCookies(request, response, 'https', NOW)

    // Not re-emitted with a second set of options: auth-js's write stands.
    expect(response.cookies.get(KEY)?.maxAge).toBe(60)
    expect(response.cookies.get(AUTH_COOKIE_FLAGS_MARKER)?.value).toBeTruthy()
  })

  it('clears a stray marker when there is no session cookie', async () => {
    const response = NextResponse.next()
    await upgradeLegacyAuthCookies(requestWith({ [AUTH_COOKIE_FLAGS_MARKER]: 'x' }), response, 'https', NOW)
    const marker = response.cookies.get(AUTH_COOKIE_FLAGS_MARKER)
    expect(marker?.value).toBe('')
    expect(marker?.maxAge).toBe(0)
    expect(marker?.httpOnly).toBe(true)
  })

  it('is a no-op for a request without any session cookie', async () => {
    const response = NextResponse.next()
    await upgradeLegacyAuthCookies(requestWith({ other: '1' }), response, 'https', NOW)
    expect(setCookieHeaders(response)).toEqual([])
  })

  it('rewrites once more when the attribute policy changes (a self-host moving to https)', async () => {
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://nas.local:3000')
    const value = encodeSession(NOW / 1000 + 3600)
    const overHttp = NextResponse.next()
    await upgradeLegacyAuthCookies(requestWith({ [KEY]: value }), overHttp, 'http', NOW)
    const httpMarker = overHttp.cookies.get(AUTH_COOKIE_FLAGS_MARKER)!.value

    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://nas.example.se')
    const overHttps = NextResponse.next()
    await upgradeLegacyAuthCookies(
      requestWith({ [KEY]: value, [AUTH_COOKIE_FLAGS_MARKER]: httpMarker }),
      overHttps,
      'https',
      NOW,
    )
    expect(overHttps.cookies.get(KEY)).toMatchObject({ value, httpOnly: true, secure: true })
    expect(overHttps.cookies.get(AUTH_COOKIE_FLAGS_MARKER)?.value).not.toBe(httpMarker)
  })

  it('omits Secure on a plain-http self-hosted install', async () => {
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://nas.local:3000')
    const response = NextResponse.next()
    await upgradeLegacyAuthCookies(
      requestWith({ [KEY]: encodeSession(NOW / 1000 + 3600) }),
      response,
      'http',
      NOW,
    )
    expect(response.cookies.get(KEY)).toMatchObject({ httpOnly: true, secure: false })
  })
})
