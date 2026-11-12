import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import {
  RATE_LIMIT_COOLDOWN_MS,
  REFRESH_REPLAY_MS,
  USER_REPLAY_MS,
  budgetedAuthFetch,
  createAuthServiceWatch,
  resetAuthCallBudgetForTests,
} from '../auth-call-budget'

const ORIGIN = 'https://abcdefgh.supabase.co'
const REFRESH_URL = `${ORIGIN}/auth/v1/token?grant_type=refresh_token`
const USER_URL = `${ORIGIN}/auth/v1/user`

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function refreshInit(refreshToken: string): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
  }
}

function userInit(accessToken: string): RequestInit {
  return { method: 'GET', headers: { Authorization: `Bearer ${accessToken}` } }
}

beforeEach(() => {
  resetAuthCallBudgetForTests()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-11T14:11:46Z'))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('refresh budget', () => {
  it('asks once for the same refresh token and replays the answer for the reuse interval', async () => {
    const base = vi.fn(async () => json(200, { access_token: 'a1', refresh_token: 'r1' }))
    const fetcher = budgetedAuthFetch(base as unknown as typeof fetch)

    const answers = []
    for (let i = 0; i < 50; i++) {
      const response = await fetcher(REFRESH_URL, refreshInit('r0'))
      answers.push(await response.json())
      vi.advanceTimersByTime(100)
    }

    expect(base).toHaveBeenCalledTimes(1)
    expect(answers.every((answer) => answer.refresh_token === 'r1')).toBe(true)

    vi.advanceTimersByTime(REFRESH_REPLAY_MS)
    await fetcher(REFRESH_URL, refreshInit('r0'))
    expect(base).toHaveBeenCalledTimes(2)
  })

  it('shares one call between concurrent callers', async () => {
    let release: (response: Response) => void = () => {}
    const base = vi.fn(() => new Promise<Response>((resolve) => { release = resolve }))
    const fetcher = budgetedAuthFetch(base as unknown as typeof fetch)

    const callers = Array.from({ length: 25 }, () => fetcher(REFRESH_URL, refreshInit('r0')))
    await vi.waitFor(() => expect(base).toHaveBeenCalledTimes(1))
    release(json(200, { refresh_token: 'r1' }))
    const bodies = await Promise.all(callers.map(async (caller) => (await caller).json()))

    expect(base).toHaveBeenCalledTimes(1)
    expect(bodies).toHaveLength(25)
    expect(bodies.every((body) => body.refresh_token === 'r1')).toBe(true)
  })

  it('hands back the decoded answer without the headers that described its bytes on the wire', async () => {
    const base = vi.fn(async () =>
      json(200, { refresh_token: 'r1' }, { 'content-encoding': 'gzip', 'content-length': '17', 'x-sb-error-code': 'kept' }),
    )
    const fetcher = budgetedAuthFetch(base as unknown as typeof fetch)

    const response = await fetcher(REFRESH_URL, refreshInit('r0'))

    expect(response.headers.get('content-encoding')).toBeNull()
    expect(response.headers.get('content-length')).toBeNull()
    expect(response.headers.get('x-sb-error-code')).toBe('kept')
    expect(response.headers.get('content-type')).toBe('application/json')
    expect((await response.json()).refresh_token).toBe('r1')
  })

  it('keeps one refresh token apart from another', async () => {
    const base = vi.fn(async (_url: string, init?: RequestInit) =>
      json(200, { refresh_token: `next-of-${JSON.parse(String(init?.body)).refresh_token}` }),
    )
    const fetcher = budgetedAuthFetch(base as unknown as typeof fetch)

    const first = await (await fetcher(REFRESH_URL, refreshInit('user-a'))).json()
    const second = await (await fetcher(REFRESH_URL, refreshInit('user-b'))).json()

    expect(base).toHaveBeenCalledTimes(2)
    expect(first.refresh_token).toBe('next-of-user-a')
    expect(second.refresh_token).toBe('next-of-user-b')
  })

  it('does not ask a rate-limited refresh again until the cooldown is over, and says so', async () => {
    const base = vi.fn(async () =>
      json(429, { code: 429, error_code: 'over_request_rate_limit', msg: 'Request rate limit reached' }),
    )

    for (let i = 0; i < 200; i++) {
      const watch = createAuthServiceWatch()
      const response = await budgetedAuthFetch(base as unknown as typeof fetch, { watch })(
        REFRESH_URL,
        refreshInit('r0'),
      )
      expect(response.status).toBe(429)
      // Every request learns it, the ones answered from memory included.
      expect(watch.unavailable).toBe(true)
      vi.advanceTimersByTime(10)
    }
    expect(base).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(RATE_LIMIT_COOLDOWN_MS)
    await budgetedAuthFetch(base as unknown as typeof fetch)(REFRESH_URL, refreshInit('r0'))
    expect(base).toHaveBeenCalledTimes(2)
  })

  it('waits as long as the auth service asks, within a minute', async () => {
    const base = vi.fn(async () => json(429, { error_code: 'over_request_rate_limit' }, { 'retry-after': '30' }))
    const watch = createAuthServiceWatch()
    const fetcher = budgetedAuthFetch(base as unknown as typeof fetch, { watch })

    await fetcher(REFRESH_URL, refreshInit('r0'))
    expect(watch.retryAfterSeconds).toBe(30)

    vi.advanceTimersByTime(29_000)
    await fetcher(REFRESH_URL, refreshInit('r0'))
    expect(base).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(2_000)
    await fetcher(REFRESH_URL, refreshInit('r0'))
    expect(base).toHaveBeenCalledTimes(2)
  })

  it('replays a refused token instead of asking about it again', async () => {
    const base = vi.fn(async () => json(400, { error_code: 'refresh_token_not_found' }))
    const watch = createAuthServiceWatch()
    const fetcher = budgetedAuthFetch(base as unknown as typeof fetch, { watch })

    for (let i = 0; i < 20; i++) expect((await fetcher(REFRESH_URL, refreshInit('dead'))).status).toBe(400)

    expect(base).toHaveBeenCalledTimes(1)
    // A refusal is an answer: the session is gone, the service is not.
    expect(watch.unavailable).toBe(false)
  })

  it('remembers nothing of a call that never got through, and reports it', async () => {
    const base = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    const watch = createAuthServiceWatch()
    const fetcher = budgetedAuthFetch(base as unknown as typeof fetch, { watch })

    await expect(fetcher(REFRESH_URL, refreshInit('r0'))).rejects.toThrow('fetch failed')
    await expect(fetcher(REFRESH_URL, refreshInit('r0'))).rejects.toThrow('fetch failed')

    expect(base).toHaveBeenCalledTimes(2)
    expect(watch.unavailable).toBe(true)
  })

  it('reports a 5xx as unavailable and never remembers it: the retry auth-js makes has to get through', async () => {
    const base = vi.fn(async () => json(503, { msg: 'upstream' }))
    const watch = createAuthServiceWatch()
    const fetcher = budgetedAuthFetch(base as unknown as typeof fetch, { watch })

    await fetcher(REFRESH_URL, refreshInit('r0'))
    await fetcher(REFRESH_URL, refreshInit('r0'))

    expect(watch.unavailable).toBe(true)
    expect(base).toHaveBeenCalledTimes(2)
  })
})

