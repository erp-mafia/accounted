import type { BillingPlan } from '@/lib/stripe/client'

export type PlanPrice = { exVat: number; incVat: number; perMonthEquivalent: number }

/** The price card for a plan billed at `exVat` (SEK, exkl. moms) per interval. */
export function planPrice(plan: BillingPlan, exVat: number): PlanPrice {
  return {
    exVat,
    incVat: Math.round(exVat * 125) / 100,
    perMonthEquivalent: plan === 'yearly' ? Math.floor(exVat / 12) : exVat,
  }
}

/**
 * List prices in SEK, exkl. moms, mirroring the Stripe Prices behind
 * STRIPE_PRICE_MONTHLY / STRIPE_PRICE_YEARLY (tax_behavior=exclusive, 25 %
 * added at checkout for Swedish customers). Displayed to companies that are
 * not paying yet; the charge itself is whatever Stripe computes.
 *
 * Raised 2026-10-22 from 199 / 1 999 to 249 a month or 2 388 a year (199 a
 * month billed yearly). A subscription started before that keeps its Stripe
 * price, so a paying company is shown the amount its own subscription
 * carries (`subscriptionAmountExVat` from /api/billing/status), never this
 * list.
 */
export const PLAN_PRICES: Record<BillingPlan, PlanPrice> = {
  monthly: planPrice('monthly', 249),
  yearly: planPrice('yearly', 2388),
}
