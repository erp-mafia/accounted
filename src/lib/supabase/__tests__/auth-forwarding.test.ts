import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  authForwardingFetch,
  clientIpFromHeaders,
  FORWARDED_FOR_HEADER,
  isIpAddress,
} from '../auth-forwarding'

const SECRET = 'sb_secret_test-0123456789abcdef'
const ANON = 'eyJhbGciOiJIUzI1NiJ9.anon.sig'
const USER_JWT = 'eyJhbGciOiJFUzI1NiJ9.user.sig'
const SUPABASE = 'https://project.supabase.co'

let baseFetch: ReturnType<typeof vi.fn>

function sentHeaders(call = 0): Headers {
  const init = baseFetch.mock.calls[call][1] as RequestInit | undefined
  return new Headers(init?.headers)
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE)
  vi.stubEnv('SUPABASE_SECRET_KEY', SECRET)
  baseFetch = vi.fn(async () => new Response('{}', { status: 200 }))
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('authForwardingFetch', () => {
  it('swaps in the secret key and adds Sb-Forwarded-For on GoTrue requests, leaving Authorization alone', async () => {
    const fetchWith = authForwardingFetch('203.0.113.7', baseFetch as unknown as typeof fetch)!

    // auth-js passes a plain header object.
    await fetchWith(`${SUPABASE}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' },
      body: '{}',
    })

    const headers = sentHeaders()
    expect(headers.get('apikey')).toBe(SECRET)
    expect(headers.get(FORWARDED_FOR_HEADER)).toBe('203.0.113.7')
    expect(headers.get('authorization')).toBe(`Bearer ${ANON}`)
    expect(headers.get('content-type')).toBe('application/json')
    const init = baseFetch.mock.calls[0][1] as RequestInit
    expect(init.method).toBe('POST')
    expect(init.body).toBe('{}')
  })

  it("keeps a user's access token as the Authorization of user-scoped GoTrue calls", async () => {
    const fetchWith = authForwardingFetch('2001:db8::1', baseFetch as unknown as typeof fetch)!

    await fetchWith(`${SUPABASE}/auth/v1/user`, {
      headers: new Headers({ apikey: ANON, Authorization: `Bearer ${USER_JWT}` }),
    })

    const headers = sentHeaders()
    expect(headers.get('apikey')).toBe(SECRET)
    expect(headers.get('authorization')).toBe(`Bearer ${USER_JWT}`)
    expect(headers.get(FORWARDED_FOR_HEADER)).toBe('2001:db8::1')
  })

  it.each([
    ['PostgREST', `${SUPABASE}/rest/v1/companies?select=id`],
    ['Storage', `${SUPABASE}/storage/v1/object/documents/x.pdf`],
    ['Realtime (HTTP broadcast)', `${SUPABASE}/realtime/v1/api/broadcast`],
    ['Functions', `${SUPABASE}/functions/v1/ocr`],
    ['a lookalike path', `${SUPABASE}/rest/v1/auth/v1/token`],
    ['another origin', 'https://evil.example/auth/v1/token'],
  ])('never touches %s requests: the secret key would bypass RLS there', async (_label, url) => {
    const fetchWith = authForwardingFetch('203.0.113.7', baseFetch as unknown as typeof fetch)!
    const init = { headers: new Headers({ apikey: ANON, Authorization: `Bearer ${USER_JWT}` }) }

    await fetchWith(url, init)

    expect(baseFetch).toHaveBeenCalledWith(url, init)
    const headers = sentHeaders()
    expect(headers.get('apikey')).toBe(ANON)
    expect(headers.has(FORWARDED_FOR_HEADER)).toBe(false)
  })

  it('leaves GoTrue requests as they are when no valid client IP is known', async () => {
    for (const ip of [null, '', 'unknown', '203.0.113.7:443', '999.1.1.1', 'fe80::1%eth0', '[::1]']) {
      baseFetch.mockClear()
      const fetchWith = authForwardingFetch(ip, baseFetch as unknown as typeof fetch)!
      await fetchWith(`${SUPABASE}/auth/v1/token`, { headers: { apikey: ANON } })
      const headers = sentHeaders()
      expect(headers.get('apikey')).toBe(ANON)
      expect(headers.has(FORWARDED_FOR_HEADER)).toBe(false)
    }
  })

  it('is off (the default fetch stays) without an sb_secret_ key', () => {
    vi.stubEnv('SUPABASE_SECRET_KEY', '')
    expect(authForwardingFetch('203.0.113.7')).toBeUndefined()
    // A legacy service_role JWT is not accepted for IP forwarding.
    vi.stubEnv('SUPABASE_SECRET_KEY', 'eyJhbGciOiJIUzI1NiJ9.service_role.sig')
    expect(authForwardingFetch('203.0.113.7')).toBeUndefined()
    vi.stubEnv('SUPABASE_SECRET_KEY', 'sb_publishable_abc')
    expect(authForwardingFetch('203.0.113.7')).toBeUndefined()
  })

  it('handles URL and Request inputs', async () => {
    const fetchWith = authForwardingFetch('198.51.100.4', baseFetch as unknown as typeof fetch)!

    await fetchWith(new URL(`${SUPABASE}/auth/v1/logout?scope=global`), { method: 'POST', headers: { apikey: ANON } })
    expect(sentHeaders(0).get('apikey')).toBe(SECRET)

    await fetchWith(new Request(`${SUPABASE}/auth/v1/user`, { headers: { apikey: ANON, Authorization: `Bearer ${USER_JWT}` } }))
    const fromRequest = sentHeaders(1)
    expect(fromRequest.get('apikey')).toBe(SECRET)
    expect(fromRequest.get('authorization')).toBe(`Bearer ${USER_JWT}`)
    expect(fromRequest.get(FORWARDED_FOR_HEADER)).toBe('198.51.100.4')
  })
})

describe('client IP extraction', () => {
  it('takes the first x-forwarded-for hop, then x-real-ip', () => {
    expect(clientIpFromHeaders(new Headers({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }))).toBe('203.0.113.7')
    expect(clientIpFromHeaders(new Headers({ 'x-real-ip': '2001:db8::42' }))).toBe('2001:db8::42')
    expect(clientIpFromHeaders(new Headers())).toBeNull()
    expect(clientIpFromHeaders(null)).toBeNull()
  })

  it('drops a first hop that is not an address instead of falling through to another header', () => {
    expect(clientIpFromHeaders(new Headers({ 'x-forwarded-for': 'evil, 203.0.113.7', 'x-real-ip': '203.0.113.8' }))).toBeNull()
  })

  it('accepts only bare IPv4 and IPv6 addresses', () => {
    for (const ok of ['203.0.113.7', '0.0.0.0', '255.255.255.255', '::1', '2001:db8::1', '::ffff:192.0.2.1']) {
      expect(isIpAddress(ok)).toBe(true)
    }
    for (const bad of ['256.1.1.1', '1.2.3', '1', '0x7f.1', '1.2.3.4:80', '[::1]', 'fe80::1%eth0', 'localhost', '2001:db8::g', '', 'a'.repeat(60)]) {
      expect(isIpAddress(bad)).toBe(false)
    }
  })
})
