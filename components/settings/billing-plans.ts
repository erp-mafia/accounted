import type { BillingPlan } from '@/lib/stripe/client'

/**
 * List prices in SEK, exkl. moms, mirroring the Stripe Prices behind
 * STRIPE_PRICE_MONTHLY / STRIPE_PRICE_YEARLY (tax_behavior=exclusive, 25 %
 * added at checkout for Swedish customers). Displayed on the billing page
 * only; the charge itself is whatever Stripe computes.
 */
export const PLAN_PRICES: Record<BillingPlan, { exVat: number; incVat: number; perMonthEquivalent: number }> = {
  monthly: { exVat: 199, incVat: 248.75, perMonthEquivalent: 199 },
  yearly: { exVat: 1999, incVat: 2498.75, perMonthEquivalent: 166 },
}
