import Stripe from 'stripe'

let cached: Stripe | null = null

/**
 * Singleton Stripe client. Throws if STRIPE_SECRET_KEY is unset so misconfig
 * fails loudly at call time rather than silently no-opping. The API version is
 * pinned by the installed SDK (stripe@22), which is the recommended stable
 * default: do not hardcode a version string that can drift from the SDK types.
 */
export function getStripe(): Stripe {
  if (cached) return cached
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) throw new Error('STRIPE_SECRET_KEY is not configured')
  cached = new Stripe(key)
  return cached
}

export type BillingPlan = 'monthly' | 'yearly'

/** Stripe Price id for a plan, from env. Returns undefined if not configured. */
export function priceIdForPlan(plan: BillingPlan): string | undefined {
  return plan === 'yearly'
    ? process.env.STRIPE_PRICE_YEARLY
    : process.env.STRIPE_PRICE_MONTHLY
}

/** Whether Stripe checkout is configured (used to gate the upgrade CTA). */
export function isStripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_MONTHLY)
}
