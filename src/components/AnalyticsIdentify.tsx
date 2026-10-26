'use client'

import { useEffect } from 'react'
import { identifySignedInPerson } from '@/lib/analytics/identify'
import type { AnalyticsCompanyInput, AnalyticsUserInput } from '@/lib/analytics/properties'

/**
 * Starts PostHog for a signed-in person who has not switched analytics off,
 * and attaches them, and their active company when there is one, to it.
 *
 * Mounted from app/(dashboard)/layout.tsx, which has the auth user, the
 * resolved company and the stored choice in one render, gated there on
 * `!isSandbox` so demo companies never pollute funnels or get surveyed; and
 * from app/(onboarding)/layout.tsx without a company, so the company journey
 * and the other signed-in screens before the dashboard are measured too.
 * With analytics switched off (`analyticsConsent` false) this does nothing
 * at all: PostHog is never started. The start, identify and group order lives
 * in lib/analytics/identify.ts, where it is tested.
 *
 * A useEffect is correct here despite the general rule against it: this
 * synchronises with an external, non-React system (the PostHog SDK).
 */
export default function AnalyticsIdentify({
  user,
  company,
  identityHash,
  analyticsConsent,
}: {
  user: AnalyticsUserInput
  /** The active company. Absent before the person has one (the onboarding layout). */
  company?: AnalyticsCompanyInput
  /** Server-computed HMAC of userId (lib/analytics/identity-hash.ts). Null
   *  when POSTHOG_SECRET_API_KEY is unset, which is normal off hosted. */
  identityHash?: string | null
  /** False only when the person switched analytics off (user_preferences.analytics_consent = false).
   *  Founder decision 2026-10-22: on by default, opt-out in Inställningar, Konto. */
  analyticsConsent: boolean
}) {
  const { userId, email, fullName, role } = user
  const {
    id: companyId,
    name: companyName,
    entityType,
    accountingFramework,
    paysSalaries,
    trialEndsAt,
    capabilities,
  } = company ?? ({} as Partial<AnalyticsCompanyInput>)

  // The dashboard layout rebuilds the props objects (and the capabilities
  // array) on every render, so depending on them directly would re-fire
  // identify on every navigation. Depend on primitives, and collapse the
  // array to a stable string key.
  const capabilityKey = capabilities ? [...capabilities].sort().join(',') : ''

  useEffect(() => {
    identifySignedInPerson({
      analyticsOn: analyticsConsent,
      user: { userId, email, fullName, role },
      identityHash,
      company:
        companyId && companyName
          ? {
              id: companyId,
              name: companyName,
              entityType,
              accountingFramework,
              paysSalaries,
              trialEndsAt,
              capabilities: capabilityKey ? capabilityKey.split(',') : undefined,
            }
          : undefined,
    })
  }, [
    analyticsConsent,
    userId,
    email,
    fullName,
    role,
    companyId,
    companyName,
    entityType,
    accountingFramework,
    paysSalaries,
    trialEndsAt,
    capabilityKey,
    identityHash,
  ])

  return null
}
