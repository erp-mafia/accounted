import type Stripe from 'stripe'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CompanyRole } from '@/types'
import { createLogger, type Logger } from '@/lib/logger'
import { BANK_PAYMENTS_PER_PACK, bankPaymentsBilled, readBankPaymentsAllowance } from '@/lib/payments/usage'
import { paymentsAdmitted } from '@/lib/payments/orders/pilot'
import { getStripe, paymentPackPriceId, paymentPacksConfigured } from './client'
import { idOf, isCancelling, paymentPackItemOf, periodEndOf, planItemOf, sekAmountOf } from './subscription-items'

/**
 * Bank payment packs (issue #132): an owner buys packs of
 * BANK_PAYMENTS_PER_PACK bank payments a month on the company's own Stripe
 * subscription, as a second item on the pack price (quantity = packs).
 *
 * - More packs take effect now: the item quantity is raised with the rest of
 *   the period charged at once (always_invoice), and a declined card leaves
 *   the subscription as it was (error_if_incomplete).
 * - Fewer packs take effect at the period end: a subscription schedule of
 *   ours (metadata.purpose) keeps the current phase and lowers the quantity
 *   in the next. Until then the company keeps what it paid for.
 * - Only an active subscription that is not on its way out takes a change:
 *   a trial would get packs free until its first charge, and a past-due card
 *   should not be charged more.
 *
 * Stripe stays the record of what is bought; purchased_packs mirrors the
 * item's live quantity (subscription-sync.ts applyPaymentPacks), so the cap
 * follows a scheduled decrease when Stripe applies it, through the webhook.
 */

const log = createLogger('stripe/payment-packs')

/** Most packs a company can hold: 10,000 payments a month on top of the base. */
export const MAX_PAYMENT_PACKS = 100

/** Marks the schedules this module makes, so a plan change made in the portal is never rewritten. */
const PACK_SCHEDULE_PURPOSE = 'bank_payment_packs'

/** A decrease waiting for the period end. */
export interface ScheduledPacks {
  packs: number
  /** ISO instant the decrease takes effect. */
  at: string
}

type PaymentPacksRefusal =
  | 'PAYMENT_PACKS_NOT_OFFERED'
  | 'PAYMENT_PACKS_SUBSCRIPTION_NOT_ACTIVE'
  | 'PAYMENT_PACKS_PLAN_CHANGE_PENDING'
  | 'PAYMENT_PACKS_PLAN_INTERVAL'
  | 'PAYMENT_PACKS_PAYMENT_FAILED'

export type PaymentPacksChange =
  /** `updated` is the subscription Stripe returned when the quantity changed now (an increase); null otherwise. */
  | { ok: true; scheduled: ScheduledPacks | null; updated: Stripe.Subscription | null }
  | { ok: false; code: PaymentPacksRefusal }

function isoOf(unix: number): string {
  return new Date(unix * 1000).toISOString()
}

/**
 * Whether the pack price can sit on this subscription at all: Stripe mixes
 * intervals on one subscription (a monthly pack on a yearly plan) only in
 * flexible billing mode, so a plan billed on another interval than the pack
 * in classic mode gets no packs (its owner asks for more instead).
 */
function packFitsSubscription(sub: Stripe.Subscription, packPrice: Stripe.Price): boolean {
  if ((sub as unknown as { billing_mode?: { type?: string } }).billing_mode?.type === 'flexible') return true
  const plan = planItemOf(sub)?.price as Stripe.Price | string | undefined
  const a = typeof plan === 'string' ? null : plan?.recurring
  const b = packPrice.recurring
  return Boolean(a && b && a.interval === b.interval && (a.interval_count ?? 1) === (b.interval_count ?? 1))
}

function isOurs(schedule: Stripe.SubscriptionSchedule): boolean {
  return schedule.metadata?.purpose === PACK_SCHEDULE_PURPOSE
}

/** The live subscription with its schedule, and the pack price: what every pack decision is made on. */
interface PackState {
  sub: Stripe.Subscription
  schedule: Stripe.SubscriptionSchedule | null
  price: Stripe.Price
}

async function readPackState(stripe: Stripe, subscriptionId: string, packPriceId: string): Promise<PackState> {
  const [sub, price] = await Promise.all([
    stripe.subscriptions.retrieve(subscriptionId, { expand: ['schedule'] }),
    stripe.prices.retrieve(packPriceId),
  ])
  const ref = sub.schedule
  const schedule = !ref ? null : typeof ref === 'string' ? await stripe.subscriptionSchedules.retrieve(ref) : ref
  return { sub, schedule, price }
}

