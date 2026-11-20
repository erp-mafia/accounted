import { describe, it, expect, vi, beforeEach } from 'vitest'
import type Stripe from 'stripe'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  endCompanySubscriptions,
  liveCompanySubscriptions,
  payingCompanySubscription,
  readCompanyStripeRef,
} from '../company-subscription'

const { supabase, enqueue, reset } = createQueuedMockSupabase()

const list = vi.fn()
const cancel = vi.fn()
const stripe = { subscriptions: { list, cancel } } as unknown as Stripe

function sub(id: string, status: string, companyId: string | null = 'company-1'): Stripe.Subscription {
  return { id, status, metadata: companyId ? { company_id: companyId } : {} } as unknown as Stripe.Subscription
}

const REF = { customerId: 'cus_1', subscriptionId: 'sub_row' }

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  cancel.mockResolvedValue({})
})

describe('readCompanyStripeRef', () => {
  it('is null for a company that never reached checkout', async () => {
    enqueue({ data: null })
    expect(await readCompanyStripeRef(supabase, 'company-1')).toBeNull()
  })

  it('is null for a row without a customer', async () => {
    enqueue({ data: { stripe_customer_id: null, stripe_subscription_id: null } })
    expect(await readCompanyStripeRef(supabase, 'company-1')).toBeNull()
  })

  it('returns the customer and the mirrored subscription', async () => {
    enqueue({ data: { stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_row' } })
    expect(await readCompanyStripeRef(supabase, 'company-1')).toEqual(REF)
  })

  it('throws on a failed read instead of answering "no customer"', async () => {
    enqueue({ data: null, error: { message: 'boom' } })
    await expect(readCompanyStripeRef(supabase, 'company-1')).rejects.toThrow('boom')
  })
})

describe('liveCompanySubscriptions', () => {
  it('keeps the company subscriptions that are not over, on its own customer', async () => {
    list.mockResolvedValue({
      data: [
        sub('sub_row', 'active', null), // the mirrored one, even without metadata
        sub('sub_meta', 'trialing'), // the company's by metadata
        sub('sub_other', 'active', 'company-2'), // another company on a shared customer
        sub('sub_expired', 'incomplete_expired'),
      ],
    })

    const live = await liveCompanySubscriptions(stripe, 'company-1', REF)

    expect(list).toHaveBeenCalledWith({ customer: 'cus_1', limit: 100 })
    expect(live.map((s) => s.id)).toEqual(['sub_row', 'sub_meta'])
  })
})

describe('payingCompanySubscription', () => {
  it.each(['active', 'trialing', 'past_due'])('finds a %s subscription', async (status) => {
    list.mockResolvedValue({ data: [sub('sub_new', status)] })
    expect(await payingCompanySubscription(stripe, 'company-1', REF)).toBe('sub_new')
  })

  it('asks Stripe, so a subscription the webhook has not mirrored yet counts (crm#1373)', async () => {
    list.mockResolvedValue({ data: [sub('sub_just_paid', 'active')] })
    expect(await payingCompanySubscription(stripe, 'company-1', { customerId: 'cus_1', subscriptionId: null })).toBe(
      'sub_just_paid',
    )
  })

  it('does not count an unpaid first attempt, so the owner can try again', async () => {
    list.mockResolvedValue({ data: [sub('sub_3ds', 'incomplete')] })
    expect(await payingCompanySubscription(stripe, 'company-1', REF)).toBeNull()
  })

  it('is null when Stripe lists nothing live', async () => {
    list.mockResolvedValue({ data: [] })
    expect(await payingCompanySubscription(stripe, 'company-1', REF)).toBeNull()
  })
})

describe('endCompanySubscriptions', () => {
  it('cancels every live subscription of the company and nothing else', async () => {
    list.mockResolvedValue({
      data: [sub('sub_row', 'active'), sub('sub_second', 'trialing'), sub('sub_other', 'active', 'company-2')],
    })

    const ended = await endCompanySubscriptions(stripe, 'company-1', REF)

    expect(ended).toEqual(['sub_row', 'sub_second'])
    expect(cancel).toHaveBeenCalledTimes(2)
    expect(cancel).toHaveBeenCalledWith('sub_row')
    expect(cancel).toHaveBeenCalledWith('sub_second')
  })

  it('cancels nothing when nothing is live', async () => {
    list.mockResolvedValue({ data: [] })
    expect(await endCompanySubscriptions(stripe, 'company-1', REF)).toEqual([])
    expect(cancel).not.toHaveBeenCalled()
  })

  it('throws when Stripe refuses, so the caller does not hide a company still charged', async () => {
    list.mockResolvedValue({ data: [sub('sub_row', 'active')] })
    cancel.mockRejectedValue(new Error('stripe down'))
    await expect(endCompanySubscriptions(stripe, 'company-1', REF)).rejects.toThrow('stripe down')
  })
})
