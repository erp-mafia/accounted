import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type Stripe from 'stripe'
import { changePaymentPacks, scheduledPacksOf } from '../payment-packs'

/**
 * The Stripe side of a pack change (issue #132): more packs now and charged
 * now, fewer at the period end through a schedule of ours, and a plan change
 * made in the portal never rewritten. Stripe is a recorded fake.
 */

const PERIOD_START = 1_790_000_000
const PERIOD_END = 1_792_600_000

const retrieve = vi.fn()
const update = vi.fn()
const scheduleCreate = vi.fn()
const scheduleUpdate = vi.fn()
const scheduleRelease = vi.fn()
const scheduleRetrieve = vi.fn()
const priceRetrieve = vi.fn()
const stripe = {
  subscriptions: { retrieve, update },
  prices: { retrieve: priceRetrieve },
  subscriptionSchedules: { create: scheduleCreate, update: scheduleUpdate, release: scheduleRelease, retrieve: scheduleRetrieve },
} as unknown as Stripe

function subscription(
  over: { packs?: number; status?: string; cancelAtPeriodEnd?: boolean; schedule?: unknown; plan?: 'month' | 'year'; billingMode?: 'classic' | 'flexible' } = {},
): Stripe.Subscription {
  const packs = over.packs ?? 0
  const plan = over.plan ?? 'month'
  return {
    id: 'sub_1',
    status: over.status ?? 'active',
    cancel_at_period_end: over.cancelAtPeriodEnd ?? false,
    cancel_at: null,
    schedule: over.schedule ?? null,
    billing_mode: { type: over.billingMode ?? 'classic' },
    items: {
      data: [
        { id: 'si_plan', price: { id: plan === 'year' ? 'price_year' : 'price_month', recurring: { interval: plan, interval_count: 1 } }, quantity: 1, current_period_end: PERIOD_END },
        ...(packs > 0 ? [{ id: 'si_pack', price: { id: 'price_pack' }, quantity: packs, current_period_end: PERIOD_END }] : []),
      ],
    },
  } as unknown as Stripe.Subscription
}

/** A schedule as from_subscription makes it: one phase mirroring the subscription, a promotion code's discount on it. */
function schedule(packs: number, over: { metadata?: Record<string, string>; next?: number } = {}): Stripe.SubscriptionSchedule {
  const phase = (start: number, end: number, quantity: number) => ({
    start_date: start,
    end_date: end,
    items: [
      { price: 'price_month', quantity: 1, tax_rates: [], discounts: [], metadata: {} },
      ...(quantity > 0 ? [{ price: 'price_pack', quantity, tax_rates: [], discounts: [], metadata: {} }] : []),
    ],
    discounts: [{ coupon: null, discount: 'di_launch', promotion_code: null }],
    metadata: {},
    automatic_tax: { enabled: true, liability: null },
    currency: 'sek',
    collection_method: 'charge_automatically',
    default_payment_method: null,
    trial_end: null,
  })
  return {
    id: 'sub_sched_1',
    metadata: over.metadata ?? {},
    current_phase: { start_date: PERIOD_START, end_date: PERIOD_END },
    phases: [
      phase(PERIOD_START, PERIOD_END, packs),
      ...(over.next !== undefined ? [phase(PERIOD_END, PERIOD_END + 2_600_000, over.next)] : []),
    ],
  } as unknown as Stripe.SubscriptionSchedule
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('STRIPE_PRICE_MONTHLY', 'price_month')
  vi.stubEnv('STRIPE_PRICE_PAYMENTS_PACK', 'price_pack')
  scheduleUpdate.mockResolvedValue({})
  scheduleRelease.mockResolvedValue({})
  priceRetrieve.mockResolvedValue({ id: 'price_pack', currency: 'sek', unit_amount: 19900, recurring: { interval: 'month', interval_count: 1 } })
})

afterEach(() => vi.unstubAllEnvs())

