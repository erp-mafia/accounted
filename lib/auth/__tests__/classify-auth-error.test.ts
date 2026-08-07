import { describe, it, expect } from 'vitest'
import { classifyAuthError } from '../classify-auth-error'

describe('classifyAuthError', () => {
  it('maps GoTrue error codes', () => {
    expect(classifyAuthError({ code: 'invalid_credentials', message: 'Invalid login credentials', status: 400 }))
      .toBe('invalid_credentials')
    expect(classifyAuthError({ code: 'email_not_confirmed', message: 'Email not confirmed', status: 400 }))
      .toBe('email_not_confirmed')
    expect(classifyAuthError({ code: 'over_request_rate_limit', message: 'Request rate limit reached', status: 429 }))
      .toBe('rate_limited')
    expect(classifyAuthError({ code: 'over_email_send_rate_limit', message: '...', status: 429 }))
      .toBe('rate_limited')
    expect(classifyAuthError({ code: 'user_banned', message: 'User is banned', status: 403 }))
      .toBe('user_banned')
    expect(classifyAuthError({ code: 'user_already_exists', message: 'User already registered', status: 422 }))
      .toBe('email_exists')
    expect(classifyAuthError({ code: 'weak_password', message: 'Password is too weak', status: 422 }))
      .toBe('weak_password')
    expect(classifyAuthError({ code: 'email_address_invalid', message: 'Email address is invalid', status: 400 }))
      .toBe('email_invalid')
    expect(classifyAuthError({ code: 'signup_disabled', message: 'Signups not allowed', status: 400 }))
      .toBe('signup_disabled')
    expect(classifyAuthError({ code: 'email_provider_disabled', message: 'Email signups are disabled', status: 400 }))
      .toBe('signup_disabled')
  })

  it('falls back on message strings when code is missing (older self-hosted GoTrue)', () => {
    expect(classifyAuthError({ message: 'Invalid login credentials', status: 400 }))
      .toBe('invalid_credentials')
    expect(classifyAuthError({ message: 'Email not confirmed', status: 400 }))
      .toBe('email_not_confirmed')
    expect(classifyAuthError({ message: 'User already registered', status: 422 }))
      .toBe('email_exists')
    expect(classifyAuthError({ message: 'Signups not allowed for this instance', status: 400 }))
      .toBe('signup_disabled')
    expect(classifyAuthError({ message: 'Email signups are disabled', status: 400 }))
      .toBe('signup_disabled')
    expect(classifyAuthError({ message: 'Email rate limit exceeded', status: 429 }))
      .toBe('rate_limited')
  })

  it('falls back on HTTP 429 when neither code nor message identifies the error', () => {
    expect(classifyAuthError({ message: 'something opaque', status: 429 })).toBe('rate_limited')
  })

  it('returns unknown for unrecognized or malformed input', () => {
    expect(classifyAuthError({ code: 'mfa_totp_verify_not_enabled', message: 'x', status: 400 })).toBe('unknown')
    expect(classifyAuthError({ message: 'fetch failed' })).toBe('unknown')
    expect(classifyAuthError(new Error('network down'))).toBe('unknown')
    expect(classifyAuthError('a string')).toBe('unknown')
    expect(classifyAuthError(null)).toBe('unknown')
    expect(classifyAuthError(undefined)).toBe('unknown')
  })

  it('never leaks which credential part failed: unknown email and wrong password share a kind', () => {
    const unknownEmail = { code: 'invalid_credentials', message: 'Invalid login credentials', status: 400 }
    const wrongPassword = { code: 'invalid_credentials', message: 'Invalid login credentials', status: 400 }
    expect(classifyAuthError(unknownEmail)).toBe(classifyAuthError(wrongPassword))
  })
})
