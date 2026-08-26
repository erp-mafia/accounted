import { describe, expect, it } from 'vitest'
import {
  LOGIN_METHOD_COOKIE,
  isLoginMethod,
  persistLoginMethodHint,
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