describe('changePaymentPacks: more packs', () => {
  it('raises the pack item now, charging the rest of the period at once and failing on a declined card', async () => {
    retrieve.mockResolvedValue(subscription({ packs: 1 }))
    update.mockResolvedValue(subscription({ packs: 3 }))

    const change = await changePaymentPacks(stripe, 'sub_1', 3)

    expect(update).toHaveBeenCalledWith('sub_1', {
      items: [{ id: 'si_pack', quantity: 3 }],
      proration_behavior: 'always_invoice',
      payment_behavior: 'error_if_incomplete',
    })
    expect(change).toMatchObject({ ok: true, scheduled: null })
    expect(scheduleCreate).not.toHaveBeenCalled()
  })

  it('adds the pack item on the first purchase', async () => {
    retrieve.mockResolvedValue(subscription())
    update.mockResolvedValue(subscription({ packs: 1 }))
    await changePaymentPacks(stripe, 'sub_1', 1)
    expect(update.mock.calls[0][1]).toMatchObject({ items: [{ price: 'price_pack', quantity: 1 }] })
  })

  it('lets a waiting decrease of ours go before raising, so its next phase cannot write the old count back', async () => {
    retrieve.mockResolvedValue(subscription({ packs: 2, schedule: schedule(2, { metadata: { purpose: 'bank_payment_packs' }, next: 1 }) }))
    update.mockResolvedValue(subscription({ packs: 4 }))
    await changePaymentPacks(stripe, 'sub_1', 4)
    expect(scheduleRelease).toHaveBeenCalledWith('sub_sched_1')
    expect(scheduleRelease.mock.invocationCallOrder[0]).toBeLessThan(update.mock.invocationCallOrder[0])
  })

  it('reports a declined card as a refusal, not a crash', async () => {
    retrieve.mockResolvedValue(subscription())
    update.mockRejectedValue(Object.assign(new Error('declined'), { type: 'StripeCardError', statusCode: 402 }))
    expect(await changePaymentPacks(stripe, 'sub_1', 1)).toEqual({ ok: false, code: 'PAYMENT_PACKS_PAYMENT_FAILED' })
  })

  it('puts a waiting decrease back when the card for an increase is declined', async () => {
    retrieve.mockResolvedValue(subscription({ packs: 3, schedule: schedule(3, { metadata: { purpose: 'bank_payment_packs' }, next: 1 }) }))
    update.mockRejectedValue(Object.assign(new Error('declined'), { type: 'StripeCardError', statusCode: 402 }))
    scheduleCreate.mockResolvedValue(schedule(3))

    expect(await changePaymentPacks(stripe, 'sub_1', 5)).toEqual({ ok: false, code: 'PAYMENT_PACKS_PAYMENT_FAILED' })
    expect(scheduleRelease).toHaveBeenCalledWith('sub_sched_1')
    expect(scheduleCreate).toHaveBeenCalledWith({ from_subscription: 'sub_1' })
    expect(scheduleUpdate.mock.calls[0][1].phases[1].items).toContainEqual({ price: 'price_pack', quantity: 1 })
  })

  it('puts a waiting decrease back after any other failed increase too, then throws', async () => {
    retrieve.mockResolvedValue(subscription({ packs: 3, schedule: schedule(3, { metadata: { purpose: 'bank_payment_packs' }, next: 1 }) }))
    update.mockRejectedValue(Object.assign(new Error('stripe down'), { type: 'StripeAPIError', statusCode: 500 }))
    scheduleCreate.mockResolvedValue(schedule(3))

    await expect(changePaymentPacks(stripe, 'sub_1', 5)).rejects.toThrow('stripe down')
    expect(scheduleUpdate.mock.calls[0][1].phases[1].items).toContainEqual({ price: 'price_pack', quantity: 1 })
  })

  it('adds no first pack to a plan billed on another interval in classic billing mode (Stripe mixes intervals only in flexible mode)', async () => {
    retrieve.mockResolvedValue(subscription({ plan: 'year' }))
    expect(await changePaymentPacks(stripe, 'sub_1', 1)).toEqual({ ok: false, code: 'PAYMENT_PACKS_PLAN_INTERVAL' })
    expect(update).not.toHaveBeenCalled()

    retrieve.mockResolvedValue(subscription({ plan: 'year', billingMode: 'flexible' }))
    update.mockResolvedValue(subscription({ plan: 'year', billingMode: 'flexible', packs: 1 }))
    expect(await changePaymentPacks(stripe, 'sub_1', 1)).toMatchObject({ ok: true, scheduled: null })
  })

  it('throws any other Stripe error', async () => {
    retrieve.mockResolvedValue(subscription())
    update.mockRejectedValue(Object.assign(new Error('mixed intervals need flexible billing'), { type: 'StripeInvalidRequestError', statusCode: 400 }))
    await expect(changePaymentPacks(stripe, 'sub_1', 1)).rejects.toThrow(/flexible billing/)
  })
})

