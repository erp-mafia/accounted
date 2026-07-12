import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { createServiceClient } from '@/lib/supabase/server'
import { getStripe } from '@/lib/stripe/client'
import { guardSandbox, sandboxBlockedResponse } from '@/lib/sandbox/guard'

/**
 * Create a Stripe Billing Customer Portal session so the user can manage,
 * upgrade/downgrade, or cancel their subscription. Stripe handles all the
 * compliance/PCI surface: we never build those flows ourselves.
 *
 * company_subscriptions is read via the service client on purpose: the row
 * is webhook-owned and not member-readable under RLS; the query still filters
 * by the membership-validated companyId.
 */
export const POST = withRouteContext('billing.portal', async (_request, ctx) => {
  const { user, supabase, companyId } = ctx

  // Demo accounts must never reach Stripe (see billing/checkout for the full
  // rationale). Defense in depth: a demo tenant should never own a portal
  // session even if a stray customer row exists.
  if (user.is_anonymous) return sandboxBlockedResponse()
  const blocked = await guardSandbox(supabase, companyId)
  if (blocked) return blocked

  const service = createServiceClient()
  const { data: sub } = await service
    .from('company_subscriptions')
    .select('stripe_customer_id')
    .eq('company_id', companyId)
    .maybeSingle()

  const customerId = (sub as { stripe_customer_id: string | null } | null)?.stripe_customer_id
  if (!customerId) {
    return NextResponse.json(
      {
        error: {
          code: 'NO_SUBSCRIPTION',
          message: 'Det finns inget abonnemang att hantera.',
          message_en: 'No subscription to manage.',
        },
      },
      { status: 400 },
    )
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? ''
  const portal = await getStripe().billingPortal.sessions.create({
    customer: customerId,
    return_url: `${appUrl}/settings/billing`,
  })

  return NextResponse.json({ url: portal.url })
})
