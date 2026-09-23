import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  consumeInviteCookie,
  classifyInviteAcceptStatus,
  isDefinitiveInviteDisposition,
  readInviteCookie,
  INVITE_COOKIE_NAME,
  INVITE_PROBLEM_MESSAGE_KEYS,
} from '../consume-invite-cookie'

/**
 * Minimal document.cookie stand-in. Vitest runs in the node env, so there is
 * no DOM: this models the one behaviour the helper depends on, namely that
 * assigning `name=; max-age=0` removes the entry.
 */
function installCookieJar(initial: Record<string, string> = {}) {
  const jar = new Map(Object.entries(initial))

  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      get cookie() {
        return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
      },
      set cookie(raw: string) {
        const [pair, ...attrs] = raw.split(';').map((s) => s.trim())
        const eq = pair.indexOf('=')
        const name = pair.slice(0, eq)
        const value = pair.slice(eq + 1)
        const expiring = attrs.some((a) => /^max-age=0$/i.test(a))
        if (expiring || value === '') {
          jar.delete(name)
        } else {
          jar.set(name, value)
        }
      },
    },
  })

  return jar
}

const TOKEN = 'gnubok_inv_Zm9vYmFyLXRva2Vu'

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  Reflect.deleteProperty(globalThis, 'document')
  vi.restoreAllMocks()
})

function respondWith(status: number) {
  fetchMock.mockResolvedValue({ status, ok: status >= 200 && status < 300 })
}

describe('classifyInviteAcceptStatus', () => {
  it('treats 2xx and 409 (already a member) as accepted', () => {
    expect(classifyInviteAcceptStatus(200)).toBe('accepted')
    expect(classifyInviteAcceptStatus(204)).toBe('accepted')
    expect(classifyInviteAcceptStatus(409)).toBe('accepted')
  })

  it('treats 400, 404 and 410 as a spent or invalid token', () => {
    expect(classifyInviteAcceptStatus(400)).toBe('spent')
    expect(classifyInviteAcceptStatus(404)).toBe('spent')
    expect(classifyInviteAcceptStatus(410)).toBe('spent')
  })

  it('treats 403 email mismatch as its own case, not spent', () => {
    expect(classifyInviteAcceptStatus(403)).toBe('wrong_email')
    expect(isDefinitiveInviteDisposition('wrong_email')).toBe(false)
  })

  it('treats session races, rate limits and server errors as retryable', () => {
    for (const status of [401, 408, 425, 429, 500, 502, 503, 504]) {
      expect(classifyInviteAcceptStatus(status)).toBe('retryable')
      expect(isDefinitiveInviteDisposition('retryable')).toBe(false)
    }
  })

  it('marks only accepted and spent as definitive', () => {
    expect(isDefinitiveInviteDisposition('accepted')).toBe(true)
    expect(isDefinitiveInviteDisposition('spent')).toBe(true)
  })
})

describe('readInviteCookie', () => {
  it('reads the token out of the cookie jar', () => {
    installCookieJar({ 'sb-access-token': 'x', [INVITE_COOKIE_NAME]: TOKEN })
    expect(readInviteCookie()).toBe(TOKEN)
  })

  it('returns null when no invite cookie is present', () => {
    installCookieJar({ 'sb-access-token': 'x' })
    expect(readInviteCookie()).toBeNull()
  })

  it('does not match a differently-named cookie sharing the suffix', () => {
    installCookieJar({ [`x-${INVITE_COOKIE_NAME}`]: 'not-the-invite' })
    expect(readInviteCookie()).toBeNull()
  })

  it('returns null without a DOM (server render)', () => {
    expect(readInviteCookie()).toBeNull()
  })
})

