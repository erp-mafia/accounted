import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/require-auth'
import { createServiceClient } from '@/lib/supabase/server'
import { requireCompanyId } from '@/lib/company/context'
import { isStripeConfigured } from '@/lib/stripe/client'
import { isSandboxCompany } from '@/lib/sandbox/guard'
import { getTeamAgreement, type TeamAgreement } from '@/lib/entitlements/team-agreement'
import {
  getCompanyEntitlements,
  type EntitlementCoverage,
  type EntitlementState,
} from '@/lib/entitlements/has-capability'

/**
 * Billing status for the client-rendered billing section (Settings →
 * Abonnemang, a client component). Returns whether the
 * company is paying, whether Stripe checkout is configured, and the trial expiry
 * (for the days-left urgency banner). Read-only.
 *
 * "Paid" is defined once, in getCompanyEntitlements: this route only relays
 * its answer. `coverage` says how the company is covered (subscription, team,
 * agreement), so a company paying by invoice or on a comp grant gets an
 * "Ingår i ditt avtal" state instead of the upgrade pitch. `isPaying` stays
 * for compatibility and means a Stripe subscription (the manage view).
 *
 * WL-10: a non-paying company covered by its byrå team's agreement (active
 * team-scoped manual grant) additionally gets `teamAgreement: { teamName }`,
 * which the settings surface renders as "Ingår i <byråns namn>s avtal"
 * instead of the upgrade pitch. Additive field: absent for everyone else.
 */
export async function GET() {
  const { user, supabase, error } = await requireAuth()
  if (error) return error

  let companyId: string | null = null
  try {
    companyId = await requireCompanyId(supabase, user.id)
  } catch {
    companyId = null
  }

  // Demo accounts (anonymous user or sandbox company) can't check out, so the
  // client hides the upgrade CTA rather than showing a button that only errors.
  let isDemo = user.is_anonymous === true
  if (companyId && !isDemo) {
    isDemo = await isSandboxCompany(supabase, companyId)
  }

  let isPaying = false
  let trialEndsAt: string | null = null
  let entitlementState: EntitlementState = 'none'
  let coverage: EntitlementCoverage | null = null
  let teamAgreement: TeamAgreement | null = null
  // The paying company's interval, so the plan card shows the price it pays.
  let subscriptionPlan: 'monthly' | 'yearly' | null = null
  if (companyId) {
    const entitlements = await getCompanyEntitlements(supabase, companyId)
    entitlementState = entitlements.entitlementState
    coverage = entitlements.coverage
    // Paying = a real subscription. Includes 'trialing': checkout defers the
    // first charge to the product-trial end, so a Stripe-trialing subscription
    // means the card is already committed and the user should see the manage
    // view, not the upgrade pitch.
    isPaying = coverage?.kind === 'subscription'
    // The lapsed expiry keeps flowing so the sell view can say the trial ended.
    trialEndsAt = entitlements.trialEndsAt ?? entitlements.trialExpiredAt

    // Team entitlement (WL-10): only consulted when the company isn't paying
    // on its own subscription. Service client by necessity: end clients are
    // not members of the byrå team, so RLS hides the team and its grants
    // from the user's session.
    if (!isPaying) {
      teamAgreement = await getTeamAgreement(createServiceClient(), companyId)
    } else {
      // The user's own client: company members read their company's
      // subscription row (the entitlement check above does the same).
      const { data: subscription } = await supabase
        .from('company_subscriptions')
        .select('plan')
        .eq('company_id', companyId)
        .maybeSingle()
      const plan = subscription?.plan
      subscriptionPlan = plan === 'monthly' || plan === 'yearly' ? plan : null
    }
  }

  return NextResponse.json({
    isPaying,
    configured: isStripeConfigured(),
    trialEndsAt,
    isDemo,
    entitlementState,
    coverage,
    ...(teamAgreement ? { teamAgreement } : {}),
    ...(subscriptionPlan ? { subscriptionPlan } : {}),
  })
}
