import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  expiredCookieOptions,
  httpOnlyCookieOptions,
  requestProtocolFromHeaders,
  shouldUseSecureCookies,
  supabaseAuthCookieOptions,
} from '../cookie-options'

afterEach(() => {
  vi.unstubAllEnvs()
})

function hosted() {
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', '')
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.accounted.se')
}

function selfHosted(appUrl: string) {
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
  vi.stubEnv('NEXT_PUBLIC_APP_URL', appUrl)
}

describe('shouldUseSecureCookies', () => {
  it('is Secure on the hosted product in production', () => {
    hosted()
    expect(shouldUseSecureCookies()).toBe(true)
    // Even when the request protocol is unknown or reported as http: the
    // hosted product is https-only, so the attribute never depends on a header.
    expect(shouldUseSecureCookies('http')).toBe(true)
  })

  it('is not Secure on a plain-http self-hosted install, so LAN sign-in keeps working', () => {
    selfHosted('http://192.168.1.20:3000')
    expect(shouldUseSecureCookies()).toBe(false)
    expect(shouldUseSecureCookies('http:')).toBe(false)
  })

  it('is Secure on a self-hosted install served over https', () => {
    selfHosted('https://bok.example.se')
    expect(shouldUseSecureCookies()).toBe(true)
  })

  it('is Secure whenever the request itself arrived over https', () => {
    selfHosted('http://192.168.1.20:3000')
    expect(shouldUseSecureCookies('https')).toBe(true)
    expect(shouldUseSecureCookies('https:')).toBe(true)
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', '')
    expect(shouldUseSecureCookies('https:')).toBe(true)
  })

  it('is not Secure in local http development', () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', '')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000')
    expect(shouldUseSecureCookies('http:')).toBe(false)
  })

  it('treats an unreplaced Docker sentinel as not https', () => {
    selfHosted('__NEXT_PUBLIC_APP_URL__')
    expect(shouldUseSecureCookies()).toBe(false)
  })
})

describe('requestProtocolFromHeaders', () => {
  it('reads the first hop of x-forwarded-proto', () => {
    expect(requestProtocolFromHeaders(new Headers({ 'x-forwarded-proto': 'https, http' }))).toBe('https')
    expect(requestProtocolFromHeaders(new Headers({ 'x-forwarded-proto': 'HTTP' }))).toBe('http')
    expect(requestProtocolFromHeaders(new Headers())).toBeNull()
    expect(requestProtocolFromHeaders(null)).toBeNull()
  })
})

describe('cookie option shapes', () => {
  it('makes the Supabase session cookie HttpOnly, SameSite=Lax, Path=/', () => {
    hosted()
    expect(supabaseAuthCookieOptions()).toEqual({
      path: '/',
      sameSite: 'lax',
      httpOnly: true,
      secure: true,
    })
  })

  it('leaves Max-Age to @supabase/ssr for the session cookie', () => {
    hosted()
    expect(supabaseAuthCookieOptions()).not.toHaveProperty('maxAge')
  })

  it('builds HttpOnly options for other server cookies, with and without a lifetime', () => {
    selfHosted('http://nas.local:3000')
    expect(httpOnlyCookieOptions(60)).toEqual({
      path: '/',
      sameSite: 'lax',
      httpOnly: true,
      secure: false,
      maxAge: 60,
    })
    expect(httpOnlyCookieOptions()).not.toHaveProperty('maxAge')
  })

  it('deletes with the same attributes and Max-Age 0', () => {
    hosted()
    expect(expiredCookieOptions()).toEqual({
      path: '/',
      sameSite: 'lax',
      httpOnly: true,
      secure: true,
      maxAge: 0,
    })
  })
})