describe('what a request learned about the auth service', () => {
  it('follows its latest call: an answer after a rate limit means the service did answer', async () => {
    const base = vi.fn(async (url: string) =>
      url.includes('/token')
        ? json(429, { error_code: 'over_request_rate_limit' }, { 'retry-after': '30' })
        : json(403, { error_code: 'session_not_found' }),
    )
    const watch = createAuthServiceWatch()
    const fetcher = budgetedAuthFetch(base as unknown as typeof fetch, { watch, replayUser: true })

    await fetcher(REFRESH_URL, refreshInit('r0'))
    expect(watch).toEqual({ unavailable: true, retryAfterSeconds: 30 })

    await fetcher(USER_URL, userInit('a0'))
    expect(watch).toEqual({ unavailable: false, retryAfterSeconds: null })
  })

  it('is unavailable when a refresh that worked is followed by a check that did not', async () => {
    const base = vi.fn(async (url: string) =>
      url.includes('/token') ? json(200, { refresh_token: 'r1' }) : json(502, { msg: 'bad gateway' }),
    )
    const watch = createAuthServiceWatch()
    const fetcher = budgetedAuthFetch(base as unknown as typeof fetch, { watch, replayUser: true })

    await fetcher(REFRESH_URL, refreshInit('r0'))
    expect(watch.unavailable).toBe(false)
    await fetcher(USER_URL, userInit('a1'))
    expect(watch.unavailable).toBe(true)
  })
})

