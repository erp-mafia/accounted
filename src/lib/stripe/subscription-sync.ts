import type { SupabaseClient } from '@supabase/supabase-js'
import type Stripe from 'stripe'
import { CAPABILITY, PAID_CAPABILITIES } from '@/lib/entitlements/keys'
import { createLogger } from '@/lib/logger'
import {
  billingInvoiceSkipReason,
  deliverBillingInvoiceToInbox,
  invoiceCustomerId,
  invoiceMetadataCompanyId,
  invoiceSubscriptionId,
} from './billing-invoice-inbox'
import { paymentPackPriceId, type BillingPlan } from './client'
import { syncCompanyStripeIdentity } from './customer-identity'
import { paymentPacksOn, periodEndOf, planItemOf } from './subscription-items'

const log = createLogger('stripe/subscription-sync')

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
  /**
   * Bank payment packs on the subscription (issue #132). Absent or null when
   * this installation sells no packs (STRIPE_PRICE_PAYMENTS_PACK unset): the
   * allowance row is then left as it is.
   */
  paymentPacks?: number | null
}

// The plan is read off the plan item, found by its price id: a pack item
// can come first in the list.
function planFromSubscription(sub: Stripe.Subscription): BillingPlan | null {
  const price = planItemOf(sub)?.price
  const priceId = price?.id
  if (priceId && priceId === process.env.STRIPE_PRICE_YEARLY) return 'yearly'
  if (priceId && priceId === process.env.STRIPE_PRICE_MONTHLY) return 'monthly'
  // Fallback by recurring interval if env price ids aren't wired up.
  const interval = price?.recurring?.interval
  if (interval === 'year') return 'yearly'
  if (interval === 'month') return 'monthly'
  return null
}

// The plan item's own period: with a monthly pack on a yearly plan, the
// subscription-level date is the pack's.
function periodEndIso(sub: Stripe.Subscription): string | null {
  const unix = periodEndOf(sub, planItemOf(sub))
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
    paymentPacks: paymentPackPriceId() ? paymentPacksOn(sub) : null,
  }
}

/**
 * Mirror the company's packs into company_bank_payment_allowances, the one
 * writer of purchased_packs (the webhook, and the purchase route with the
 * subscription Stripe returned). A company without packs gets no row: 0 only
 * clears a row that exists. Throws on a failed write, so the webhook answers
 * 500 and Stripe delivers the event again.
 */
export async function applyPaymentPacks(supabase: SupabaseClient, companyId: string, packs: number): Promise<void> {
  const table = supabase.from('company_bank_payment_allowances')
  const { error } =
    packs > 0
      ? await table.upsert({ company_id: companyId, purchased_packs: packs }, { onConflict: 'company_id' })
      : await table.update({ purchased_packs: 0 }).eq('company_id', companyId)
  if (error) throw new Error(`company_bank_payment_allowances write failed: ${error.message}`)
}

/**
 * A failed write throws, so the webhook answers 500 and Stripe delivers the
 * event again. Ignored, a failed grants write left a subscription row that
 * says paying beside no capability grants, and nothing retried it (crm#1736).
 */
function throwOnWriteError(table: string, result: { error: { message: string } | null }): void {
  if (result.error) throw new Error(`${table} write failed: ${result.error.message}`)
}

/**
 * Reconcile a company's subscription state into the DB: upsert
 * company_subscriptions, then either grant or remove the stripe capability
 * grants, then mirror the bank payment packs. Idempotent: safe to run on
 * duplicate/retried events. Throws on the first failed write; the writes
 * before it are applied again, unchanged, when Stripe delivers the event again.
 */
