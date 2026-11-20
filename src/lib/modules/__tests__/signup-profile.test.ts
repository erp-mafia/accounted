/**
 * The derived signup profile and its flag (lib/modules/signup-profile.ts):
 * recorded as a suggestion always, applied only while
 * PROFILES_APPLY_ON_SIGNUP is on, which it is not by default.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { profilesApplyOnSignup, signupProfileColumns } from '../signup-profile'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('profilesApplyOnSignup', () => {
  it('is off unless the instance sets true or 1', () => {
    for (const value of ['', 'false', '0', 'no', 'yes', 'on']) {
      vi.stubEnv('PROFILES_APPLY_ON_SIGNUP', value)
      expect(profilesApplyOnSignup(), JSON.stringify(value)).toBe(false)
    }
    for (const value of ['true', '1', ' TRUE ']) {
      vi.stubEnv('PROFILES_APPLY_ON_SIGNUP', value)
      expect(profilesApplyOnSignup(), JSON.stringify(value)).toBe(true)
    }
  })
})

describe('signupProfileColumns', () => {
  it('records the derived profile as a suggestion, and as the profile only when applied', () => {
    expect(signupProfileColumns('aktiebolag', false)).toEqual({
      suggested_profile_id: 'limited-company-no-employees',
      suggested_profile_version: 1,
    })
    expect(signupProfileColumns('enskild_firma', true)).toEqual({
      suggested_profile_id: 'sole-trader',
      suggested_profile_version: 1,
      profile_id: 'sole-trader',
      profile_version: 1,
    })
  })

  it('writes nothing for a legal form that derives no profile', () => {
    expect(signupProfileColumns('handelsbolag', true)).toBeNull()
  })
})