/**
 * Why the subscription takes no pack change now, or null when it does: the
 * one list of rules, so the dialogs never offer what the purchase refuses.
 * - A price we cannot state (not SEK, no amount) is not sold.
 * - Only an active subscription that is not cancelling: a trial would get
 *   packs free until its first charge, a past-due card is not charged more.
 * - A plan change waiting from the portal is never rewritten.
 * - The first pack adds an item, which must fit the plan's interval.
 */
function packRefusal({ sub, schedule, price }: PackState): PaymentPacksRefusal | null {
  if (sekAmountOf(price) === null) return 'PAYMENT_PACKS_NOT_OFFERED'
  if (sub.status !== 'active' || isCancelling(sub)) return 'PAYMENT_PACKS_SUBSCRIPTION_NOT_ACTIVE'
  if (schedule && !isOurs(schedule)) return 'PAYMENT_PACKS_PLAN_CHANGE_PENDING'
  if (!paymentPackItemOf(sub) && !packFitsSubscription(sub, price)) return 'PAYMENT_PACKS_PLAN_INTERVAL'
  return null
}

function currentPhaseOf(schedule: Stripe.SubscriptionSchedule): Stripe.SubscriptionSchedule.Phase | null {
  const start = schedule.current_phase?.start_date
  return schedule.phases.find((phase) => phase.start_date === start) ?? null
}

/** The decrease a schedule of ours holds: the pack quantity of the phase after the current one, and when it starts. */
export function scheduledPacksOf(schedule: Stripe.SubscriptionSchedule | null, packPriceId: string): ScheduledPacks | null {
  if (!schedule || !isOurs(schedule)) return null
  const current = currentPhaseOf(schedule)
  if (!current) return null
  const next = schedule.phases.find((phase) => phase.start_date >= current.end_date)
  if (!next) return null
  const item = next.items.find((i) => idOf(i.price) === packPriceId)
  return { packs: item?.quantity ?? 0, at: isoOf(next.start_date) }
}

/**
 * Where a decrease lands: the end of the subscription's current period, the
 * earliest of its items' (what from_subscription makes the schedule's
 * current phase end on, and with a monthly pack the pack's own period end).
 */
function packPeriodEnd(sub: Stripe.Subscription): string | null {
  const ends = (sub.items?.data ?? []).map((item) => periodEndOf(sub, item)).filter((end): end is number => end !== null)
  return ends.length ? isoOf(Math.min(...ends)) : null
}

type PhaseDiscount = { coupon: string | { id: string } | null; discount: string | { id: string } | null; promotion_code: string | { id: string } | null }

function discountParams(discounts: readonly PhaseDiscount[] | null | undefined): Stripe.SubscriptionScheduleUpdateParams.Phase.Discount[] {
  return (discounts ?? []).flatMap((d): Stripe.SubscriptionScheduleUpdateParams.Phase.Discount[] => {
    const discount = idOf(d.discount)
    if (discount) return [{ discount }]
    const promotionCode = idOf(d.promotion_code)
    if (promotionCode) return [{ promotion_code: promotionCode }]
    const coupon = idOf(d.coupon)
    return coupon ? [{ coupon }] : []
  })
}

function itemParams(item: Stripe.SubscriptionSchedule.Phase.Item): Stripe.SubscriptionScheduleUpdateParams.Phase.Item {
  const discounts = discountParams(item.discounts as unknown as PhaseDiscount[])
  return {
    price: idOf(item.price as unknown as { id: string } | string),
    ...(typeof item.quantity === 'number' ? { quantity: item.quantity } : {}),
    ...(item.tax_rates?.length ? { tax_rates: item.tax_rates.map((rate) => rate.id) } : {}),
    ...(discounts.length ? { discounts } : {}),
    ...(item.metadata && Object.keys(item.metadata).length ? { metadata: item.metadata } : {}),
  }
}

/**
 * A phase's settings as update parameters. A schedule update unsets whatever
 * it is not given again, so everything the current phase carries is carried:
 * discounts (a promotion code from checkout), tax, metadata, currency and how
 * it is paid. The rest lives in the schedule's default_settings, which
 * from_subscription copies from the subscription.
 */
