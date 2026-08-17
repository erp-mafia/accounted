/**
 * Google OAuth feature flag.
 *
 * Signing in with Google requires the Google provider to be configured in
 * Supabase (GoTrue) with a Google Cloud OAuth client; the flag ships the UI
 * dark until that is done:
 * https://supabase.com/docs/guides/auth/social-login/auth-google
 * Unlike BankID this is not hosted-only: self-hosted installations can
 * configure their own Google OAuth client.
 */
import { flagEnabled } from '@/lib/env/public-flags'

export function isGoogleAuthEnabled(): boolean {
  return flagEnabled(process.env.NEXT_PUBLIC_GOOGLE_AUTH_ENABLED)
}
