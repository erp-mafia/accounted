import { describe, it, expect } from 'vitest'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import {
  PASSWORD_CHANGED_REVOCATION_UNCONFIRMED,
  passwordSavedDespiteFailure,
} from '../password-change-result'

describe('passwordSavedDespiteFailure', () => {
  it('is true for the failure that leaves the password saved', () => {
    expect(
      passwordSavedDespiteFailure({
        error: {
          code: PASSWORD_CHANGED_REVOCATION_UNCONFIRMED,
          message: 'Lösenordet är sparat, men ...',
          details: { passwordChanged: true, otherSessionsEnded: false, sessionKept: true },
        },
      }),
    ).toBe(true)
  })

  it('reads the flag as well as the code, so another failure after the write is not offered as a retry', () => {
    expect(passwordSavedDespiteFailure({ error: { code: 'SOMETHING_ELSE', details: { passwordChanged: true } } })).toBe(true)
    expect(passwordSavedDespiteFailure({ error: { code: PASSWORD_CHANGED_REVOCATION_UNCONFIRMED } })).toBe(true)
  })

  it('is false for every failure where the password was not written', () => {
    // The route's own refusals: a string, the AAL2 step-up among them.
    expect(passwordSavedDespiteFailure({ error: 'Något gick fel. Försök igen.' })).toBe(false)
    expect(passwordSavedDespiteFailure({ error: 'AAL2 session is required to update email or password when MFA is enabled' })).toBe(false)
    expect(passwordSavedDespiteFailure({ error: { code: 'VALIDATION_ERROR', details: { issues: [] } } })).toBe(false)
    expect(passwordSavedDespiteFailure({ error: { code: 'INTERNAL_ERROR', details: { passwordChanged: false } } })).toBe(false)
    // A body that could not be parsed (the callers read it with .catch(() => ({}))).
    expect(passwordSavedDespiteFailure({})).toBe(false)
    expect(passwordSavedDespiteFailure(null)).toBe(false)
    expect(passwordSavedDespiteFailure('nope')).toBe(false)
  })
})

describe('PASSWORD_CHANGED_REVOCATION_UNCONFIRMED', () => {
  it('is registered as a server error that is never retried, with a sentence in both languages', () => {
    const entry = getErrorEntry(PASSWORD_CHANGED_REVOCATION_UNCONFIRMED)

    expect(entry?.httpStatus).toBe(500)
    expect(entry?.retryable).toBe(false)
    // The password IS saved, the other devices are NOT confirmed signed out,
    // and the way out is the global sign-out by its name in the app.
    expect(entry?.message_sv).toContain('Lösenordet är sparat')
    expect(entry?.message_sv).toContain('Logga ut från alla enheter')
    expect(entry?.message_en).toContain('The password was saved')
    expect(entry?.message_en).toContain('Sign out of all devices')
  })
})