describe('changePaymentPacks: refusals', () => {
  it('refuses a subscription that is not active, or is cancelling', async () => {
    for (const sub of [subscription({ status: 'trialing' }), subscription({ status: 'past_due' }), subscription({ cancelAtPeriodEnd: true })]) {
      retrieve.mockResolvedValue(sub)
      expect(await changePaymentPacks(stripe, 'sub_1', 1)).toEqual({ ok: false, code: 'PAYMENT_PACKS_SUBSCRIPTION_NOT_ACTIVE' })
    }
    expect(update).not.toHaveBeenCalled()
  })

  it('never rewrites a schedule it did not make (a plan change from the portal)', async () => {
    retrieve.mockResolvedValue(subscription({ packs: 2, schedule: 'sub_sched_portal' }))
    scheduleRetrieve.mockResolvedValue(schedule(2))
    expect(await changePaymentPacks(stripe, 'sub_1', 1)).toEqual({ ok: false, code: 'PAYMENT_PACKS_PLAN_CHANGE_PENDING' })
    expect(await changePaymentPacks(stripe, 'sub_1', 5)).toEqual({ ok: false, code: 'PAYMENT_PACKS_PLAN_CHANGE_PENDING' })
    expect(scheduleUpdate).not.toHaveBeenCalled()
    expect(scheduleRelease).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })

  it('sells nothing at a price it cannot state (not SEK, no amount)', async () => {
    retrieve.mockResolvedValue(subscription())
    priceRetrieve.mockResolvedValue({ id: 'price_pack', currency: 'eur', unit_amount: 1500, recurring: { interval: 'month', interval_count: 1 } })
    expect(await changePaymentPacks(stripe, 'sub_1', 1)).toEqual({ ok: false, code: 'PAYMENT_PACKS_NOT_OFFERED' })
    expect(update).not.toHaveBeenCalled()
  })

  it('throws while no pack price is configured', async () => {
    vi.stubEnv('STRIPE_PRICE_PAYMENTS_PACK', '')
    await expect(changePaymentPacks(stripe, 'sub_1', 1)).rejects.toThrow(/STRIPE_PRICE_PAYMENTS_PACK/)
  })
})

