import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createSessionTimeoutState,
  signSessionTimeoutState,
  verifySessionTimeoutState,
} from '@/lib/auth/session-timeout'
import { SESSION_TIMEOUT_COOKIE } from '@/lib/auth/session-timeout-shared'

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  cookieValue: undefined as string | undefined,
}))

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: mocks.requireAuth,
}))

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => name === SESSION_TIMEOUT_COOKIE && mocks.cookieValue
      ? { name, value: mocks.cookieValue }
      : undefined,
  })),
}))

import { GET, POST } from '../route'

const preference = { autoLogout: false, error: null as unknown }

const supabase = {
  auth: {
    getClaims: vi.fn(async () => ({
      data: { claims: { session_id: 'session-1' } },
    })),
  },
  from: vi.fn(() => ({
    select: vi.fn(() => ({
      eq: vi.fn(() => ({
        maybeSingle: vi.fn(async () => ({
          data: preference.error ? null : { auto_logout: preference.autoLogout },
          error: preference.error,
        })),
      })),
    })),
  })),
}

describe('session heartbeat route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.SESSION_TIMEOUT_SECRET = 'heartbeat-test-secret'
    process.env.NEXT_PUBLIC_SESSION_IDLE_TIMEOUT_MS = '30000'
    process.env.NEXT_PUBLIC_SESSION_ABSOLUTE_TIMEOUT_MS = '60000'
    process.env.NEXT_PUBLIC_SESSION_WARNING_MS = '10000'
    mocks.requireAuth.mockResolvedValue({
      user: { id: 'user-1' },
      supabase,
      error: null,
    })
    mocks.cookieValue = undefined
    preference.autoLogout = false
    preference.error = null
  })

  async function setState(args?: {
    startedAt?: number
    lastActivityAt?: number
    sessionId?: string
    autoLogout?: boolean
  }) {
    const state = {
      ...createSessionTimeoutState({
        userId: 'user-1',
        sessionId: args?.sessionId ?? 'session-1',
        method: 'password',
        // Default the opt-in to true: most cases here exercise enforcement.
        autoLogout: args?.autoLogout ?? true,
        now: args?.startedAt ?? Date.now(),
      }),
      ...(args?.lastActivityAt === undefined
        ? {}
        : { lastActivityAt: args.lastActivityAt }),
    }
    mocks.cookieValue = (await signSessionTimeoutState(state)) ?? undefined
    return state
  }

  it('returns the server-authoritative timeout state without extending it on GET', async () => {
    const state = await setState()

    const response = await GET()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      data: {
        enabled: true,
        startedAt: state.startedAt,
        lastActivityAt: state.lastActivityAt,
      },
    })
    expect(response.cookies.get(SESSION_TIMEOUT_COOKIE)).toBeUndefined()
  })

  it('advances activity and rotates the signed cookie on POST', async () => {
    const state = await setState({ startedAt: Date.now() - 1000 })

    const response = await POST()

    expect(response.status).toBe(200)
    const rotated = response.cookies.get(SESSION_TIMEOUT_COOKIE)?.value
    expect(rotated).toBeTruthy()
    await expect(verifySessionTimeoutState(rotated)).resolves.toMatchObject({
      startedAt: state.startedAt,
      lastActivityAt: expect.any(Number),
    })
  })

  it('rejects an expired state', async () => {
    const now = Date.now()
    await setState({ startedAt: now - 60_000, lastActivityAt: now - 1 })
    const expired = await GET()
    expect(expired.status).toBe(401)
    expect(expired.headers.get('x-session-timeout-reason')).toBe('absolute')
  })

  it('initializes fresh state for a missing or mismatched cookie like middleware', async () => {
    const missing = await GET()
    expect(missing.status).toBe(200)
    const initialized = missing.cookies.get(SESSION_TIMEOUT_COOKIE)?.value
    expect(initialized).toBeTruthy()
    await expect(verifySessionTimeoutState(initialized)).resolves.toMatchObject({
      userId: 'user-1',
      sessionId: 'session-1',
    })

    await setState({ sessionId: 'another-session' })
    const mismatch = await GET()
    expect(mismatch.status).toBe(200)
    const reminted = mismatch.cookies.get(SESSION_TIMEOUT_COOKIE)?.value
    expect(reminted).toBeTruthy()
    await expect(verifySessionTimeoutState(reminted)).resolves.toMatchObject({
      sessionId: 'session-1',
    })
  })

  it('reports enabled: false and never expires an opted-out session', async () => {
    const now = Date.now()
    // Times that would be long expired if enforcement applied.
    await setState({
      startedAt: now - 120_000,
      lastActivityAt: now - 120_000,
      autoLogout: false,
    })

    const response = await GET()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      data: { enabled: false },
    })
  })

  it('upgrades a pre-toggle cookie in place, keeping its timers', async () => {
    preference.autoLogout = true
    const startedAt = Date.now() - 5_000
    const legacy: Record<string, unknown> = {
      ...createSessionTimeoutState({
        userId: 'user-1',
        sessionId: 'session-1',
        method: 'password',
        autoLogout: true,
        now: startedAt,
      }),
    }
    delete legacy.autoLogout
    mocks.cookieValue =
      (await signSessionTimeoutState(
        legacy as Parameters<typeof signSessionTimeoutState>[0],
      )) ?? undefined

    const response = await GET()

    expect(response.status).toBe(200)
    const upgraded = response.cookies.get(SESSION_TIMEOUT_COOKIE)?.value
    expect(upgraded).toBeTruthy()
    await expect(verifySessionTimeoutState(upgraded)).resolves.toMatchObject({
      startedAt,
      autoLogout: true,
    })
  })

  it('answers without persisting a snapshot when the preference read fails', async () => {
    preference.error = { message: 'connection reset' }
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const response = await GET()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      data: { enabled: false },
    })
    // No cookie: the unknown preference must not be baked into a snapshot.
    expect(response.cookies.get(SESSION_TIMEOUT_COOKIE)).toBeUndefined()
    errorSpy.mockRestore()
  })

  it('passes through the existing authentication error', async () => {
    mocks.requireAuth.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    expect((await GET()).status).toBe(401)
  })
})
