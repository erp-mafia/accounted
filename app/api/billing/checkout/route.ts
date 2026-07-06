import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { createServiceClient } from '@/lib/supabase/server'
import { getStripe, priceIdForPlan } from '@/lib/stripe/client'

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
  const { user, companyId, log } = ctx

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

  // Reuse the company's Stripe customer if we already created one.
  const { data: existing } = await service
    .from('company_subscriptions')
    .select('stripe_customer_id')
    .eq('company_id', companyId)
    .maybeSingle()

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
    subscription_data: { metadata: { company_id: companyId } },
    allow_promotion_codes: true,
    success_url: `${appUrl}/settings/billing?success=1`,
    cancel_url: `${appUrl}/settings/billing?canceled=1`,
  })

  return NextResponse.json({ url: session.url })
})
