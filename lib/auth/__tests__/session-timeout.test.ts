import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  apiRequestSkipsSessionTimeout,
  createSessionTimeoutState,
  evaluateSessionTimeout,
  fetchAutoLogoutPreference,
  getSessionTimeoutConfig,
  sessionStateMatchesUser,
  sessionStateNeedsRemint,
  signSessionTimeoutState,
  toSessionTimeoutClientState,
  verifySessionTimeoutState,
} from '../session-timeout'

const SIGNING_ENV = { SESSION_TIMEOUT_SECRET: 'test-session-timeout-secret' }

describe('session timeout configuration', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('uses banking-style defaults for hosted deployments', () => {
    expect(getSessionTimeoutConfig({})).toEqual({
      enabled: true,
      idleTimeoutMs: 30 * 60 * 1000,
      absoluteTimeoutMs: 12 * 60 * 60 * 1000,
      warningMs: 2 * 60 * 1000,
      enforceForAll: false,
    })
  })

  it('is disabled by default for self-hosted deployments', () => {
    expect(getSessionTimeoutConfig({ NEXT_PUBLIC_SELF_HOSTED: 'true' })).toEqual({
      enabled: false,
      idleTimeoutMs: 0,
      absoluteTimeoutMs: 0,
      warningMs: 0,
      enforceForAll: false,
    })
  })

  it('allows self-hosted deployments to opt in and bounds the warning', () => {
    expect(getSessionTimeoutConfig({
      NEXT_PUBLIC_SELF_HOSTED: 'true',
      NEXT_PUBLIC_SESSION_IDLE_TIMEOUT_MS: '60000',
      NEXT_PUBLIC_SESSION_WARNING_MS: '120000',
    })).toEqual({
      enabled: true,
      idleTimeoutMs: 60000,
      absoluteTimeoutMs: 0,
      warningMs: 60000,
      enforceForAll: false,
    })
  })

  it('warns when only the absolute limit is enabled', () => {
    expect(getSessionTimeoutConfig({
      NEXT_PUBLIC_SELF_HOSTED: 'true',
      NEXT_PUBLIC_SESSION_ABSOLUTE_TIMEOUT_MS: '60000',
      NEXT_PUBLIC_SESSION_WARNING_MS: '10000',
    })).toEqual({
      enabled: true,
      idleTimeoutMs: 0,
      absoluteTimeoutMs: 60000,
      warningMs: 10000,
      enforceForAll: false,
    })
  })

  it('reads the force-all override', () => {
    expect(getSessionTimeoutConfig({
      NEXT_PUBLIC_SESSION_TIMEOUT_FORCE_ALL: 'true',
    })).toMatchObject({ enforceForAll: true })
  })

  it('ignores negative and non-integer overrides', () => {
    expect(getSessionTimeoutConfig({
      NEXT_PUBLIC_SESSION_IDLE_TIMEOUT_MS: '-1',
      NEXT_PUBLIC_SESSION_ABSOLUTE_TIMEOUT_MS: '12.5',
    })).toMatchObject({
      idleTimeoutMs: 30 * 60 * 1000,
      absoluteTimeoutMs: 12 * 60 * 60 * 1000,
    })
  })
})

describe('signed session timeout state', () => {
  it('round-trips an authentic state', async () => {
    const state = createSessionTimeoutState({
      userId: 'user-1',
      sessionId: 'session-1',
      method: 'bankid',
      autoLogout: true,
      now: 1000,
    })

    const signed = await signSessionTimeoutState(state, SIGNING_ENV)

    expect(signed).not.toBeNull()
    await expect(verifySessionTimeoutState(signed!, SIGNING_ENV)).resolves.toEqual(state)
  })

  it('returns null instead of throwing when no signing secret is configured', async () => {
    const state = createSessionTimeoutState({
      userId: 'user-1',
      sessionId: 'session-1',
      method: 'password',
      autoLogout: true,
      now: 1000,
    })

    await expect(signSessionTimeoutState(state, {})).resolves.toBeNull()
  })

  it('rejects payload and signature tampering', async () => {
    const state = createSessionTimeoutState({
      userId: 'user-1',
      sessionId: 'session-1',
      method: 'password',
      autoLogout: true,
      now: 1000,
    })
    const signed = await signSessionTimeoutState(state, SIGNING_ENV)
    const [payload, signature] = signed!.split('.')

    await expect(
      verifySessionTimeoutState(`${payload}x.${signature}`, SIGNING_ENV),
    ).resolves.toBeNull()
    await expect(
      verifySessionTimeoutState(`${payload}.${signature.slice(0, -1)}x`, SIGNING_ENV),
    ).resolves.toBeNull()
  })

  it('binds state to both the user and Supabase session', () => {
    const state = createSessionTimeoutState({
      userId: 'user-1',
      sessionId: 'session-1',
      method: 'password',
      autoLogout: true,
      now: 1000,
    })

    expect(sessionStateMatchesUser(state, 'user-1', 'session-1')).toBe(true)
    expect(sessionStateMatchesUser(state, 'user-2', 'session-1')).toBe(false)
    expect(sessionStateMatchesUser(state, 'user-1', 'session-2')).toBe(false)
  })

  it('treats an unresolved current session id as a mismatch for bound state', () => {
    const bound = createSessionTimeoutState({
      userId: 'user-1',
      sessionId: 'session-1',
      method: 'password',
      autoLogout: true,
      now: 1000,
    })
    const unbound = createSessionTimeoutState({
      userId: 'user-1',
      sessionId: null,
      method: 'password',
      autoLogout: true,
      now: 1000,
    })

    expect(sessionStateMatchesUser(bound, 'user-1', null)).toBe(false)
    expect(sessionStateMatchesUser(unbound, 'user-1', null)).toBe(true)
    expect(sessionStateMatchesUser(unbound, 'user-1', 'session-2')).toBe(true)
  })
})

