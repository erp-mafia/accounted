import type Stripe from 'stripe'
import { getStripe, priceIdForPlan } from './client'
import { idOf } from './subscription-items'

/**
 * The Stripe customer portal, opened on a configuration whose plan switch
 * offers exactly the prices checkout sells (STRIPE_PRICE_MONTHLY and
 * STRIPE_PRICE_YEARLY) and nothing else.
 *
 * A session opened without a configuration uses the account's default one,
 * whose plan list is kept by hand in the Stripe Dashboard and can offer
 * retired prices after a price change.
 * Here the list comes from the env checkout reads: a configuration is looked
 * up by the prices it offers and made on first use after a price change, so
 * the portal and checkout cannot disagree. A configuration someone edits in
 * the Dashboard stops matching and is replaced, never followed.
 */

/** Marks configurations made here. Bump it when the features below change, so sessions move to a new one. */
const MANAGED_BY = { key: 'accounted_portal', version: 'v1' } as const

function planPriceIds(): string[] {
  return [priceIdForPlan('monthly'), priceIdForPlan('yearly')].filter((id): id is string => Boolean(id))
}

function offeredPrices(config: Stripe.BillingPortal.Configuration): string[] {
  const update = config.features.subscription_update
  return update.enabled ? (update.products ?? []).flatMap((product) => product.prices) : []
}

function samePrices(a: string[], b: string[]): boolean {
  return [...a].sort().join(',') === [...b].sort().join(',')
}

async function findConfiguration(stripe: Stripe, prices: string[]): Promise<string | null> {
  const configurations = stripe.billingPortal.configurations.list({
    active: true,
    limit: 100,
    // Stripe leaves the plan list out of a configuration unless it is asked for.
    expand: ['data.features.subscription_update.products'],
  })
  for await (const config of configurations) {
    if (config.metadata?.[MANAGED_BY.key] === MANAGED_BY.version && samePrices(offeredPrices(config), prices)) {
      return config.id
    }
  }
  return null
}

async function createConfiguration(stripe: Stripe, prices: string[]): Promise<string> {
  const pricesByProduct = new Map<string, string[]>()
  for (const id of prices) {
    const product = idOf((await stripe.prices.retrieve(id)).product)
    if (!product) throw new Error(`Stripe price ${id} has no product`)
    pricesByProduct.set(product, [...(pricesByProduct.get(product) ?? []), id])
  }

  // The settings the default configuration had in the Dashboard, except
  // quantity: a company has one plan, so the portal never offers more.
  const config = await stripe.billingPortal.configurations.create({
    business_profile: { headline: 'Accounted är partner till Stripe för enklare fakturering' },
    features: {
      customer_update: { enabled: true, allowed_updates: ['name', 'email', 'address', 'phone'] },
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: {
        enabled: true,
        mode: 'at_period_end',
        proration_behavior: 'none',
        cancellation_reason: {
          enabled: true,
          options: ['too_expensive', 'switched_service', 'other', 'customer_service', 'too_complex', 'missing_features', 'unused', 'low_quality'],
        },
      },
      subscription_update:
        pricesByProduct.size === 0
          ? { enabled: false }
          : {
              enabled: true,
              default_allowed_updates: ['price'],
              products: [...pricesByProduct].map(([product, productPrices]) => ({
                product,
                prices: productPrices,
                adjustable_quantity: { enabled: false },
              })),
              proration_behavior: 'always_invoice',
              billing_cycle_anchor: 'unchanged',
              trial_update_behavior: 'end_trial',
            },
    },
    metadata: { [MANAGED_BY.key]: MANAGED_BY.version },
  })
  return config.id
}

/** A portal session that can only switch the company to the prices checkout sells. */
export async function createPortalSession(
  params: Omit<Stripe.BillingPortal.SessionCreateParams, 'configuration'>,
): Promise<Stripe.BillingPortal.Session> {
  const stripe = getStripe()
  const prices = planPriceIds()
  const configuration = (await findConfiguration(stripe, prices)) ?? (await createConfiguration(stripe, prices))
  return stripe.billingPortal.sessions.create({ ...params, configuration })
}
