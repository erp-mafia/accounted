import { describe, expect, it } from 'vitest'
import {
  LOGIN_METHOD_COOKIE,
  LOGIN_METHOD_PARAM,
  buildLoginHref,
  isLoginMethod,
  loginMethodFromParam,
  persistLoginMethodHint,
  resolveInitialLoginMethod,
} from '@/lib/auth/login-method'

describe('isLoginMethod', () => {
  it('accepts the two supported methods', () => {
    expect(isLoginMethod('bankid')).toBe(true)
    expect(isLoginMethod('email')).toBe(true)
  })

  it('rejects anything else', () => {
    expect(isLoginMethod('google')).toBe(false)
    expect(isLoginMethod('password')).toBe(false)
    expect(isLoginMethod('')).toBe(false)
    expect(isLoginMethod(undefined)).toBe(false)
    expect(isLoginMethod(null)).toBe(false)
  })
})

describe('persistLoginMethodHint', () => {
  it('is a no-op outside the browser', () => {
    expect(() => persistLoginMethodHint('email')).not.toThrow()
  })
})

describe('LOGIN_METHOD_COOKIE', () => {
  // New wire identifiers use the accounted name; only pre-rebrand ones keep
  // the gnubok prefix. Locks the name so a rename cannot silently strand the
  // stored hints of every returning user.
  it('stays on the accounted name', () => {
    expect(LOGIN_METHOD_COOKIE).toBe('accounted-login-method')
  })
})

describe('loginMethodFromParam', () => {
  it('reads the session-timeout vocabulary', () => {
    expect(loginMethodFromParam('password')).toBe('email')
    expect(loginMethodFromParam('bankid')).toBe('bankid')
  })

  it('ignores anything else, so a crafted value opens the default panel', () => {
    for (const value of ['email', 'google', 'PASSWORD', ' bankid', '', null, undefined]) {
      expect(loginMethodFromParam(value)).toBeNull()
    }
  })
})

describe('resolveInitialLoginMethod', () => {
  const base = {
    bankIdEnabled: true,
    passwordLoginEnabled: true,
    timedOut: false,
    requested: null,
    remembered: null,
  } as const

  it('opens BankID for a fresh visitor', () => {
    expect(resolveInitialLoginMethod(base)).toBe('bankid')
  })

  it('opens the e-mail form for a plain visit that asks for it, with no timeout reason (issue #209)', () => {
    expect(resolveInitialLoginMethod({ ...base, requested: 'email' })).toBe('email')
  })

  it('lets the requested method outrank the cookie hint of the last sign-in', () => {
    expect(resolveInitialLoginMethod({ ...base, requested: 'email', remembered: 'bankid' })).toBe('email')
    expect(resolveInitialLoginMethod({ ...base, requested: 'bankid', remembered: 'email' })).toBe('bankid')
  })

  it('falls back to the cookie hint when nothing is requested', () => {
    expect(resolveInitialLoginMethod({ ...base, remembered: 'email' })).toBe('email')
    expect(resolveInitialLoginMethod({ ...base, remembered: 'bankid' })).toBe('bankid')
  })

  it('follows the method that timed out, password when the redirect named none', () => {
    expect(resolveInitialLoginMethod({ ...base, timedOut: true, requested: 'bankid' })).toBe('bankid')
    expect(resolveInitialLoginMethod({ ...base, timedOut: true, requested: 'email' })).toBe('email')
    expect(resolveInitialLoginMethod({ ...base, timedOut: true, remembered: 'bankid' })).toBe('email')
  })

  it('opens the e-mail form whatever is asked when BankID is off', () => {
    expect(resolveInitialLoginMethod({ ...base, bankIdEnabled: false, requested: 'bankid' })).toBe('email')
    expect(resolveInitialLoginMethod({ ...base, bankIdEnabled: false, remembered: 'bankid' })).toBe('email')
  })

  it('never opens a missing e-mail form over BankID when password login is off', () => {
    const noPassword = { ...base, passwordLoginEnabled: false }
    expect(resolveInitialLoginMethod({ ...noPassword, requested: 'email' })).toBe('bankid')
    expect(resolveInitialLoginMethod({ ...noPassword, remembered: 'email' })).toBe('bankid')
    expect(resolveInitialLoginMethod({ ...noPassword, timedOut: true })).toBe('bankid')
  })
})

describe('buildLoginHref', () => {
  it('is plain /login with nothing to carry', () => {
    expect(buildLoginHref()).toBe('/login')
    expect(buildLoginHref({ next: '/' })).toBe('/login')
  })

  it('names the panel in the parameter /login reads', () => {
    expect(buildLoginHref({ method: 'password' })).toBe(`/login?${LOGIN_METHOD_PARAM}=password`)
    expect(buildLoginHref({ method: 'bankid' })).toBe('/login?method=bankid')
  })

  it('round-trips: the panel the link names is the panel /login opens', () => {
    for (const method of ['password', 'bankid'] as const) {
      const href = new URL(buildLoginHref({ method }), 'https://app.invalid')
      expect(
        resolveInitialLoginMethod({
          bankIdEnabled: true,
          passwordLoginEnabled: true,
          timedOut: false,
          requested: loginMethodFromParam(href.searchParams.get(LOGIN_METHOD_PARAM)),
          remembered: null,
        }),
      ).toBe(method === 'bankid' ? 'bankid' : 'email')
    }
  })

  it('carries a same-origin destination and drops an off-origin one', () => {
    const href = new URL(
      buildLoginHref({ method: 'password', next: '/api/mcp-oauth/authorize?client_id=a&state=b' }),
      'https://app.invalid',
    )
    expect(href.pathname).toBe('/login')
    expect(href.searchParams.get('method')).toBe('password')
    expect(href.searchParams.get('next')).toBe('/api/mcp-oauth/authorize?client_id=a&state=b')

    expect(buildLoginHref({ method: 'password', next: '//evil.example' })).toBe('/login?method=password')
    expect(buildLoginHref({ next: 'https://evil.example/' })).toBe('/login')
  })

  it('never puts an e-mail address in the URL, even when one is passed in', () => {
    // Only the method and the destination are written; an address rides in
    // sessionStorage (lib/auth/login-email-handoff.ts).
    const href = buildLoginHref({ method: 'password', email: 'anna@example.se' } as never)
    expect(href).toBe('/login?method=password')
  })
})