describe('session expiry', () => {
  const config = {
    enabled: true,
    idleTimeoutMs: 30_000,
    absoluteTimeoutMs: 60_000,
    warningMs: 10_000,
    enforceForAll: false,
  }

  it('uses inclusive boundaries and gives absolute expiry precedence', () => {
    const state = {
      ...createSessionTimeoutState({
        userId: 'user-1',
        sessionId: 'session-1',
        method: 'password' as const,
        autoLogout: true,
        now: 1000,
      }),
      lastActivityAt: 31_000,
    }

    expect(evaluateSessionTimeout(state, config, 60_999)).toBeNull()
    expect(evaluateSessionTimeout(state, config, 61_000)).toBe('absolute')
  })

  it('expires an otherwise valid session after the idle limit', () => {
    const state = createSessionTimeoutState({
      userId: 'user-1',
      sessionId: null,
      method: 'password',
      autoLogout: true,
      now: 1000,
    })

    expect(evaluateSessionTimeout(state, config, 30_999)).toBeNull()
    expect(evaluateSessionTimeout(state, config, 31_000)).toBe('idle')
  })
})

describe('per-user opt-in gating', () => {
  const config = {
    enabled: true,
    idleTimeoutMs: 30_000,
    absoluteTimeoutMs: 60_000,
    warningMs: 10_000,
    enforceForAll: false,
  }

  function makeState(autoLogout: boolean) {
    return createSessionTimeoutState({
      userId: 'user-1',
      sessionId: null,
      method: 'password' as const,
      autoLogout,
      now: 1000,
    })
  }

  it('never expires a session that has not opted in', () => {
    const state = makeState(false)

    // Far past both limits: still no timeout without the opt-in.
    expect(evaluateSessionTimeout(state, config, 10_000_000)).toBeNull()
  })

  it('expires an opted-in session normally', () => {
    const state = makeState(true)

    expect(evaluateSessionTimeout(state, config, 61_000)).toBe('absolute')
  })

  it('lets enforceForAll override the opt-out', () => {
    const state = makeState(false)

    expect(
      evaluateSessionTimeout(state, { ...config, enforceForAll: true }, 61_000),
    ).toBe('absolute')
  })

  it('treats a pre-toggle state as authentic but needing a re-mint', async () => {
    const legacy = makeState(true) as { autoLogout?: boolean }
    delete legacy.autoLogout
    const state = legacy as ReturnType<typeof makeState>

    const signed = await signSessionTimeoutState(state, SIGNING_ENV)
    await expect(verifySessionTimeoutState(signed!, SIGNING_ENV)).resolves.toEqual(state)
    expect(sessionStateNeedsRemint(state)).toBe(true)
    expect(sessionStateNeedsRemint(makeState(false))).toBe(false)
    // A legacy state is never enforced against until it has been re-minted.
    expect(evaluateSessionTimeout(state, config, 10_000_000)).toBeNull()
  })

  it('reports the client state as enabled only when enforced', () => {
    expect(toSessionTimeoutClientState(makeState(true), config, 2000).enabled).toBe(true)
    expect(toSessionTimeoutClientState(makeState(false), config, 2000).enabled).toBe(false)
    expect(
      toSessionTimeoutClientState(
        makeState(false),
        { ...config, enforceForAll: true },
        2000,
      ).enabled,
    ).toBe(true)
    expect(
      toSessionTimeoutClientState(
        makeState(true),
        { ...config, enabled: false },
        2000,
      ).enabled,
    ).toBe(false)
  })
})

describe('fetchAutoLogoutPreference', () => {
  function client(result: { data: unknown; error: unknown } | 'throw') {
    return {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => {
              if (result === 'throw') throw new Error('network down')
              return result
            },
          }),
        }),
      }),
    } as unknown as Parameters<typeof fetchAutoLogoutPreference>[0]
  }

  it('returns the stored opt-in', async () => {
    await expect(
      fetchAutoLogoutPreference(client({ data: { auto_logout: true }, error: null }), 'u1'),
    ).resolves.toBe(true)
    await expect(
      fetchAutoLogoutPreference(client({ data: { auto_logout: false }, error: null }), 'u1'),
    ).resolves.toBe(false)
  })

  it('treats a missing row as a definitive opt-out', async () => {
    await expect(
      fetchAutoLogoutPreference(client({ data: null, error: null }), 'u1'),
    ).resolves.toBe(false)
  })

  it('returns null (unknown) on a failed read, never a fail-open false', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(
      fetchAutoLogoutPreference(client({ data: null, error: { message: 'boom' } }), 'u1'),
    ).resolves.toBeNull()
    await expect(fetchAutoLogoutPreference(client('throw'), 'u1')).resolves.toBeNull()
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })
})

describe('API exclusions', () => {
  it('only lets bearer-authenticated machine surfaces bypass timeouts', () => {
    expect(apiRequestSkipsSessionTimeout('/api/v1/companies/c1/invoices', true)).toBe(true)
    expect(apiRequestSkipsSessionTimeout('/api/v1/companies/c1/invoices', false)).toBe(false)
    expect(apiRequestSkipsSessionTimeout('/api/invoices', true)).toBe(false)
    expect(apiRequestSkipsSessionTimeout('/api/mcp-oauth/token', false)).toBe(true)
    expect(apiRequestSkipsSessionTimeout('/api/health', false)).toBe(true)
  })
})
