import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  clearToken: vi.fn(),
  clearStorage: vi.fn(() => []),
  resetAnalytics: vi.fn(),
  scrub: vi.fn(() => 0),
}))

vi.mock('@/lib/supabase/browser-session-token', () => ({ clearBrowserAccessToken: mocks.clearToken }))
vi.mock('@/lib/auth/clear-browser-storage', () => ({ clearBrowserStorage: mocks.clearStorage }))
vi.mock('@/lib/analytics/reset', () => ({ resetAnalyticsIdentity: mocks.resetAnalytics }))
vi.mock('@/lib/auth/browser-session-cookies', () => ({ scrubAuthCookies: mocks.scrub }))

import {
  fetchSessionUser,
  isInsufficientAal,
  onSignedOutElsewhere,
  signInWithPassword,
  signOut,
  signOutAndNavigate,
  verifyOtp,
} from '../session-client'

let fetchMock: ReturnType<typeof vi.fn>
const assign = vi.fn()

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

beforeEach(() => {
  vi.clearAllMocks()
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('window', { location: { assign, hostname: 'app.accounted.se', pathname: '/' } })
  vi.stubGlobal('document', { cookie: '' })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('sign-in helpers', () => {
  it('posts JSON to the login route and surfaces mfaRequired', async () => {
    fetchMock.mockResolvedValue(json(200, { data: { mfaRequired: true } }))

    const result = await signInWithPassword({ email: 'a@b.se', password: 'x', captchaToken: 'cf' })

    expect(result).toEqual({ error: null, mfaRequired: true })
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(path).toBe('/api/auth/login')
    expect(init.method).toBe('POST')
    expect(new Headers(init.headers).get('content-type')).toBe('application/json')
    expect(JSON.parse(init.body as string)).toEqual({ email: 'a@b.se', password: 'x', captchaToken: 'cf' })
  })

  it('returns the server error in the { code, message, status } shape classifyAuthError reads', async () => {
    fetchMock.mockResolvedValue(
      json(400, { error: { code: 'invalid_credentials', message: 'Fel e-post eller lösenord.', message_en: 'Wrong e-mail or password.' } }),
    )
    const { error } = await verifyOtp({ type: 'magiclink', token_hash: 'h' })
    expect(error).toEqual({
      code: 'invalid_credentials',
      message: 'Fel e-post eller lösenord.',
      message_en: 'Wrong e-mail or password.',
      status: 400,
    })
  })

  it('maps a plain-string rate-limit body and a network failure', async () => {
    fetchMock.mockResolvedValueOnce(json(429, { error: 'För många förfrågningar.' }))
    expect((await signInWithPassword({ email: 'a@b.se', password: 'x' })).error).toMatchObject({ status: 429 })

    fetchMock.mockRejectedValueOnce(new TypeError('offline'))
    expect((await signInWithPassword({ email: 'a@b.se', password: 'x' })).error).toMatchObject({ code: 'network_error', status: 0 })
  })

  it('recognises an AAL2 refusal by code or message', () => {
    expect(isInsufficientAal({ code: 'insufficient_aal', message: 'x', status: 403 })).toBe(true)
    expect(isInsufficientAal({ message: 'AAL2 required', status: 403 })).toBe(true)
    expect(isInsufficientAal({ message: 'nope', status: 400 })).toBe(false)
    expect(isInsufficientAal(null)).toBe(false)
  })
})

describe('fetchSessionUser', () => {
  it('returns the user, or null without a session', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { data: { id: 'u1', email: 'a@b.se' } }))
    await expect(fetchSessionUser()).resolves.toMatchObject({ id: 'u1' })

    fetchMock.mockResolvedValueOnce(json(401, { error: { code: 'unauthorized', message: 'x' } }))
    await expect(fetchSessionUser()).resolves.toBeNull()
  })
})

