import type { SupabaseClient } from '@supabase/supabase-js'
import type Stripe from 'stripe'
import { statusGrantsAccess } from './subscription-sync'

/**
 * A company's own Stripe subscriptions, asked of Stripe itself (crm#1373).
 *
 * company_subscriptions is a mirror the webhook writes: one row per company,
 * holding whichever subscription last sent an event, and lagging Stripe by
 * the webhook delivery. Whether the company already pays is Stripe's answer
 * for the company's customer: every subscription there that is not over and
 * is the company's (the row's subscription, or one whose metadata names the
 * company; a customer reused across a migration reset carries both).
 */

/** The company's Stripe customer and the subscription the mirror holds. */
export interface CompanyStripeRef {
  customerId: string
  subscriptionId: string | null
}

// Statuses after which a subscription never charges again.
const ENDED_STATUSES = new Set(['canceled', 'incomplete_expired'])

/** Reads the company's mirror row; null when it never had a customer. Throws on a failed read. */
export async function readCompanyStripeRef(
  db: Pick<SupabaseClient, 'from'>,
  companyId: string,
): Promise<CompanyStripeRef | null> {
  const { data, error } = await db
    .from('company_subscriptions')
    .select('stripe_customer_id, stripe_subscription_id')
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw new Error(`company_subscriptions lookup failed: ${error.message}`)
  const row = data as { stripe_customer_id: string | null; stripe_subscription_id: string | null } | null
  if (!row?.stripe_customer_id) return null
  return { customerId: row.stripe_customer_id, subscriptionId: row.stripe_subscription_id }
}

/** The company's subscriptions on its customer that are not over yet. Throws on a Stripe error. */
export async function liveCompanySubscriptions(
  stripe: Stripe,
  companyId: string,
  ref: CompanyStripeRef,
): Promise<Stripe.Subscription[]> {
  // Without a status filter Stripe lists every subscription not canceled.
  const { data } = await stripe.subscriptions.list({ customer: ref.customerId, limit: 100 })
  return data.filter(
    (sub) =>
      !ENDED_STATUSES.has(sub.status) &&
      (sub.id === ref.subscriptionId || sub.metadata?.company_id === companyId),
  )
}

/**
 * The subscription the company already pays with (active, trialing or
 * past_due), or null. Stripe is asked, not the mirror: a checkout completed
 * a moment ago has not reached the mirror yet, and a mirror that missed a
 * cancellation must not lock the company out of subscribing again.
 */
export async function payingCompanySubscription(
  stripe: Stripe,
  companyId: string,
  ref: CompanyStripeRef,
): Promise<string | null> {
  const live = await liveCompanySubscriptions(stripe, companyId, ref)
  return live.find((sub) => statusGrantsAccess(sub.status))?.id ?? null
}

/**
 * Ends every live subscription of the company, at once, so a deleted company
 * is never charged again. Stripe's default cancel: no proration and no
 * refund; the webhook then marks the row canceled and drops the stripe
 * grants. Returns the ids it ended. Throws on any Stripe error, so the caller
 * can refuse to hide a company that would keep being charged.
 */
export async function endCompanySubscriptions(
  stripe: Stripe,
  companyId: string,
  ref: CompanyStripeRef,
): Promise<string[]> {
  const live = await liveCompanySubscriptions(stripe, companyId, ref)
  const ended: string[] = []
  for (const sub of live) {
    await stripe.subscriptions.cancel(sub.id)
    ended.push(sub.id)
  }
  return ended
}
