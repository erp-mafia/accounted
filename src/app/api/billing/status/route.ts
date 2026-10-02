import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/require-auth'
import { createServiceClient } from '@/lib/supabase/server'
import { requireCompanyId } from '@/lib/company/context'
import { getStripe, isStripeConfigured } from '@/lib/stripe/client'
import { isSandboxCompany } from '@/lib/sandbox/guard'
import { getTeamAgreement, type TeamAgreement } from '@/lib/entitlements/team-agreement'
import {
  getCompanyEntitlements,
  type EntitlementCoverage,
  type EntitlementState,
} from '@/lib/entitlements/has-capability'
import { createLogger } from '@/lib/logger'

const log = createLogger('api/billing/status')

/**
 * Whether a trialing subscription will still be charged when its trial ends.
 * company_subscriptions does not record a pending cancellation, and a portal
 * cancellation takes effect at period end by default, so a trial cancelled in
 * the portal stays 'trialing' in the row until it lapses without a charge.
 * Stripe is asked live, and only for a trialing row. Any doubt (a Stripe
 * error, a pending cancellation, a status other than trialing) counts as no:
 * the card then makes no date claim.
 */
async function firstChargeStillDue(subscriptionId: string, companyId: string): Promise<boolean> {
  try {
    const sub = await getStripe().subscriptions.retrieve(subscriptionId)
    return sub.status === 'trialing' && !sub.cancel_at_period_end && !sub.cancel_at
  } catch (err) {
    log.warn('first charge check failed', err as Error, { companyId })
    return false
  }
}

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
  // A subscription started during the product trial stays Stripe 'trialing'
  // until the deferred first charge (billing/checkout sets trial_end), and its
  // current_period_end is that charge date. The entitlement read nulls
  // trialEndsAt once the stripe grant lands, so this is the only date the
  // paying card can show. Additive field: absent for everyone else.
  // That deferral is the only trial we create. A trial added by hand in the
  // Stripe dashboard to a subscription that was already charged would also
  // read as a first charge here; the date is still the next charge.
  let firstChargeAt: string | null = null
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
        .select('plan, status, current_period_end, stripe_subscription_id')
        .eq('company_id', companyId)
        .maybeSingle()
      const plan = subscription?.plan
      subscriptionPlan = plan === 'monthly' || plan === 'yearly' ? plan : null
      const periodEnd = subscription?.current_period_end
      const subscriptionId = subscription?.stripe_subscription_id
      if (
        !isDemo &&
        subscription?.status === 'trialing' &&
        typeof periodEnd === 'string' &&
        new Date(periodEnd).getTime() > Date.now() &&
        typeof subscriptionId === 'string' &&
        (await firstChargeStillDue(subscriptionId, companyId))
      ) {
        firstChargeAt = periodEnd
      }
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
    ...(firstChargeAt ? { firstChargeAt } : {}),
  })
}