describe('signOut (CASA 6.6.1)', () => {
  it('asks the server to revoke, then clears token, storage, analytics identity and stray cookies', async () => {
    fetchMock.mockResolvedValue(json(200, { data: { revoked: true } }))

    const result = await signOut()

    expect(result.error).toBeNull()
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(path).toBe('/api/auth/logout')
    expect(JSON.parse(init.body as string)).toEqual({ scope: 'global' })
    expect(mocks.clearToken).toHaveBeenCalled()
    expect(mocks.clearStorage).toHaveBeenCalled()
    expect(mocks.resetAnalytics).toHaveBeenCalled()
    expect(mocks.scrub).toHaveBeenCalled()
  })

  it('treats a 401 (session already gone) as success', async () => {
    fetchMock.mockResolvedValue(json(401, { error: { code: 'SESSION_EXPIRED', message: 'x' } }))
    await expect(signOut({ scope: 'local' })).resolves.toEqual({ error: null })
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({ scope: 'local' })
  })

  it('reports an unreachable server, and still clears the browser', async () => {
    fetchMock.mockRejectedValue(new TypeError('offline'))
    const { error } = await signOut()
    expect(error?.code).toBe('network_error')
    expect(mocks.clearStorage).toHaveBeenCalled()
  })

  it('tells the other tabs, which clear their own state', async () => {
    const posted: unknown[] = []
    class FakeChannel {
      onmessage: ((event: { data: unknown }) => void) | null = null
      constructor(public name: string) {}
      postMessage(message: unknown) { posted.push(message) }
      close() {}
    }
    vi.stubGlobal('BroadcastChannel', FakeChannel)
    fetchMock.mockResolvedValue(json(200, { data: { revoked: true } }))

    await signOut()

    expect(posted).toEqual([{ type: 'signed-out', from: expect.any(String) }])
  })

  it('does not announce a sign-out the server never received', async () => {
    const posted: unknown[] = []
    vi.stubGlobal('BroadcastChannel', class {
      postMessage(message: unknown) { posted.push(message) }
      close() {}
    })
    fetchMock.mockRejectedValue(new TypeError('offline'))

    await signOut()

    expect(posted).toEqual([])
  })

  it('onSignedOutElsewhere fires on the announcement only', async () => {
    const instances: Array<{ onmessage: ((event: { data: unknown }) => void) | null }> = []
    vi.stubGlobal('BroadcastChannel', class {
      onmessage: ((event: { data: unknown }) => void) | null = null
      constructor() { instances.push(this) }
      postMessage() {}
      close() {}
    })
    const listener = vi.fn()
    const stop = onSignedOutElsewhere(listener)

    instances[0].onmessage?.({ data: { type: 'other', from: 'another-tab' } })
    instances[0].onmessage?.({ data: { type: 'signed-out', from: 'another-tab' } })

    expect(listener).toHaveBeenCalledTimes(1)
    stop()
  })

  it("ignores this tab's own announcement (it is already leaving for its own destination)", async () => {
    const instances: Array<{ onmessage: ((event: { data: unknown }) => void) | null }> = []
    const posted: unknown[] = []
    vi.stubGlobal('BroadcastChannel', class {
      onmessage: ((event: { data: unknown }) => void) | null = null
      constructor() { instances.push(this) }
      postMessage(message: unknown) { posted.push(message) }
      close() {}
    })
    const listener = vi.fn()
    onSignedOutElsewhere(listener)
    fetchMock.mockResolvedValue(json(200, { data: { revoked: true } }))

    await signOut()
    // Deliver the tab's own message to its own listener, as a browser would.
    instances[0].onmessage?.({ data: posted[0] })

    expect(listener).not.toHaveBeenCalled()
  })

  it('signOutAndNavigate leaves with a full page load', async () => {
    fetchMock.mockResolvedValue(json(200, { data: { revoked: true } }))
    await signOutAndNavigate('/login')
    expect(assign).toHaveBeenCalledWith('/login')
  })
})
