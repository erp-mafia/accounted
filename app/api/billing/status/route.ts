import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/require-auth'
import { createServiceClient } from '@/lib/supabase/server'
import { requireCompanyId } from '@/lib/company/context'
import { isStripeConfigured } from '@/lib/stripe/client'
import { isSandboxCompany } from '@/lib/sandbox/guard'
import { getTeamAgreement, type TeamAgreement } from '@/lib/entitlements/team-agreement'

/**
 * Billing status for the client-rendered billing section (which lives inside the
 * settings modal Dialog and can't read the DB server-side). Returns whether the
 * company is paying, whether Stripe checkout is configured, and the trial expiry
 * (for the days-left urgency banner). Read-only.
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
  let teamAgreement: TeamAgreement | null = null
  if (companyId) {
    const { data: sub } = await supabase
      .from('company_subscriptions')
      .select('status')
      .eq('company_id', companyId)
      .maybeSingle()
    const status = (sub as { status: string | null } | null)?.status ?? null
    // Paying = a real subscription. Includes 'trialing': checkout defers the
    // first charge to the product-trial end, so a Stripe-trialing subscription
    // means the card is already committed and the user should see the manage
    // view, not the upgrade pitch. Companies without a subscription (product
    // trial only, no card) stay on the upgrade path.
    isPaying = status === 'active' || status === 'past_due' || status === 'trialing'

    const { data: trial } = await supabase
      .from('capability_grants')
      .select('expires_at')
      .eq('company_id', companyId)
      .eq('source', 'trial')
      .order('expires_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    trialEndsAt = (trial as { expires_at: string | null } | null)?.expires_at ?? null

    // Team entitlement (WL-10): only consulted when the company isn't paying
    // on its own subscription. Service client by necessity: end clients are
    // not members of the byrå team, so RLS hides the team and its grants
    // from the user's session.
    if (!isPaying) {
      teamAgreement = await getTeamAgreement(createServiceClient(), companyId)
    }
  }

  return NextResponse.json({
    isPaying,
    configured: isStripeConfigured(),
    trialEndsAt,
    isDemo,
    ...(teamAgreement ? { teamAgreement } : {}),
  })
}
