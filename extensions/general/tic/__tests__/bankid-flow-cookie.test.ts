import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  BANKID_FLOW_COOKIE,
  FLOW_VERIFIED_WINDOW_SECONDS,
  FLOW_WINDOW_SECONDS,
  clearBankIdFlowCookies,
  isBankIdFlowMode,
  readBankIdFlow,
  setBankIdFlowCookies,
  signBankIdFlow,
  verifyBankIdFlow,
  type BankIdFlowState,
} from '../lib/bankid-flow-cookie'

const TEST_KEY = 'a'.repeat(64)
const T0 = 1_700_000_000_000

const STATE: BankIdFlowState = {
  version: 1,
  sessionId: 'sess-1',
  flowId: 'flow-1',
  mode: 'signup',
  startedAt: T0,
  expiresAt: T0 + FLOW_WINDOW_SECONDS * 1000,
}

beforeEach(() => {
  vi.stubEnv('BANKID_ENCRYPTION_KEY', TEST_KEY)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

/** Parse the Set-Cookie headers a handler attached to its response. */
function setCookies(response: NextResponse): Map<string, { value: string; attrs: string }> {
  const result = new Map<string, { value: string; attrs: string }>()
  for (const header of response.headers.getSetCookie()) {
    const [pair, ...attrs] = header.split(';')
    const separator = pair.indexOf('=')
    result.set(pair.slice(0, separator).trim(), {
      value: decodeURIComponent(pair.slice(separator + 1)),
      attrs: attrs.join(';'),
    })
  }
  return result
}

function cookieHeader(value: string, name = BANKID_FLOW_COOKIE): Request {
  return new Request('http://localhost:3000/x', {
    headers: { cookie: `${name}=${encodeURIComponent(value)}` },
  })
}

describe('sign / verify', () => {
  it('round-trips a flow', async () => {
    const signed = await signBankIdFlow(STATE)
    expect(await verifyBankIdFlow(signed, process.env, T0 + 1000)).toEqual(STATE)
  })

  it('carries the owner of a link flow', async () => {
    const link: BankIdFlowState = { ...STATE, mode: 'link', userId: 'user-1' }
    expect(await verifyBankIdFlow(await signBankIdFlow(link), process.env, T0)).toEqual(link)
  })

  it('rejects a link flow with no owner', async () => {
    // An unowned link flow is the shape that binds one person's personnummer
    // to the next person to use a shared browser.
    const signed = await signBankIdFlow({ ...STATE, mode: 'link' })
    expect(await verifyBankIdFlow(signed, process.env, T0)).toBeNull()
  })

  it('does not put the session id in the clear', async () => {
    const signed = await signBankIdFlow(STATE)
    expect(signed).not.toContain('sess-1')
    expect(signed.split('.')).toHaveLength(2)
  })

  it('rejects a tampered payload', async () => {
    const signed = await signBankIdFlow(STATE)
    const [, signature] = signed.split('.')
    const forged = Buffer.from(
      JSON.stringify({ ...STATE, sessionId: 'attacker-session' }),
    ).toString('base64url')

    expect(await verifyBankIdFlow(`${forged}.${signature}`, process.env, T0)).toBeNull()
  })

  it('rejects an unsigned cookie a script could plant', async () => {
    const payload = Buffer.from(JSON.stringify(STATE)).toString('base64url')
    expect(await verifyBankIdFlow(payload, process.env, T0)).toBeNull()
    expect(await verifyBankIdFlow(`${payload}.`, process.env, T0)).toBeNull()
    expect(await verifyBankIdFlow(`${payload}.x`, process.env, T0)).toBeNull()
  })

  it('rejects a cookie signed with a different secret', async () => {
    const signed = await signBankIdFlow(STATE, { BANKID_ENCRYPTION_KEY: 'b'.repeat(64) })
    expect(await verifyBankIdFlow(signed, process.env, T0)).toBeNull()
  })

  it('rejects malformed and empty values', async () => {
    expect(await verifyBankIdFlow(undefined, process.env, T0)).toBeNull()
    expect(await verifyBankIdFlow('', process.env, T0)).toBeNull()
    expect(await verifyBankIdFlow('not.a.cookie', process.env, T0)).toBeNull()
    expect(await verifyBankIdFlow('....', process.env, T0)).toBeNull()
  })

  it('expires on the server clock, not the browser Max-Age', async () => {
    const signed = await signBankIdFlow(STATE)
    expect(await verifyBankIdFlow(signed, process.env, STATE.expiresAt)).toEqual(STATE)
    expect(await verifyBankIdFlow(signed, process.env, STATE.expiresAt + 1)).toBeNull()
  })

  it('refuses an expiry further out than the longest window this server issues', async () => {
    const signed = await signBankIdFlow({ ...STATE, expiresAt: T0 + 24 * 3600 * 1000 })
    expect(await verifyBankIdFlow(signed, process.env, T0)).toBeNull()
  })

  it('accepts the verified window, which the e-mail step needs', async () => {
    const verified = { ...STATE, expiresAt: T0 + FLOW_VERIFIED_WINDOW_SECONDS * 1000 }
    expect(await verifyBankIdFlow(await signBankIdFlow(verified), process.env, T0)).toEqual(verified)
  })

  it('caps the whole flow from startedAt, so re-issuing cannot extend it forever', async () => {
    // /poll pushes expiresAt out when it sees a completed identification.
    // Without a cap measured from the original start, polling in a loop would
    // keep a usable identification alive for as long as TIC retains it.
    // MAX_TOTAL_LIFE is FLOW_WINDOW + FLOW_VERIFIED_WINDOW from startedAt.
    const cap = (FLOW_WINDOW_SECONDS + FLOW_VERIFIED_WINDOW_SECONDS) * 1000
    // A cookie re-issued near the cap is still honoured up to it...
    const late = { ...STATE, expiresAt: T0 + cap + 60_000 }
    const signed = await signBankIdFlow(late)
    expect(await verifyBankIdFlow(signed, process.env, T0 + cap)).toEqual(late)
    // ...and dies the moment the flow as a whole is older than the cap, no
    // matter how far out the latest re-issue pushed expiresAt.
    expect(await verifyBankIdFlow(signed, process.env, T0 + cap + 1)).toBeNull()
  })

  it('rejects a startedAt in the future, which would never age out', async () => {
    const signed = await signBankIdFlow({ ...STATE, startedAt: T0 + 60_000 })
    expect(await verifyBankIdFlow(signed, process.env, T0)).toBeNull()
  })

  it('rejects an unknown mode', async () => {
    const signed = await signBankIdFlow({ ...STATE, mode: 'admin' as never })
    expect(await verifyBankIdFlow(signed, process.env, T0)).toBeNull()
  })

  it('rejects a flow with no tab-binding id', async () => {
    const signed = await signBankIdFlow({ ...STATE, flowId: undefined as never })
    expect(await verifyBankIdFlow(signed, process.env, T0)).toBeNull()
  })

  it('rejects an unknown version, so a future format cannot be replayed as this one', async () => {
    const signed = await signBankIdFlow({ ...STATE, version: 2 as never })
    expect(await verifyBankIdFlow(signed, process.env, T0)).toBeNull()
  })

  it('refuses to run without a signing secret rather than falling back to unsigned', async () => {
    const empty = {}
    await expect(signBankIdFlow(STATE, empty)).rejects.toThrow(/requires BANKID_ENCRYPTION_KEY/)
    expect(await verifyBankIdFlow(await signBankIdFlow(STATE), empty, T0)).toBeNull()
  })
})

describe('isBankIdFlowMode', () => {
  it('accepts exactly the three flows', () => {
    expect(isBankIdFlowMode('login')).toBe(true)
    expect(isBankIdFlowMode('signup')).toBe(true)
    expect(isBankIdFlowMode('link')).toBe(true)
    expect(isBankIdFlowMode('unlink')).toBe(false)
    expect(isBankIdFlowMode('')).toBe(false)
    expect(isBankIdFlowMode(undefined)).toBe(false)
  })
})

describe('readBankIdFlow', () => {
  it('reads its own cookie out of a header carrying others', async () => {
    const signed = await signBankIdFlow({ ...STATE, startedAt: Date.now(), expiresAt: Date.now() + 60_000 })
    const request = new Request('http://localhost:3000/x', {
      headers: {
        cookie: `sb-access-token=abc; ${BANKID_FLOW_COOKIE}=${encodeURIComponent(signed)}; other=1`,
      },
    })
    expect((await readBankIdFlow(request))?.sessionId).toBe('sess-1')
  })

  it('fails closed when two cookies of this name arrive', async () => {
    // The shadowing attack: a script plants the same name at a longer path, and
    // RFC 6265 sends longer paths FIRST. Taking the first match would use the
    // planted one. The __Host- prefix should make this unreachable; being wrong
    // about that must not silently hand the flow to the attacker's cookie.
    const mine = await signBankIdFlow({ ...STATE, startedAt: Date.now(), expiresAt: Date.now() + 60_000 })
    const planted = await signBankIdFlow({
      ...STATE,
      sessionId: 'attacker-session',
      startedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    })
    const request = new Request('http://localhost:3000/x', {
      headers: {
        cookie:
          `${BANKID_FLOW_COOKIE}=${encodeURIComponent(planted)}; ` +
          `${BANKID_FLOW_COOKIE}=${encodeURIComponent(mine)}`,
      },
    })

    expect(await readBankIdFlow(request)).toBeNull()
  })

  it('returns null with no cookie header and for a foreign cookie name', async () => {
    expect(await readBankIdFlow(new Request('http://localhost:3000/x'))).toBeNull()
    const signed = await signBankIdFlow({ ...STATE, startedAt: Date.now(), expiresAt: Date.now() + 60_000 })
    expect(await readBankIdFlow(cookieHeader(signed, 'accounted-bankid-active'))).toBeNull()
  })
})

describe('cookie attributes', () => {
  it('is a __Host- cookie: HttpOnly, Secure, Lax, Path=/, no Domain', async () => {
    const response = NextResponse.json({})
    const expiresAt = Date.now() + FLOW_WINDOW_SECONDS * 1000
    await setBankIdFlowCookies(response, { ...STATE, startedAt: Date.now(), expiresAt })

    const flow = setCookies(response).get(BANKID_FLOW_COOKIE)!
    expect(BANKID_FLOW_COOKIE.startsWith('__Host-')).toBe(true)
    expect(flow.attrs).toMatch(/HttpOnly/i)
    // Unconditional: __Host- requires it, and BankID is disabled on self-hosted
    // so there is no plain-http deployment to accommodate.
    expect(flow.attrs).toMatch(/Secure/i)
    expect(flow.attrs).toMatch(/Path=\/(;|$)/i)
    expect(flow.attrs).not.toMatch(/Domain=/i)
    // Lax, not Strict: the BankID app returns the user by a top-level
    // navigation from outside the site, and Strict would drop the cookie there.
    expect(flow.attrs).toMatch(/SameSite=lax/i)
    expect(flow.attrs).not.toMatch(/SameSite=strict/i)
  })

  it('mirrors the signed expiry in Max-Age', async () => {
    const response = NextResponse.json({})
    const now = Date.now()
    await setBankIdFlowCookies(response, { ...STATE, startedAt: now, expiresAt: now + 120_000 }, process.env, now)

    expect(setCookies(response).get(BANKID_FLOW_COOKIE)!.attrs).toMatch(/Max-Age=120/i)
  })

  it('never emits a non-positive Max-Age for an almost-expired flow', async () => {
    // Max-Age=0 would mean "delete", which would drop a flow that is still
    // valid for a few hundred milliseconds.
    const response = NextResponse.json({})
    const now = Date.now()
    await setBankIdFlowCookies(response, { ...STATE, startedAt: now, expiresAt: now + 100 }, process.env, now)

    expect(setCookies(response).get(BANKID_FLOW_COOKIE)!.attrs).toMatch(/Max-Age=1(;|$)/i)
  })

  it('clears with the same name and attributes it set', () => {
    const response = NextResponse.json({})
    clearBankIdFlowCookies(response)

    const flow = setCookies(response).get(BANKID_FLOW_COOKIE)!
    // A deletion that differs on path or attributes leaves the real cookie.
    expect(flow.attrs).toMatch(/Path=\/(;|$)/i)
    expect(flow.attrs).toMatch(/HttpOnly/i)
    expect(flow.attrs).toMatch(/Secure/i)
    expect(flow.attrs).toMatch(/Max-Age=0/i)
  })
})