function phaseSettings(phase: Stripe.SubscriptionSchedule.Phase): Omit<Stripe.SubscriptionScheduleUpdateParams.Phase, 'items'> {
  const discounts = discountParams(phase.discounts as unknown as PhaseDiscount[])
  const paymentMethod = idOf(phase.default_payment_method as unknown as { id: string } | string | null)
  return {
    ...(discounts.length ? { discounts } : {}),
    ...(phase.metadata && Object.keys(phase.metadata).length ? { metadata: phase.metadata } : {}),
    ...(phase.automatic_tax ? { automatic_tax: { enabled: phase.automatic_tax.enabled } } : {}),
    ...(phase.default_tax_rates?.length ? { default_tax_rates: phase.default_tax_rates.map((rate) => rate.id) } : {}),
    ...(phase.currency ? { currency: phase.currency } : {}),
    ...(phase.collection_method ? { collection_method: phase.collection_method } : {}),
    ...(paymentMethod ? { default_payment_method: paymentMethod } : {}),
  }
}

/** Lower the packs at the end of the current phase, through a schedule of ours. Returns when it takes effect. */
async function scheduleDecrease(
  stripe: Stripe,
  sub: Stripe.Subscription,
  existing: Stripe.SubscriptionSchedule | null,
  packs: number,
  packPriceId: string,
): Promise<string> {
  const schedule = existing ?? (await stripe.subscriptionSchedules.create({ from_subscription: sub.id }))
  try {
    const current = currentPhaseOf(schedule) ?? schedule.phases[0]
    if (!current) throw new Error(`subscription schedule ${schedule.id} has no current phase`)
    const settings = phaseSettings(current)
    const items = current.items.map(itemParams)
    const nextItems = [...items.filter((item) => item.price !== packPriceId), ...(packs > 0 ? [{ price: packPriceId, quantity: packs }] : [])]
    await stripe.subscriptionSchedules.update(schedule.id, {
      end_behavior: 'release',
      metadata: { purpose: PACK_SCHEDULE_PURPOSE },
      proration_behavior: 'none',
      phases: [
        { ...settings, items, start_date: current.start_date, end_date: current.end_date },
        { ...settings, items: nextItems, proration_behavior: 'none', duration: { interval: 'month', interval_count: 1 } },
      ],
    })
    return isoOf(current.end_date)
  } catch (err) {
    // A schedule made a moment ago and left half-written would hold the
    // subscription as a plan change nobody made: let it go again. The
    // update's own error is the one the caller hears; a failed release is
    // logged for a founder to release by hand.
    if (!existing) {
      await stripe.subscriptionSchedules.release(schedule.id).catch((releaseErr: unknown) => {
        log.error('payment packs: a half-written subscription schedule could not be released', releaseErr as Error, { scheduleId: schedule.id })
      })
    }
    throw err
  }
}

function paymentFailed(err: unknown): boolean {
  const e = err as { type?: string; statusCode?: number } | null
  return e?.type === 'StripeCardError' || e?.statusCode === 402
}

/**
 * Set the company's packs to `packs` (the total wanted, not a delta). Throws
 * on a Stripe error other than a declined card; the caller's route answers 500.
 */
export async function changePaymentPacks(stripe: Stripe, subscriptionId: string, packs: number): Promise<PaymentPacksChange> {
  const packPriceId = paymentPackPriceId()
  if (!packPriceId) throw new Error('STRIPE_PRICE_PAYMENTS_PACK is not configured')

  const state = await readPackState(stripe, subscriptionId, packPriceId)
  const refusal = packRefusal(state)
  if (refusal) return { ok: false, code: refusal }
  const { sub, schedule } = state

  const item = paymentPackItemOf(sub)
  const live = item?.quantity ?? 0

  if (packs > live) {
    // An increase replaces a decrease that was waiting. Released first: a
    // schedule's next phase would otherwise write the old quantity back.
    const pending = scheduledPacksOf(schedule, packPriceId)
    if (schedule) await stripe.subscriptionSchedules.release(schedule.id)
    try {
      const updated = await stripe.subscriptions.update(sub.id, {
        items: [item ? { id: item.id, quantity: packs } : { price: packPriceId, quantity: packs }],
        proration_behavior: 'always_invoice',
        payment_behavior: 'error_if_incomplete',
      })
      return { ok: true, scheduled: null, updated }
    } catch (err) {
      // The update changed nothing (a declined card, or any other refusal),
      // so the decrease that was waiting is put back: the owner keeps what
      // they had, in full.
      if (pending) {
        await scheduleDecrease(stripe, sub, null, pending.packs, packPriceId).catch((restoreErr: unknown) => {
          log.error('payment packs: a waiting decrease could not be put back after a failed increase', restoreErr as Error, {
            subscriptionId: sub.id,
            packs: pending.packs,
          })
        })
      }
      if (paymentFailed(err)) return { ok: false, code: 'PAYMENT_PACKS_PAYMENT_FAILED' }
      throw err
    }
  }

  if (packs === live) {
    // Keeping what the company has withdraws a decrease that was waiting.
    if (schedule) await stripe.subscriptionSchedules.release(schedule.id)
    return { ok: true, scheduled: null, updated: null }
  }

  const at = await scheduleDecrease(stripe, sub, schedule, packs, packPriceId)
  return { ok: true, scheduled: { packs, at }, updated: null }
}

