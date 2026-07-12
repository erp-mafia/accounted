import type { SupabaseClient } from '@supabase/supabase-js'
import type Stripe from 'stripe'
import { PAID_CAPABILITIES } from '@/lib/entitlements/keys'
import type { BillingPlan } from './client'

/**
 * Stripe → DB reconciliation for subscriptions. The single source of truth for
 * paid access is capability_grants(source='stripe'); this module writes those
 * grants from subscription state and removes them on cancellation
 * (freeze-and-retain: only the stripe grants are touched, never bank tokens or
 * AI data).
 */

// Statuses that should keep paid access on. past_due stays on as a grace window
// (Stripe's dunning retries the charge); access is revoked only once the
// subscription is genuinely canceled/unpaid.
const ACCESS_STATUSES = new Set(['active', 'trialing', 'past_due'])

export function statusGrantsAccess(status: string | null | undefined): boolean {
  return !!status && ACCESS_STATUSES.has(status)
}

export interface SubscriptionState {
  companyId: string
  stripeCustomerId: string | null
  stripeSubscriptionId: string | null
  status: string | null
  plan: BillingPlan | null
  currentPeriodEnd: string | null // ISO
}

function planFromSubscription(sub: Stripe.Subscription): BillingPlan | null {
  const price = sub.items.data[0]?.price
  const priceId = price?.id
  if (priceId && priceId === process.env.STRIPE_PRICE_YEARLY) return 'yearly'
  if (priceId && priceId === process.env.STRIPE_PRICE_MONTHLY) return 'monthly'
  // Fallback by recurring interval if env price ids aren't wired up.
  const interval = price?.recurring?.interval
  if (interval === 'year') return 'yearly'
  if (interval === 'month') return 'monthly'
  return null
}

// current_period_end lives on the Subscription in older API versions and on the
// subscription item in newer ones: read defensively so SDK/API drift can't
// break the build or the expiry calc.
function periodEndIso(sub: Stripe.Subscription): string | null {
  const s = sub as unknown as {
    current_period_end?: number
    items?: { data?: Array<{ current_period_end?: number }> }
  }
  const unix = s.current_period_end ?? s.items?.data?.[0]?.current_period_end ?? null
  return unix ? new Date(unix * 1000).toISOString() : null
}

export function subscriptionToState(sub: Stripe.Subscription, companyId: string): SubscriptionState {
  return {
    companyId,
    stripeCustomerId: typeof sub.customer === 'string' ? sub.customer : (sub.customer?.id ?? null),
    stripeSubscriptionId: sub.id,
    status: sub.status,
    plan: planFromSubscription(sub),
    currentPeriodEnd: periodEndIso(sub),
  }
}

/**
 * Reconcile a company's subscription state into the DB: upsert
 * company_subscriptions, then either grant or remove the stripe capability
 * grants. Idempotent: safe to run on duplicate/retried events.
 */
export async function applySubscriptionState(
  supabase: SupabaseClient,
  state: SubscriptionState,
): Promise<void> {
  await supabase.from('company_subscriptions').upsert(
    {
      company_id: state.companyId,
      stripe_customer_id: state.stripeCustomerId,
      stripe_subscription_id: state.stripeSubscriptionId,
      status: state.status,
      plan: state.plan,
      current_period_end: state.currentPeriodEnd,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'company_id' },
  )

  if (statusGrantsAccess(state.status)) {
    // Grant a few days past the period end so a brief renewal-webhook delay
    // never flips a paying customer to blocked.
    const expiresAt = state.currentPeriodEnd
      ? new Date(new Date(state.currentPeriodEnd).getTime() + 3 * 24 * 3600 * 1000).toISOString()
      : null
    const rows = PAID_CAPABILITIES.map((key) => ({
      company_id: state.companyId,
      capability_key: key,
      source: 'stripe',
      expires_at: expiresAt,
    }))
    await supabase
      .from('capability_grants')
      .upsert(rows, { onConflict: 'company_id,team_id,capability_key,source' })
  } else {
    // Freeze-and-retain: drop only the stripe grants. Trial/comp grants (if any)
    // are untouched; data and tokens are never deleted.
    await supabase
      .from('capability_grants')
      .delete()
      .eq('company_id', state.companyId)
      .eq('source', 'stripe')
  }
}

async function companyIdForCustomer(
  supabase: SupabaseClient,
  customerId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from('company_subscriptions')
    .select('company_id')
    .eq('stripe_customer_id', customerId)
    .maybeSingle()
  return (data as { company_id: string } | null)?.company_id ?? null
}

/**
 * Route a verified Stripe event to a state reconciliation. Only subscription
 * lifecycle events matter; everything else is a no-op (already ack'd 200).
 */
export async function handleStripeEvent(
  supabase: SupabaseClient,
  stripe: Stripe,
  event: Stripe.Event,
): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session
      if (session.mode !== 'subscription' || !session.subscription) return
      const sub = await stripe.subscriptions.retrieve(session.subscription as string)
      const companyId =
        session.metadata?.company_id ??
        session.client_reference_id ??
        sub.metadata?.company_id ??
        null
      if (companyId) await applySubscriptionState(supabase, subscriptionToState(sub, companyId))
      return
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription
      const companyId =
        sub.metadata?.company_id ??
        (await companyIdForCustomer(supabase, typeof sub.customer === 'string' ? sub.customer : sub.customer.id))
      if (companyId) await applySubscriptionState(supabase, subscriptionToState(sub, companyId))
      return
    }
    default:
      // invoice.payment_failed etc.: Stripe also emits subscription.updated
      // (-> past_due / canceled), which the cases above handle. No-op here.
      return
  }
}
