/**
 * Whether a company pays for a subscription of its own: the condition for
 * use above what a month includes. Only an active Stripe subscription
 * outside a sandbox counts. A trial (trialing, or a trial grant without a
 * subscription), a free period granted by hand and a lapsed subscription do
 * not: such a company stops at what is included until it subscribes, and is
 * never billed for more.
 *
 * Imports nothing outside Supabase, so the payments cap
 * (lib/payments/usage.ts) can read it without a cycle.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export interface SubscriptionFacts {
  isSandbox: boolean
  status: string | null
  customerId: string | null
  subscriptionId: string | null
}

export function subscriptionPays(facts: SubscriptionFacts): boolean {
  return !facts.isSandbox && facts.status === 'active' && !!facts.customerId && !!facts.subscriptionId
}

/** One company's answer. Throws on a failed read. */
export async function readCompanyPays(db: SupabaseClient, companyId: string): Promise<boolean> {
  const [subscription, settings] = await Promise.all([
    db.from('company_subscriptions').select('status, stripe_customer_id, stripe_subscription_id').eq('company_id', companyId).maybeSingle(),
    db.from('company_settings').select('is_sandbox').eq('company_id', companyId).maybeSingle(),
  ])
  if (subscription.error) throw new Error(`company_subscriptions read failed: ${subscription.error.message}`)
  if (settings.error) throw new Error(`company_settings read failed: ${settings.error.message}`)
  const sub = subscription.data as { status: string | null; stripe_customer_id: string | null; stripe_subscription_id: string | null } | null
  return subscriptionPays({
    isSandbox: (settings.data as { is_sandbox: boolean | null } | null)?.is_sandbox === true,
    status: sub?.status ?? null,
    customerId: sub?.stripe_customer_id ?? null,
    subscriptionId: sub?.stripe_subscription_id ?? null,
  })
}
