import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { createServiceClient } from '@/lib/supabase/server'
import { getStripe, priceIdForPlan } from '@/lib/stripe/client'
import { guardSandbox, sandboxBlockedResponse } from '@/lib/sandbox/guard'

const CheckoutSchema = z.object({
  plan: z.enum(['monthly', 'yearly']).default('monthly'),
})

/**
 * Create a Stripe subscription Checkout Session and return its hosted URL.
 * The client redirects to it; provisioning happens via the webhook on
 * checkout.session.completed (never trust the success redirect for fulfilment).
 *
 * company_subscriptions is read/written via the service client on purpose —
 * the row is webhook-owned and not member-readable under RLS; every query
 * still filters by the membership-validated companyId.
 */
export const POST = withRouteContext('billing.checkout', async (request, ctx) => {
  const { user, supabase, companyId, log } = ctx

  // Demo accounts must never reach Stripe. An anonymous user has no real
  // identity to bill, and a sandbox company must never charge a token (same
  // doctrine as lib/sandbox/guard.ts: no real external side effects). Both
  // checks run before any Stripe call: this is the gap that let an anonymous
  // demo user create a live Stripe customer.
  if (user.is_anonymous) return sandboxBlockedResponse()
  const blocked = await guardSandbox(supabase, companyId)
  if (blocked) return blocked

  const validation = await validateBody(request, CheckoutSchema, {
    log,
    operation: 'billing.checkout',
  })
  if (!validation.success) return validation.response
  const { plan } = validation.data

  const priceId = priceIdForPlan(plan)
  if (!priceId) {
    return NextResponse.json(
      {
        error: {
          code: 'STRIPE_NOT_CONFIGURED',
          message: 'Betalning är inte konfigurerad. Kontakta supporten.',
          message_en: 'Stripe price not configured.',
        },
      },
      { status: 500 },
    )
  }

  const stripe = getStripe()
  const service = createServiceClient()

  // Reuse the company's Stripe customer if we already created one, and read
  // the trial expiry for the deferred-first-charge decision below. Independent
  // reads, so one round-trip batch.
  const [{ data: existing }, { data: trialGrant, error: trialGrantError }] = await Promise.all([
    service
      .from('company_subscriptions')
      .select('stripe_customer_id')
      .eq('company_id', companyId)
      .maybeSingle(),
    service
      .from('capability_grants')
      .select('expires_at')
      .eq('company_id', companyId)
      .eq('source', 'trial')
      .order('expires_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])

  // Fail closed on an uncertain trial state: proceeding on a lookup error
  // would silently charge immediately after the UI promised "0 kr idag".
  if (trialGrantError) {
    return NextResponse.json(
      {
        error: {
          code: 'TRIAL_LOOKUP_FAILED',
          message: 'Kunde inte läsa din provperiod. Försök igen om en stund.',
          message_en: 'Could not resolve the trial state. Try again shortly.',
        },
      },
      { status: 500 },
    )
  }

  // Defer the first charge to the end of an active trial. The company already
  // holds the paid capabilities free until then, so charging at checkout would
  // bill for days it already has; instead the subscription starts as
  // 'trialing' (which grants access via the webhook, see subscription-sync)
  // and the first charge lands when the product trial ends. Stripe Checkout
  // requires trial_end to be at least 48h in the future; closer than that, or
  // with no active trial, billing starts immediately.
  const trialExpiry = (trialGrant as { expires_at: string | null } | null)?.expires_at ?? null
  const trialExpiryMs = trialExpiry ? new Date(trialExpiry).getTime() : null
  const STRIPE_MIN_TRIAL_END_MS = 49 * 3600 * 1000 // Stripe's 48h floor + 1h clock margin
  const trialEnd =
    trialExpiryMs && trialExpiryMs - Date.now() > STRIPE_MIN_TRIAL_END_MS
      ? Math.floor(trialExpiryMs / 1000)
      : undefined

  let customerId = (existing as { stripe_customer_id: string | null } | null)?.stripe_customer_id ?? null
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email ?? undefined,
      metadata: { company_id: companyId },
    })
    customerId = customer.id
    await service
      .from('company_subscriptions')
      .upsert({ company_id: companyId, stripe_customer_id: customerId }, { onConflict: 'company_id' })
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? ''
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    client_reference_id: companyId,
    metadata: { company_id: companyId },
    subscription_data: {
      metadata: { company_id: companyId },
      ...(trialEnd ? { trial_end: trialEnd } : {}),
    },
    allow_promotion_codes: true,
    success_url: `${appUrl}/settings/billing?success=1`,
    cancel_url: `${appUrl}/settings/billing?canceled=1`,
  })

  return NextResponse.json({ url: session.url })
})