describe('changePaymentPacks: fewer packs', () => {
  it('keeps the current period as it is and lowers the packs from the next, carrying the discount and tax', async () => {
    retrieve.mockResolvedValue(subscription({ packs: 3 }))
    scheduleCreate.mockResolvedValue(schedule(3))

    const change = await changePaymentPacks(stripe, 'sub_1', 1)

    expect(update).not.toHaveBeenCalled()
    expect(scheduleCreate).toHaveBeenCalledWith({ from_subscription: 'sub_1' })
    const [id, params] = scheduleUpdate.mock.calls[0]
    expect(id).toBe('sub_sched_1')
    expect(params).toMatchObject({ end_behavior: 'release', metadata: { purpose: 'bank_payment_packs' }, proration_behavior: 'none' })
    const [current, next] = params.phases
    expect(current).toMatchObject({
      start_date: PERIOD_START,
      end_date: PERIOD_END,
      items: [{ price: 'price_month', quantity: 1 }, { price: 'price_pack', quantity: 3 }],
      discounts: [{ discount: 'di_launch' }],
      automatic_tax: { enabled: true },
      currency: 'sek',
    })
    expect(next).toMatchObject({
      items: [{ price: 'price_month', quantity: 1 }, { price: 'price_pack', quantity: 1 }],
      discounts: [{ discount: 'di_launch' }],
      automatic_tax: { enabled: true },
      proration_behavior: 'none',
      duration: { interval: 'month', interval_count: 1 },
    })
    expect(next.start_date).toBeUndefined()
    // The cap keeps what was paid for until then.
    expect(change).toEqual({ ok: true, scheduled: { packs: 1, at: new Date(PERIOD_END * 1000).toISOString() }, updated: null })
  })

  it('drops the pack item from the next period when the owner goes to none', async () => {
    retrieve.mockResolvedValue(subscription({ packs: 2 }))
    scheduleCreate.mockResolvedValue(schedule(2))
    await changePaymentPacks(stripe, 'sub_1', 0)
    const next = scheduleUpdate.mock.calls[0][1].phases[1]
    expect(next.items).toEqual([{ price: 'price_month', quantity: 1 }])
  })

  it('moves a waiting decrease of ours instead of making a second schedule', async () => {
    retrieve.mockResolvedValue(subscription({ packs: 3, schedule: schedule(3, { metadata: { purpose: 'bank_payment_packs' }, next: 2 }) }))
    await changePaymentPacks(stripe, 'sub_1', 1)
    expect(scheduleCreate).not.toHaveBeenCalled()
    const phases = scheduleUpdate.mock.calls[0][1].phases
    expect(phases).toHaveLength(2)
    expect(phases[1].items).toContainEqual({ price: 'price_pack', quantity: 1 })
  })

  it('lets a schedule it just made go again when writing it fails, so nothing holds the subscription', async () => {
    retrieve.mockResolvedValue(subscription({ packs: 2 }))
    scheduleCreate.mockResolvedValue(schedule(2))
    scheduleUpdate.mockRejectedValue(new Error('stripe down'))
    await expect(changePaymentPacks(stripe, 'sub_1', 1)).rejects.toThrow('stripe down')
    expect(scheduleRelease).toHaveBeenCalledWith('sub_sched_1')
  })

  it('withdraws a waiting decrease when the owner keeps what the company has', async () => {
    retrieve.mockResolvedValue(subscription({ packs: 2, schedule: schedule(2, { metadata: { purpose: 'bank_payment_packs' }, next: 1 }) }))
    expect(await changePaymentPacks(stripe, 'sub_1', 2)).toEqual({ ok: true, scheduled: null, updated: null })
    expect(scheduleRelease).toHaveBeenCalledWith('sub_sched_1')
    expect(update).not.toHaveBeenCalled()
  })
})

describe('scheduledPacksOf', () => {
  it('reads the decrease a schedule of ours holds, and nothing from anyone else\'s', () => {
    expect(scheduledPacksOf(schedule(3, { metadata: { purpose: 'bank_payment_packs' }, next: 1 }), 'price_pack')).toEqual({
      packs: 1,
      at: new Date(PERIOD_END * 1000).toISOString(),
    })
    expect(scheduledPacksOf(schedule(3, { metadata: { purpose: 'bank_payment_packs' }, next: 0 }), 'price_pack')).toMatchObject({ packs: 0 })
    expect(scheduledPacksOf(schedule(3, { next: 1 }), 'price_pack')).toBeNull()
    expect(scheduledPacksOf(null, 'price_pack')).toBeNull()
  })
})