describe('consumeInviteCookie', () => {
  it('does nothing when there is no invite cookie', async () => {
    installCookieJar({})

    const result = await consumeInviteCookie()

    expect(result).toEqual({
      attempted: false,
      disposition: null,
      accepted: false,
      cleared: false,
      problem: null,
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('happy path: posts the token, clears the cookie, reports accepted', async () => {
    const jar = installCookieJar({ [INVITE_COOKIE_NAME]: TOKEN })
    respondWith(200)

    const result = await consumeInviteCookie()

    expect(fetchMock).toHaveBeenCalledWith('/api/team/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: TOKEN }),
    })
    expect(result.accepted).toBe(true)
    expect(result.problem).toBeNull()
    expect(result.cleared).toBe(true)
    expect(jar.has(INVITE_COOKIE_NAME)).toBe(false)
  })

  it('already a member (409) counts as accepted and clears', async () => {
    const jar = installCookieJar({ [INVITE_COOKIE_NAME]: TOKEN })
    respondWith(409)

    const result = await consumeInviteCookie()

    expect(result.accepted).toBe(true)
    expect(jar.has(INVITE_COOKIE_NAME)).toBe(false)
  })

  it('definitively invalid (400) clears the cookie and reports the problem', async () => {
    const jar = installCookieJar({ [INVITE_COOKIE_NAME]: TOKEN })
    respondWith(400)

    const result = await consumeInviteCookie()

    expect(result.accepted).toBe(false)
    expect(result.disposition).toBe('spent')
    expect(result.problem).toBe('spent')
    expect(result.cleared).toBe(true)
    expect(jar.has(INVITE_COOKIE_NAME)).toBe(false)
  })

  it('expired invitation (410) clears the cookie', async () => {
    const jar = installCookieJar({ [INVITE_COOKIE_NAME]: TOKEN })
    respondWith(410)

    const result = await consumeInviteCookie()

    expect(result.problem).toBe('spent')
    expect(jar.has(INVITE_COOKIE_NAME)).toBe(false)
  })

  // The finding: a transient failure used to destroy the token.
  it('transient 500 RETAINS the token and reports it', async () => {
    const jar = installCookieJar({ [INVITE_COOKIE_NAME]: TOKEN })
    respondWith(500)

    const result = await consumeInviteCookie()

    expect(result.accepted).toBe(false)
    expect(result.disposition).toBe('retryable')
    expect(result.problem).toBe('retryable')
    expect(result.cleared).toBe(false)
    expect(jar.get(INVITE_COOKIE_NAME)).toBe(TOKEN)
  })

  it('session not yet propagated (401) RETAINS the token', async () => {
    const jar = installCookieJar({ [INVITE_COOKIE_NAME]: TOKEN })
    respondWith(401)

    const result = await consumeInviteCookie()

    expect(result.problem).toBe('retryable')
    expect(result.cleared).toBe(false)
    expect(jar.get(INVITE_COOKIE_NAME)).toBe(TOKEN)
  })

  it('network throw RETAINS the token and reports it', async () => {
    const jar = installCookieJar({ [INVITE_COOKIE_NAME]: TOKEN })
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))

    const result = await consumeInviteCookie()

    expect(result.accepted).toBe(false)
    expect(result.disposition).toBe('retryable')
    expect(result.problem).toBe('retryable')
    expect(result.cleared).toBe(false)
    expect(jar.get(INVITE_COOKIE_NAME)).toBe(TOKEN)
  })

  it('email mismatch (403) RETAINS the token so the right account can still use it', async () => {
    const jar = installCookieJar({ [INVITE_COOKIE_NAME]: TOKEN })
    respondWith(403)

    const result = await consumeInviteCookie()

    expect(result.accepted).toBe(false)
    expect(result.disposition).toBe('wrong_email')
    expect(result.problem).toBe('wrong_email')
    expect(result.cleared).toBe(false)
    expect(jar.get(INVITE_COOKIE_NAME)).toBe(TOKEN)
  })

  it('accepts an out-of-band token without reading the cookie', async () => {
    installCookieJar({})
    respondWith(200)

    const result = await consumeInviteCookie({ token: 'gnubok_inv_from-the-url' })

    expect(result.accepted).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/team/accept',
      expect.objectContaining({ body: JSON.stringify({ token: 'gnubok_inv_from-the-url' }) }),
    )
  })

  it('every problem disposition has a message key pair', async () => {
    for (const problem of ['retryable', 'wrong_email', 'spent'] as const) {
      expect(INVITE_PROBLEM_MESSAGE_KEYS[problem].title).toBeTruthy()
      expect(INVITE_PROBLEM_MESSAGE_KEYS[problem].body).toBeTruthy()
    }
  })
})

/**
 * Control: the pre-fix logic, copied verbatim from what login/register/mfa
 * used to inline. It clears the cookie on the `!res.ok` fall-through and on
 * the throw, and never tells the user anything. Running the retention
 * expectations against it proves the tests above are actually load-bearing
 * and not passing by construction.
 */
async function legacyInviteHandling(): Promise<{ accepted: boolean; problem: string | null }> {
  const cookieMatch = document.cookie.match(/gnubok-invite-token=([^;]+)/)
  const inviteToken = cookieMatch?.[1]

  if (inviteToken) {
    try {
      const res = await fetch('/api/team/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: inviteToken }),
      })

      if (res.ok) {
        document.cookie = 'gnubok-invite-token=; path=/; max-age=0'
        return { accepted: true, problem: null }
      }
    } catch {
      // swallowed
    }
    // Clear cookie even on failure to avoid retrying stale tokens
    document.cookie = 'gnubok-invite-token=; path=/; max-age=0'
  }

  return { accepted: false, problem: null }
}

describe('regression control: the old unconditional-clear logic', () => {
  it('fails the transient-500 retention expectation', async () => {
    const jar = installCookieJar({ [INVITE_COOKIE_NAME]: TOKEN })
    respondWith(500)

    const legacy = await legacyInviteHandling()

    // What the new tests assert, and what the old code does not do:
    expect(jar.get(INVITE_COOKIE_NAME)).toBeUndefined() // token destroyed
    expect(legacy.problem).toBeNull() // user told nothing
  })

  it('fails the network-throw retention expectation', async () => {
    const jar = installCookieJar({ [INVITE_COOKIE_NAME]: TOKEN })
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))

    await legacyInviteHandling()

    expect(jar.get(INVITE_COOKIE_NAME)).toBeUndefined() // token destroyed
  })

  it('fails the 403 email-mismatch retention expectation', async () => {
    const jar = installCookieJar({ [INVITE_COOKIE_NAME]: TOKEN })
    respondWith(403)

    await legacyInviteHandling()

    expect(jar.get(INVITE_COOKIE_NAME)).toBeUndefined() // token destroyed
  })
})
