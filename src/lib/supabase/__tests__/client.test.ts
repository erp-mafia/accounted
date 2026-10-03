import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The browser client never holds a session: supabase-js's `accessToken`
 * option supplies the server-issued token to PostgREST and Realtime, and
 * `auth` is unusable. These tests pin the two behaviours the switch depends
 * on: requests carry the token, and Realtime keeps re-reading it (supabase-js
 * would otherwise mark the first token as manually set and never refresh
 * long-lived channels).
 */

const tokenState = vi.hoisted(() => ({
  token: 'token-1' as string | null,
  listeners: new Set<(token: string | null) => void>(),
}))

vi.mock('@/lib/supabase/browser-session-token', () => ({
  getBrowserAccessToken: vi.fn(async () => tokenState.token),
  onBrowserAccessTokenChange: (listener: (token: string | null) => void) => {
    tokenState.listeners.add(listener)
    return () => tokenState.listeners.delete(listener)
  },
}))

async function flush() {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.resetModules()
  tokenState.token = 'token-1'
  tokenState.listeners.clear()
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.co')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key')
  vi.stubGlobal('window', {})
  // supabase-js builds its Realtime client eagerly, and that needs a
  // WebSocket constructor. Browsers always have one; CI's Node 20 does not.
  // No test here opens a socket, so an empty class is enough.
  vi.stubGlobal('WebSocket', class FakeWebSocket {})
  fetchMock = vi.fn(async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('browser Supabase client', () => {
  it('is a per-page singleton', async () => {
    const { createClient } = await import('../client')
    expect(createClient()).toBe(createClient())
  })

  it('has no usable auth client', async () => {
    const { createClient } = await import('../client')
    const client = createClient() as unknown as { auth: { getUser: () => unknown } }
    expect(() => client.auth.getUser()).toThrow(/accessToken option/)
  })

  it('sends the server-issued access token on PostgREST requests', async () => {
    const { createClient } = await import('../client')
    await createClient().from('companies').select('id')

    const [, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit]
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer token-1')
  })

  it('falls back to the anon key when there is no session', async () => {
    tokenState.token = null
    const { createClient } = await import('../client')
    await createClient().from('companies').select('id')

    const [, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit]
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer anon-key')
  })

  it('keeps Realtime on the token callback, so channels receive rotated tokens', async () => {
    const { createClient } = await import('../client')
    const client = createClient()
    await flush()

    const realtime = client.realtime as unknown as {
      _isManualToken(): boolean
      accessTokenValue: string | null
    }
    expect(realtime._isManualToken()).toBe(false)
    expect(realtime.accessTokenValue).toBe('token-1')

    // A rotation reaches Realtime through the change listener (and on the
    // next heartbeat through the callback).
    tokenState.token = 'token-2'
    for (const listener of tokenState.listeners) listener('token-2')
    await flush()

    expect(realtime._isManualToken()).toBe(false)
    expect(realtime.accessTokenValue).toBe('token-2')
  })
})
