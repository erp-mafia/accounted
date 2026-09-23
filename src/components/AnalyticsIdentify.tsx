'use client'

import { useEffect } from 'react'
import posthog from 'posthog-js'
import { isAnalyticsEnabled } from '@/lib/analytics/enabled'
import {
  buildPersonProperties,
  buildGroupProperties,
  type AnalyticsCompanyInput,
  type AnalyticsUserInput,
} from '@/lib/analytics/properties'

/**
 * Attaches the logged-in user and their active company to PostHog.
 *
 * Mounted from app/(dashboard)/layout.tsx, which is the only place that has
 * both the auth user and the resolved company in one render, and gated there
 * on `!isSandbox` so demo companies never pollute funnels or get surveyed.
 *
 * identify() runs on every dashboard load rather than only at login, per
 * PostHog's guidance: with `persistence: 'memory'` (see
 * instrumentation-client.ts) nothing survives a hard reload, so re-identifying
 * on each load is what keeps person-level analytics correct without storing
 * anything on the device.
 *
 * A useEffect is correct here despite the general rule against it: this
 * synchronises with an external, non-React system (the PostHog SDK).
 */
export default function AnalyticsIdentify({
  user,
  company,
  identityHash,
}: {
  user: AnalyticsUserInput
  company: AnalyticsCompanyInput
  /** Server-computed HMAC of userId (lib/analytics/identity-hash.ts). Null
   *  when POSTHOG_SECRET_API_KEY is unset, which is normal off hosted. */
  identityHash?: string | null
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
  } = company

  // The dashboard layout rebuilds the props objects (and the capabilities
  // array) on every render, so depending on them directly would re-fire
  // identify on every navigation. Depend on primitives, and collapse the
  // array to a stable string key.
  const capabilityKey = capabilities ? [...capabilities].sort().join(',') : ''

  useEffect(() => {
    if (!isAnalyticsEnabled()) return

    // Verified identity first: it tells PostHog Support this browser really
    // is `userId`, so a support ticket follows the person across devices
    // instead of being scoped to one browser session. Without the secret key
    // this is skipped and tickets fall back to email recovery.
    if (identityHash) posthog.setIdentity(userId, identityHash)

    posthog.identify(userId, buildPersonProperties({ userId, email, fullName, role }))
    posthog.group(
      'company',
      companyId,
      buildGroupProperties({
        id: companyId,
        name: companyName,
        entityType,
        accountingFramework,
        paysSalaries,
        trialEndsAt,
        capabilities: capabilityKey ? capabilityKey.split(',') : undefined,
      })
    )
  }, [
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