export async function applySubscriptionState(
  supabase: SupabaseClient,
  state: SubscriptionState,
): Promise<void> {
  throwOnWriteError(
    'company_subscriptions',
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
    ),
  )

  if (statusGrantsAccess(state.status)) {
    // Grant a few days past the period end so a brief renewal-webhook delay
    // never flips a paying customer to blocked.
    const expiresAt = state.currentPeriodEnd
      ? new Date(new Date(state.currentPeriodEnd).getTime() + 3 * 24 * 3600 * 1000).toISOString()
      : null
    // Every PAID key, the paid-plan-only ones included (none since
    // 2026-10-22, when collections joined the trial).
    const rows = PAID_CAPABILITIES.map((key) => ({
      company_id: state.companyId,
      capability_key: key,
      source: 'stripe',
      expires_at: expiresAt,
    }))
    throwOnWriteError(
      'capability_grants',
      await supabase
        .from('capability_grants')
        .upsert(rows, { onConflict: 'company_id,team_id,capability_key,source' }),
    )
  } else {
    // Freeze-and-retain: drop only the stripe grants. Trial/comp grants (if any)
    // are untouched; data and tokens are never deleted.
    //
    // multi_user is the one exception to the delete: its 20-day grace window
    // hangs on "the newest grant EXPIRED less than 20 days ago"
    // (lib/entitlements/multi-user-state.ts), so a deleted row would freeze a
    // churned payer's non-owner members instantly, with no countdown banner
    // and no owner mail. Expiring the row NOW anchors the grace exactly at
    // the cancellation, and the grace cron's start-mail window picks it up.
    // Only a still-active row is expired: a re-delivered cancel event days
    // later must not slide the grace anchor (and the mail window) forward.
    throwOnWriteError(
      'capability_grants',
      await supabase
        .from('capability_grants')
        .delete()
        .eq('company_id', state.companyId)
        .eq('source', 'stripe')
        .neq('capability_key', CAPABILITY.multi_user),
    )
    throwOnWriteError(
      'capability_grants',
      await supabase
        .from('capability_grants')
        .update({ expires_at: new Date().toISOString() })
        .eq('company_id', state.companyId)
        .eq('source', 'stripe')
        .eq('capability_key', CAPABILITY.multi_user)
        .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`),
    )
  }

  // A lapsed plan takes its packs with it: the cap falls back to the base
  // the moment access ends, whatever quantity the dead subscription lists.
  if (typeof state.paymentPacks === 'number') {
    await applyPaymentPacks(supabase, state.companyId, statusGrantsAccess(state.status) ? state.paymentPacks : 0)
  }
}

/** The one company whose row holds this subscription or customer; null when none or several do. */
async function soleCompany(
  query: PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<string | null> {
  const { data, error } = await query
  // Thrown, not read as "unknown": a guess at the company could write the
  // wrong one, and the webhook answers 500 so Stripe delivers the event again.
  if (error) throw new Error(`company_subscriptions lookup failed: ${error.message}`)
  const rows = (data ?? []) as Array<{ company_id: string }>
  return rows.length === 1 ? rows[0].company_id : null
}

/**
 * The company a subscription event is for. The mirror leads: a migration
 * reset moves the company_subscriptions row to the replacement company but
 * leaves the subscription's metadata naming the archived source, so an event
 * resolved by metadata first wrote the source's row and grants and let the
 * paying replacement's grants lapse. Metadata answers only when no single
 * row holds the subscription or its customer, as for an event that outruns
 * the row checkout writes.
 */
async function companyIdFor(
  supabase: SupabaseClient,
  ref: { subscriptionId: string | null; customerId: string | null; metadataCompanyId: string | null },
): Promise<string | null> {
  return (
    (ref.subscriptionId
      ? await soleCompany(
          supabase.from('company_subscriptions').select('company_id').eq('stripe_subscription_id', ref.subscriptionId).limit(2),
        )
      : null) ??
    (ref.customerId
      ? await soleCompany(
          supabase.from('company_subscriptions').select('company_id').eq('stripe_customer_id', ref.customerId).limit(2),
        )
      : null) ??
    ref.metadataCompanyId ??
    null
  )
}

function companyIdForSubscription(supabase: SupabaseClient, sub: Stripe.Subscription): Promise<string | null> {
  return companyIdFor(supabase, {
    subscriptionId: sub.id,
    customerId: typeof sub.customer === 'string' ? sub.customer : sub.customer.id,
    metadataCompanyId: sub.metadata?.company_id ?? null,
  })
}

/**
 * The identity sync never fails the webhook: the access state above is what
 * the event is for, and a Stripe retry of the whole event over a customer
 * update would only repeat it. The next subscription event writes it again.
 */
async function syncIdentityBestEffort(
  supabase: SupabaseClient,
  stripe: Stripe,
  companyId: string,
  customerId: string | null,
): Promise<void> {
  try {
    await syncCompanyStripeIdentity(supabase, companyId, { stripe, customerId })
  } catch (err) {
    log.error('writing the company identity onto its Stripe customer failed', err as Error, { companyId })
  }
}

/**
 * The subscription as Stripe holds it now, not the copy the event carried. A
 * failed write answers 500 and Stripe delivers that event again, possibly
 * after a later event of the same subscription has been applied: the event's
 * own copy would then roll the state back (a "created" event still
 * 'incomplete', delivered again after the 'active' update, would remove the
 * new payer's grants). Re-read, every delivery applies the same, current
 * state (crm#1736). A subscription Stripe no longer has is left with the copy.
 */
async function currentSubscription(stripe: Stripe, carried: Stripe.Subscription): Promise<Stripe.Subscription> {
  try {
    return await stripe.subscriptions.retrieve(carried.id)
  } catch (err) {
    if ((err as { code?: string } | null)?.code === 'resource_missing') return carried
    throw err
  }
}

/**
 * Route a verified Stripe event to a state reconciliation. Subscription
 * lifecycle events set access; a paid invoice is filed into the paying
 * company's Inkorg; everything else is a no-op (already ack'd 200).
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
      const sub = await currentSubscription(stripe, event.data.object as Stripe.Subscription)
      const companyId = await companyIdForSubscription(supabase, sub)
      if (!companyId) return
      const state = subscriptionToState(sub, companyId)
      await applySubscriptionState(supabase, state)
      // Keep the customer's name, address and tax IDs the company's own
      // (crm#1378). A renewal sends this event while its invoice is still a
      // draft, which takes the customer's details when it is finalized.
      if (event.type !== 'customer.subscription.deleted' && statusGrantsAccess(state.status)) {
        await syncIdentityBestEffort(supabase, stripe, companyId, state.stripeCustomerId)
      }
      return
    }
    case 'invoice.paid': {
      // Our own invoice is the underlag of the company's card payment (PH 191):
      // filed into the paying company's Inkorg, resolved as the subscription
      // events resolve it, for match on arrival to pair with the bank row.
      const invoice = event.data.object as Stripe.Invoice
      if (billingInvoiceSkipReason(invoice)) return
      const companyId = await companyIdFor(supabase, {
        subscriptionId: invoiceSubscriptionId(invoice),
        customerId: invoiceCustomerId(invoice),
        metadataCompanyId: invoiceMetadataCompanyId(invoice),
      })
      if (!companyId) return
      await deliverBillingInvoiceToInbox(supabase, stripe, { invoice, companyId })
      return
    }
    default:
      // invoice.payment_failed etc.: Stripe also emits subscription.updated
      // (-> past_due / canceled), which the cases above handle. No-op here.
      return
  }
}
