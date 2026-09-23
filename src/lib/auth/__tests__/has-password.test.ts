import { describe, it, expect } from 'vitest'
import { userHasPassword } from '../has-password'

describe('userHasPassword', () => {
  it('returns true when has_password === true', () => {
    expect(userHasPassword({ app_metadata: { has_password: true } })).toBe(true)
  })

  it('returns false when has_password === false', () => {
    expect(userHasPassword({ app_metadata: { has_password: false } })).toBe(false)
  })

  it('returns false when flag is missing but bankid_linked === true', () => {
    expect(userHasPassword({ app_metadata: { bankid_linked: true } })).toBe(false)
  })

  it('returns true when flag is missing and bankid_linked is not true (legacy email/password user)', () => {
    expect(userHasPassword({ app_metadata: {} })).toBe(true)
    expect(userHasPassword({ app_metadata: { bankid_linked: false } })).toBe(true)
  })

  it('returns true when app_metadata is missing entirely', () => {
    expect(userHasPassword({ app_metadata: undefined as unknown as Record<string, unknown> })).toBe(true)
  })

  it('prefers explicit has_password over bankid_linked (BankID user who later set a password)', () => {
    expect(
      userHasPassword({ app_metadata: { bankid_linked: true, has_password: true } }),
    ).toBe(true)
  })
})