/** What the purchase dialog, the pay dialogs and the billing page show (GET /api/billing/payment-packs). */
export interface PaymentPacksView {
  /** Packs are sold here and bank payments are open to the company. */
  offered: boolean
  /** This person may buy now: offered, the owner, an active subscription, the price read. */
  can_buy: boolean
  pack_size: number
  max_packs: number
  /** Payments a month without packs: the founder's override, else the default. */
  base_payments: number
  /** Packs the company holds (what the cap counts). */
  packs: number
  /** The cap: base_payments + packs x pack_size. */
  included_payments: number
  /** Price per pack and month in SEK exkl. moms, from Stripe; null unless can_buy. */
  pack_price_ex_vat: number | null
  /** A decrease waiting for the period end; null when none, or unless can_buy. */
  scheduled: ScheduledPacks | null
  /** Where a decrease would land; null unless can_buy. */
  period_end: string | null
}

/** The company's mirrored subscription: its Stripe id and status as the webhook last wrote them. */
export async function readCompanySubscription(service: SupabaseClient, companyId: string): Promise<{ id: string; status: string | null } | null> {
  const { data, error } = await service.from('company_subscriptions').select('stripe_subscription_id, status').eq('company_id', companyId).maybeSingle()
  if (error) throw new Error(`company_subscriptions lookup failed: ${error.message}`)
  const row = data as { stripe_subscription_id: string | null; status: string | null } | null
  return row?.stripe_subscription_id ? { id: row.stripe_subscription_id, status: row.status } : null
}

/**
 * Whether packs are sold here and bank payments are open to the company at
 * all. Not once payments above the included amount are billed per unit
 * (bankPaymentsBilled): a pack would then buy nothing the unit price does not.
 */
export async function paymentPacksOffered(supabase: SupabaseClient, companyId: string): Promise<boolean> {
  if (!paymentPacksConfigured() || bankPaymentsBilled()) return false
  return (await paymentsAdmitted(supabase, companyId)).ok
}

export async function readPaymentPacksView(input: {
  /** The person's own client: the allowance row is read under RLS. */
  supabase: SupabaseClient
  service: SupabaseClient
  companyId: string
  role: CompanyRole | null
  /** Asked only of an owner: a demo company never reaches Stripe. */
  isDemo: () => Promise<boolean>
  log: Logger
}): Promise<PaymentPacksView> {
  const { supabase, service, companyId, role, log } = input
  const [allowance, offered] = await Promise.all([readBankPaymentsAllowance(supabase, companyId), paymentPacksOffered(supabase, companyId)])
  const view: PaymentPacksView = {
    offered: false,
    can_buy: false,
    pack_size: BANK_PAYMENTS_PER_PACK,
    max_packs: MAX_PAYMENT_PACKS,
    base_payments: allowance.base,
    packs: allowance.packs,
    included_payments: allowance.included,
    pack_price_ex_vat: null,
    scheduled: null,
    period_end: null,
  }
  const packPriceId = paymentPackPriceId()
  if (!packPriceId || !offered) return view
  view.offered = true
  if (role !== 'owner' || (await input.isDemo())) return view

  // The mirror screens out a trial or a lapsed plan before Stripe is asked;
  // what Stripe answers then decides (packRefusal, as for a purchase).
  const mirrored = await readCompanySubscription(service, companyId)
  if (!mirrored || mirrored.status !== 'active') return view
  try {
    const state = await readPackState(getStripe(), mirrored.id, packPriceId)
    if (packRefusal(state)) return view
    return {
      ...view,
      can_buy: true,
      pack_price_ex_vat: sekAmountOf(state.price),
      scheduled: scheduledPacksOf(state.schedule, packPriceId),
      period_end: packPeriodEnd(state.sub),
    }
  } catch (err) {
    log.warn('payment packs: subscription or price not read', { error: err instanceof Error ? err.message : String(err) })
    return view
  }
}
