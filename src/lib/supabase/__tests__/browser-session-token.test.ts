import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearBrowserAccessToken,
  getBrowserAccessToken,
  onBrowserAccessTokenChange,
  onBrowserSessionLost,
  resetBrowserSessionTokenForTests,
} from '../browser-session-token'

const NOW = 1_790_000_000_000

function tokenResponse(accessToken: string, expiresIn = 3600): Response {
  return new Response(JSON.stringify({ data: { accessToken, expiresAt: 0, expiresIn } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

let fetchMock: ReturnType<typeof vi.fn>
let now = NOW

beforeEach(() => {
  resetBrowserSessionTokenForTests()
  now = NOW
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('window', {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('browser session token store', () => {
  it('fetches the token from the same-origin endpoint, uncached, and keeps it in memory', async () => {
    fetchMock.mockResolvedValue(tokenResponse('t1'))

    await expect(getBrowserAccessToken()).resolves.toBe('t1')
    await expect(getBrowserAccessToken()).resolves.toBe('t1')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/session-token',
      expect.objectContaining({ credentials: 'same-origin', cache: 'no-store' }),
    )
  })

  it('shares one request between concurrent callers', async () => {
    let resolve!: (response: Response) => void
    fetchMock.mockReturnValue(new Promise<Response>((r) => { resolve = r }))

    const calls = [getBrowserAccessToken(), getBrowserAccessToken(), getBrowserAccessToken()]
    resolve(tokenResponse('shared'))

    await expect(Promise.all(calls)).resolves.toEqual(['shared', 'shared', 'shared'])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('refreshes about a minute before expiry, on the next use', async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse('t1', 3600)).mockResolvedValueOnce(tokenResponse('t2', 3600))
    const changes: Array<string | null> = []
    onBrowserAccessTokenChange((token) => changes.push(token))

    await getBrowserAccessToken()
    now += (3600 - 61) * 1000
    await expect(getBrowserAccessToken()).resolves.toBe('t1')
    now += 2_000
    await expect(getBrowserAccessToken()).resolves.toBe('t2')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(changes).toEqual(['t1', 't2'])
  })

  it('uses the server expires_in, so a skewed browser clock cannot cause a refresh storm', async () => {
    // expiresAt in the payload is 0 (as if the browser clock were far ahead);
    // only expiresIn counts.
    fetchMock.mockResolvedValue(tokenResponse('t1', 3600))

    await getBrowserAccessToken()
    await getBrowserAccessToken()

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('on 401 empties itself and reports the lost session', async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse('t1', 30)).mockResolvedValueOnce(new Response('{}', { status: 401 }))
    const lost = vi.fn()
    onBrowserSessionLost(lost)

    await getBrowserAccessToken()
    // A token that arrives with under a minute left is not re-requested at
    // once; past the short back-off the next use asks again.
    now += 6_000
    await expect(getBrowserAccessToken()).resolves.toBeNull()

    expect(lost).toHaveBeenCalledWith('unauthenticated')
  })

  it('leaves a session-timeout 401 to the timeout controller (broadcast, no generic loss)', async () => {
    const posted: unknown[] = []
    class FakeChannel {
      postMessage(message: unknown) { posted.push(message) }
      close() {}
    }
    vi.stubGlobal('BroadcastChannel', FakeChannel)
    fetchMock.mockResolvedValue(
      new Response('{}', { status: 401, headers: { 'x-session-timeout-reason': 'idle' } }),
    )
    const lost = vi.fn()
    onBrowserSessionLost(lost)

    await expect(getBrowserAccessToken()).resolves.toBeNull()

    expect(posted).toEqual([{ type: 'expired', reason: 'idle' }])
    expect(lost).not.toHaveBeenCalled()
  })

  it('reports an owed MFA step-up on 403 and hands out nothing', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 403 }))
    const lost = vi.fn()
    onBrowserSessionLost(lost)

    await expect(getBrowserAccessToken()).resolves.toBeNull()
    expect(lost).toHaveBeenCalledWith('mfa_required')
  })

  it('keeps serving an unexpired token through a network blip and backs off', async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse('t1', 50)).mockRejectedValueOnce(new TypeError('offline'))

    await getBrowserAccessToken()
    now += 6_000
    await expect(getBrowserAccessToken()).resolves.toBe('t1')
    // Within the back-off window no new request goes out.
    await expect(getBrowserAccessToken()).resolves.toBe('t1')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('clear() forgets the token so the next use asks the server again', async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse('t1')).mockResolvedValueOnce(tokenResponse('t2'))

    await getBrowserAccessToken()
    clearBrowserAccessToken()
    await expect(getBrowserAccessToken()).resolves.toBe('t2')
  })

  it('never fetches outside a browser (server rendering)', async () => {
    vi.stubGlobal('window', undefined)
    await expect(getBrowserAccessToken()).resolves.toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
