/**
 * The profile a new company gets from its onboarding answers (Profiles and
 * Suggestions, step 2): public signup has no extra step, the profile follows
 * from the legal form the onboarding already asks for (./profiles.ts
 * deriveSignupProfile).
 *
 * Dark by default. Company creation always records the derived profile as a
 * suggestion (companies.suggested_profile_id and version), which switches
 * nothing. It becomes the company's profile (companies.profile_id) only on
 * public signup and only while the instance sets PROFILES_APPLY_ON_SIGNUP
 * (`true` or `1`). Unset, a new public signup keeps profile_id NULL,
 * "Standard (allt på)", and sees exactly what signups see today. Jakob flips
 * it after confirming the package and profile lists. A byrå's client company
 * never takes the derived profile: the byrå picks one in its invite form.
 */
import { deriveSignupProfile, latestProfile, type ProfileId } from './profiles'

/** PROFILES_APPLY_ON_SIGNUP: public signup applies the derived profile. Off unless `true` or `1`. */
export function profilesApplyOnSignup(): boolean {
  const raw = process.env.PROFILES_APPLY_ON_SIGNUP?.trim().toLowerCase()
  return raw === 'true' || raw === '1'
}

/** The companies columns company creation writes for the derived profile. */
export interface SignupProfileColumns {
  suggested_profile_id: ProfileId
  suggested_profile_version: number
  profile_id?: ProfileId
  profile_version?: number
}

/**
 * The columns to write for a new company of this legal form: the derived
 * profile as a suggestion, and as the company's profile too when `apply`.
 * Null when the legal form derives no profile.
 */
export function signupProfileColumns(entityType: unknown, apply: boolean): SignupProfileColumns | null {
  const derived = deriveSignupProfile(entityType)
  if (!derived) return null
  const version = latestProfile(derived).version
  return {
    suggested_profile_id: derived,
    suggested_profile_version: version,
    ...(apply ? { profile_id: derived, profile_version: version } : {}),
  }
}
