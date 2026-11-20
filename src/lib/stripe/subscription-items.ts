import type Stripe from 'stripe'
import { paymentPackPriceId } from './client'

/**
 * Which item of a company's subscription is what. A subscription carries the
 * plan and, once an owner buys bank payment packs, a pack item too (issue
 * #132), in whatever order Stripe lists them: an item is told by its price
 * id, never by its place in the list.
 */

/** The id of an expandable Stripe reference: the id itself, or the expanded object's. */
export function idOf(ref: string | { id: string } | null | undefined): string | undefined {
  return typeof ref === 'string' ? ref : (ref?.id ?? undefined)
}

function itemsOf(sub: Stripe.Subscription): Stripe.SubscriptionItem[] {
  return sub.items?.data ?? []
}

function priceIdOf(item: Stripe.SubscriptionItem): string | undefined {
  return idOf(item.price as Stripe.Price | string | undefined)
}

/**
 * The plan item: the one on the monthly or yearly plan price. Where the env
 * plan price ids are not wired (development, a self-host with its own
 * prices), the first item that is not a pack.
 */
export function planItemOf(sub: Stripe.Subscription): Stripe.SubscriptionItem | null {
  const items = itemsOf(sub)
  const plans = [process.env.STRIPE_PRICE_MONTHLY, process.env.STRIPE_PRICE_YEARLY].filter((id): id is string => Boolean(id))
  const byPrice = items.find((item) => plans.includes(priceIdOf(item) ?? ''))
  if (byPrice) return byPrice
  const pack = paymentPackPriceId()
  return items.find((item) => !pack || priceIdOf(item) !== pack) ?? null
}

/** The bank payments pack item, or null (none bought, or packs not sold here). */
export function paymentPackItemOf(sub: Stripe.Subscription): Stripe.SubscriptionItem | null {
  const pack = paymentPackPriceId()
  if (!pack) return null
  return itemsOf(sub).find((item) => priceIdOf(item) === pack) ?? null
}

/** Packs the subscription carries right now. */
export function paymentPacksOn(sub: Stripe.Subscription): number {
  const quantity = paymentPackItemOf(sub)?.quantity
  return typeof quantity === 'number' && quantity > 0 ? quantity : 0
}

/**
 * An item's current period end (unix seconds). current_period_end lives on
 * the item in newer API versions and on the subscription in older ones: read
 * defensively so SDK/API drift cannot break the expiry or a decrease date.
 */
export function periodEndOf(sub: Stripe.Subscription, item: Stripe.SubscriptionItem | null): number | null {
  const onItem = (item as unknown as { current_period_end?: number } | null)?.current_period_end
  const onSub = (sub as unknown as { current_period_end?: number }).current_period_end
  return onItem ?? onSub ?? null
}

/** A cancellation is pending: at the period end or on a set date. */
export function isCancelling(sub: Stripe.Subscription): boolean {
  return Boolean(sub.cancel_at_period_end || sub.cancel_at)
}

/** A price's amount in SEK exkl. moms (our prices are tax-exclusive), or null for another currency or no unit amount. */
export function sekAmountOf(price: Stripe.Price | null | undefined): number | null {
  return price && price.currency === 'sek' && typeof price.unit_amount === 'number' ? price.unit_amount / 100 : null
}