describe('/user budget', () => {
  it('replays the check for the same access token only where the caller opts in', async () => {
    const base = vi.fn(async () => json(200, { id: 'user-1' }))
    const proxy = budgetedAuthFetch(base as unknown as typeof fetch, { replayUser: true })

    for (let i = 0; i < 30; i++) {
      expect((await (await proxy(USER_URL, userInit('a1'))).json()).id).toBe('user-1')
      vi.advanceTimersByTime(50)
    }
    expect(base).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(USER_REPLAY_MS)
    await proxy(USER_URL, userInit('a1'))
    expect(base).toHaveBeenCalledTimes(2)
  })

  it('asks again for a route client: it reads the user right after writing it', async () => {
    const base = vi.fn(async () => json(200, { id: 'user-1' }))
    const route = budgetedAuthFetch(base as unknown as typeof fetch)

    await route(USER_URL, userInit('a1'))
    await route(USER_URL, userInit('a1'))

    expect(base).toHaveBeenCalledTimes(2)
  })

  it('never hands a route client the answer the proxy remembered', async () => {
    let name = 'before'
    const base = vi.fn(async () => json(200, { id: 'user-1', name }))
    const proxy = budgetedAuthFetch(base as unknown as typeof fetch, { replayUser: true })
    const route = budgetedAuthFetch(base as unknown as typeof fetch)

    await proxy(USER_URL, userInit('a1'))
    name = 'after'
    const read = await (await route(USER_URL, userInit('a1'))).json()

    expect(read.name).toBe('after')
    expect(base).toHaveBeenCalledTimes(2)
  })

  it('keeps one access token apart from another', async () => {
    const base = vi.fn(async (_url: string, init?: RequestInit) =>
      json(200, { id: new Headers(init?.headers).get('authorization') }),
    )
    const proxy = budgetedAuthFetch(base as unknown as typeof fetch, { replayUser: true })

    const first = await (await proxy(USER_URL, userInit('a1'))).json()
    const second = await (await proxy(USER_URL, userInit('a2'))).json()

    expect(first.id).toBe('Bearer a1')
    expect(second.id).toBe('Bearer a2')
  })
})

describe('everything else', () => {
  it('goes straight through, every time', async () => {
    const base = vi.fn(async () => json(200, []))
    const fetcher = budgetedAuthFetch(base as unknown as typeof fetch, { replayUser: true })

    const calls: Array<[string, RequestInit]> = [
      [`${ORIGIN}/rest/v1/companies?select=*`, { method: 'GET', headers: { Authorization: 'Bearer a1' } }],
      [`${ORIGIN}/auth/v1/token?grant_type=password`, { method: 'POST', body: JSON.stringify({ email: 'a', password: 'b' }) }],
      [`${ORIGIN}/auth/v1/user`, { method: 'PUT', headers: { Authorization: 'Bearer a1' }, body: '{}' }],
      [`${ORIGIN}/auth/v1/logout`, { method: 'POST', headers: { Authorization: 'Bearer a1' } }],
    ]
    for (const [url, init] of calls) {
      await fetcher(url, init)
      await fetcher(url, init)
    }

    expect(base).toHaveBeenCalledTimes(calls.length * 2)
  })
})
