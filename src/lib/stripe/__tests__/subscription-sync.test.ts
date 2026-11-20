import { describe, it, expect, afterEach, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type Stripe from 'stripe'
import {
  statusGrantsAccess,
  subscriptionToState,
  applySubscriptionState,
  handleStripeEvent,
} from '../subscription-sync'

// The identity sync is its own unit (customer-identity.test.ts); here only
// when the webhook asks for it.
const syncIdentityMock = vi.hoisted(() => vi.fn())
vi.mock('../customer-identity', () => ({
  syncCompanyStripeIdentity: (...args: unknown[]) => syncIdentityMock(...args),
}))

// The delivery into the Inkorg is its own unit (billing-invoice-inbox.test.ts);
// here only which invoices reach it, and for which company.
const deliverMock = vi.hoisted(() => vi.fn())
vi.mock('../billing-invoice-inbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../billing-invoice-inbox')>()),
  deliverBillingInvoiceToInbox: (...args: unknown[]) => deliverMock(...args),
}))

afterEach(() => vi.unstubAllEnvs())

// Recording mock: captures the from()/upsert()/delete()/eq() operations so we
// can assert what applySubscriptionState wrote, without a real DB.
interface RecordedOp {
  table: string
  op: 'upsert' | 'delete' | 'update' | 'select' | null
  payload: unknown
  conflict: string | undefined
  filters: Array<[string, unknown]>
}
// `selectRows` answers a select by its filters (default: no rows);
// `failWrite` makes a write of that table and op answer an error.
function recordingSupabase(
  selectRows: (filters: Array<[string, unknown]>) => unknown[] = () => [],
  failWrite: (table: string, op: RecordedOp['op']) => boolean = () => false,
) {
  const calls: RecordedOp[] = []
  const supabase = {
    from(table: string) {
      const ctx: RecordedOp = { table, op: null, payload: null, conflict: undefined, filters: [] }
      const chain = {
        select(columns: string) {
          ctx.op = 'select'
          ctx.payload = columns
          calls.push(ctx)
          return chain
        },
        limit() {
          return chain
        },
        upsert(payload: unknown, opts?: { onConflict?: string }) {
          ctx.op = 'upsert'
          ctx.payload = payload
          ctx.conflict = opts?.onConflict
          calls.push(ctx)
          return chain
        },
        delete() {
          ctx.op = 'delete'
          calls.push(ctx)
          return chain
        },
        update(payload: unknown) {
          ctx.op = 'update'
          ctx.payload = payload
          calls.push(ctx)
          return chain
        },
        eq(col: string, val: unknown) {
          ctx.filters.push([col, val])
          return chain
        },
        neq(col: string, val: unknown) {
          ctx.filters.push([`neq:${col}`, val])
          return chain
        },
        or(filter: string) {
          ctx.filters.push(['or', filter])
          return chain
        },
        then(resolve: (v: { data: unknown; error: { message: string } | null }) => void) {
          const failed = ctx.op !== 'select' && failWrite(ctx.table, ctx.op)
          resolve({
            data: ctx.op === 'select' ? selectRows(ctx.filters) : null,
            error: failed ? { message: 'boom' } : null,
          })
        },
      }
      return chain
    },
  }
  return { supabase: supabase as unknown as SupabaseClient, calls }
}

function fakeSub(over: Partial<{ status: string; priceId: string; interval: string; periodEnd: number; customer: string }> = {}): Stripe.Subscription {
  return {
    id: 'sub_123',
    customer: over.customer ?? 'cus_123',
    status: over.status ?? 'active',
    metadata: {},
    items: {
      data: [
        {
          price: { id: over.priceId ?? 'price_x', recurring: { interval: over.interval ?? 'month' } },
          current_period_end: over.periodEnd ?? Math.floor(Date.now() / 1000) + 30 * 86400,
        },
      ],
    },
  } as unknown as Stripe.Subscription
}

// A subscription event is applied as Stripe holds the subscription now
// (crm#1736): this client holds `sub`.
function stripeHolding(sub: Stripe.Subscription) {
  const retrieve = vi.fn(async () => sub)
  return { stripe: { subscriptions: { retrieve } } as unknown as Stripe, retrieve }
}

describe('statusGrantsAccess', () => {
  it('grants for active/trialing/past_due, denies otherwise', () => {
    expect(statusGrantsAccess('active')).toBe(true)
    expect(statusGrantsAccess('trialing')).toBe(true)
    expect(statusGrantsAccess('past_due')).toBe(true)
    expect(statusGrantsAccess('canceled')).toBe(false)
    expect(statusGrantsAccess('unpaid')).toBe(false)
    expect(statusGrantsAccess(null)).toBe(false)
  })
})

describe('subscriptionToState', () => {
  it('maps status, customer, id, and period end', () => {
    const end = Math.floor(Date.now() / 1000) + 1000
    const state = subscriptionToState(fakeSub({ status: 'active', periodEnd: end }), 'co_1')
    expect(state.companyId).toBe('co_1')
    expect(state.stripeCustomerId).toBe('cus_123')
    expect(state.stripeSubscriptionId).toBe('sub_123')
    expect(state.status).toBe('active')
    expect(state.currentPeriodEnd).toBe(new Date(end * 1000).toISOString())
  })

  it('derives plan from the env price id, falling back to interval', () => {
    vi.stubEnv('STRIPE_PRICE_YEARLY', 'price_year')
    vi.stubEnv('STRIPE_PRICE_MONTHLY', 'price_month')
    expect(subscriptionToState(fakeSub({ priceId: 'price_year' }), 'co').plan).toBe('yearly')
    expect(subscriptionToState(fakeSub({ priceId: 'price_month' }), 'co').plan).toBe('monthly')
    // unknown price id -> interval fallback
    expect(subscriptionToState(fakeSub({ priceId: 'price_other', interval: 'year' }), 'co').plan).toBe('yearly')
  })
})

// Issue #132: a subscription carries a bank payment pack item beside the
// plan, and Stripe lists items in no promised order.
describe('subscriptionToState: a pack item beside the plan', () => {
  const PLAN_END = Math.floor(Date.UTC(2027, 9, 1) / 1000)
  const PACK_END = Math.floor(Date.UTC(2026, 10, 1) / 1000)

  function withPack(packs: number): Stripe.Subscription {
    return {
      id: 'sub_123',
      customer: 'cus_123',
      status: 'active',
      metadata: {},
      items: {
        data: [
          // The pack first: what items.data[0] read as the plan.
          { price: { id: 'price_pack', recurring: { interval: 'month' } }, quantity: packs, current_period_end: PACK_END },
          { price: { id: 'price_year', recurring: { interval: 'year' } }, quantity: 1, current_period_end: PLAN_END },
        ],
      },
    } as unknown as Stripe.Subscription
  }

  it('finds the plan item by its price id even when the pack item comes first', () => {
    vi.stubEnv('STRIPE_PRICE_YEARLY', 'price_year')
    vi.stubEnv('STRIPE_PRICE_MONTHLY', 'price_month')
    vi.stubEnv('STRIPE_PRICE_PAYMENTS_PACK', 'price_pack')
    const state = subscriptionToState(withPack(2), 'co_1')
    expect(state.plan).toBe('yearly')
    // The plan's own period, not the monthly pack's.
    expect(state.currentPeriodEnd).toBe(new Date(PLAN_END * 1000).toISOString())
    expect(state.paymentPacks).toBe(2)
  })

  it('never reads the pack item as the plan when the env plan ids are not wired', () => {
    vi.stubEnv('STRIPE_PRICE_PAYMENTS_PACK', 'price_pack')
    expect(subscriptionToState(withPack(1), 'co_1').plan).toBe('yearly')
  })

  it('leaves packs out (null) while this installation sells none', () => {
    vi.stubEnv('STRIPE_PRICE_YEARLY', 'price_year')
    expect(subscriptionToState(withPack(2), 'co_1').paymentPacks).toBeNull()
  })
})

describe('applySubscriptionState: bank payment packs into the cap', () => {
  const base = {
    companyId: 'co_1',
    stripeCustomerId: 'cus_1',
    stripeSubscriptionId: 'sub_1',
    plan: 'monthly' as const,
    currentPeriodEnd: new Date().toISOString(),
  }

  it('writes the packs of a paying subscription to purchased_packs', async () => {
    const { supabase, calls } = recordingSupabase()
    await applySubscriptionState(supabase, { ...base, status: 'active', paymentPacks: 3 })
    const write = calls.find((c) => c.table === 'company_bank_payment_allowances')
    expect(write).toMatchObject({ op: 'upsert', payload: { company_id: 'co_1', purchased_packs: 3 }, conflict: 'company_id' })
  })

  it('drops the packs of a lapsed plan, whatever quantity the dead subscription lists', async () => {
    const { supabase, calls } = recordingSupabase()
    await applySubscriptionState(supabase, { ...base, status: 'canceled', paymentPacks: 3 })
    const write = calls.find((c) => c.table === 'company_bank_payment_allowances')
    expect(write).toMatchObject({ op: 'update', payload: { purchased_packs: 0 } })
    expect(write?.filters).toContainEqual(['company_id', 'co_1'])
  })

  it('creates no allowance row for a company without packs, and leaves it alone where packs are not sold', async () => {
    const none = recordingSupabase()
    await applySubscriptionState(none.supabase, { ...base, status: 'active', paymentPacks: 0 })
    expect(none.calls.filter((c) => c.table === 'company_bank_payment_allowances').map((c) => c.op)).toEqual(['update'])

    const unsold = recordingSupabase()
    await applySubscriptionState(unsold.supabase, { ...base, status: 'active', paymentPacks: null })
    expect(unsold.calls.some((c) => c.table === 'company_bank_payment_allowances')).toBe(false)
  })

  it('carries a pack change from the webhook event to the column', async () => {
    vi.stubEnv('STRIPE_PRICE_MONTHLY', 'price_month')
    vi.stubEnv('STRIPE_PRICE_PAYMENTS_PACK', 'price_pack')
    const { supabase, calls } = recordingSupabase()
    const sub = {
      ...fakeSub({ status: 'active', priceId: 'price_month' }),
      metadata: { company_id: 'co_1' },
      items: {
        data: [
          { price: { id: 'price_pack', recurring: { interval: 'month' } }, quantity: 2, current_period_end: Math.floor(Date.now() / 1000) + 86400 },
          { price: { id: 'price_month', recurring: { interval: 'month' } }, quantity: 1, current_period_end: Math.floor(Date.now() / 1000) + 86400 },
        ],
      },
    } as unknown as Stripe.Subscription
    syncIdentityMock.mockResolvedValue(null)

    await handleStripeEvent(supabase, stripeHolding(sub).stripe, { id: 'evt_1', type: 'customer.subscription.updated', data: { object: sub } } as unknown as Stripe.Event)

    expect(calls.find((c) => c.table === 'company_bank_payment_allowances')).toMatchObject({
      op: 'upsert',
      payload: { company_id: 'co_1', purchased_packs: 2 },
    })
    expect(calls.find((c) => c.table === 'company_subscriptions' && c.op === 'upsert')?.payload).toMatchObject({ plan: 'monthly' })
  })

  it('throws when the cap cannot be written, so Stripe delivers the event again', async () => {
    const { supabase } = recordingSupabase()
    const failing = {
      from(table: string) {
        if (table !== 'company_bank_payment_allowances') return supabase.from(table)
        return { upsert: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }
      },
    } as unknown as SupabaseClient
    await expect(applySubscriptionState(failing, { ...base, status: 'active', paymentPacks: 1 })).rejects.toThrow(/boom/)
  })
})

describe('applySubscriptionState', () => {
  it('grants the PAID keys when the subscription is active', async () => {
    const { supabase, calls } = recordingSupabase()
    await applySubscriptionState(supabase, {
      companyId: 'co_1',
      stripeCustomerId: 'cus_1',
      stripeSubscriptionId: 'sub_1',
      status: 'active',
      plan: 'yearly',
      currentPeriodEnd: new Date().toISOString(),
    })
    const subUpsert = calls.find((c) => c.table === 'company_subscriptions')
    expect(subUpsert?.op).toBe('upsert')
    const grantUpsert = calls.find((c) => c.table === 'capability_grants')
    expect(grantUpsert?.op).toBe('upsert')
    const rows = grantUpsert?.payload as Array<{ capability_key: string; source: string }>
    // Every paid key, collections and signing included.
    expect(rows.map((r) => r.capability_key).sort()).toEqual(['ai', 'bank_sync', 'collections', 'email_send', 'multi_user', 'shopify_sync', 'signing', 'skatteverket', 'stripe_payments', 'woocommerce_sync', 'zettle_sync'])
    expect(rows.every((r) => r.source === 'stripe')).toBe(true)
  })

  it('removes the stripe grants when canceled but EXPIRES multi_user (grace anchor)', async () => {
    const { supabase, calls } = recordingSupabase()
    await applySubscriptionState(supabase, {
      companyId: 'co_1',
      stripeCustomerId: 'cus_1',
      stripeSubscriptionId: 'sub_1',
      status: 'canceled',
      plan: null,
      currentPeriodEnd: null,
    })
    const grantOps = calls.filter((c) => c.table === 'capability_grants')
    // Freeze-and-retain deletes every external-service grant, except
    // multi_user, whose 20-day grace window hangs on an EXPIRED row: a
    // deleted row would freeze the churned payer's staff instantly.
    const deleteOp = grantOps.find((c) => c.op === 'delete')
    expect(deleteOp?.filters).toContainEqual(['company_id', 'co_1'])
    expect(deleteOp?.filters).toContainEqual(['source', 'stripe'])
    expect(deleteOp?.filters).toContainEqual(['neq:capability_key', 'multi_user'])
    const updateOp = grantOps.find((c) => c.op === 'update')
    expect(updateOp?.filters).toContainEqual(['capability_key', 'multi_user'])
    const payload = updateOp?.payload as { expires_at: string }
    expect(new Date(payload.expires_at).getTime()).toBeLessThanOrEqual(Date.now())
    // Only a still-active row is expired: a re-delivered cancel event must
    // not slide the grace anchor forward (the .or filter scopes the update).
    expect(updateOp?.filters.some(([col]) => col === 'or')).toBe(true)
  })
})

// crm#1736: a write that failed was read as success, so the webhook answered
// 200 and a subscription row saying paying stood beside no grants for good.
describe('applySubscriptionState: a failed write fails the event', () => {
  const state = (status: string) => ({
    companyId: 'co_1',
    stripeCustomerId: 'cus_1',
    stripeSubscriptionId: 'sub_1',
    status,
    plan: 'monthly' as const,
    currentPeriodEnd: '2026-12-01T00:00:00.000Z',
  })

  it('throws when the subscription row cannot be written, before touching the grants', async () => {
    const { supabase, calls } = recordingSupabase(undefined, (table) => table === 'company_subscriptions')
    await expect(applySubscriptionState(supabase, state('trialing'))).rejects.toThrow(
      'company_subscriptions write failed: boom',
    )
    expect(calls.some((c) => c.table === 'capability_grants')).toBe(false)
  })

  it('throws when the grants of a paying subscription cannot be written', async () => {
    const { supabase } = recordingSupabase(undefined, (table, op) => table === 'capability_grants' && op === 'upsert')
    await expect(applySubscriptionState(supabase, state('trialing'))).rejects.toThrow('capability_grants write failed: boom')
  })

  it.each(['delete', 'update'] as const)("throws when the %s of a lapsed plan's grants fails", async (failing) => {
    const { supabase } = recordingSupabase(undefined, (table, op) => table === 'capability_grants' && op === failing)
    await expect(applySubscriptionState(supabase, state('canceled'))).rejects.toThrow('capability_grants write failed: boom')
  })

  it('writes the same grants when applied again', async () => {
    const first = recordingSupabase()
    const again = recordingSupabase()
    await applySubscriptionState(first.supabase, state('active'))
    await applySubscriptionState(again.supabase, state('active'))
    const grants = (calls: RecordedOp[]) => calls.find((c) => c.table === 'capability_grants')
    expect(grants(again.calls)).toEqual(grants(first.calls))
  })
})

// crm#1736: a failed write has Stripe deliver the event again, possibly after
// a later event of the subscription. The event's own copy would roll back.
describe('handleStripeEvent: the subscription as Stripe holds it now', () => {
  const companySub = (status: string) =>
    ({ ...fakeSub({ status }), metadata: { company_id: 'co_1' } }) as unknown as Stripe.Subscription
  const event = (type: string, status: string) =>
    ({ id: 'evt_1', type, data: { object: companySub(status) } }) as unknown as Stripe.Event

  afterEach(() => syncIdentityMock.mockReset())

  it('keeps the grants of a payer whose stale "incomplete" event arrives again', async () => {
    const { supabase, calls } = recordingSupabase()
    const { stripe, retrieve } = stripeHolding(companySub('active'))
    syncIdentityMock.mockResolvedValue(null)

    await handleStripeEvent(supabase, stripe, event('customer.subscription.created', 'incomplete'))

    expect(retrieve).toHaveBeenCalledWith('sub_123')
    expect(calls.find((c) => c.table === 'company_subscriptions' && c.op === 'upsert')?.payload).toMatchObject({
      status: 'active',
    })
    expect(calls.some((c) => c.table === 'capability_grants' && c.op === 'upsert')).toBe(true)
    expect(calls.some((c) => c.table === 'capability_grants' && c.op === 'delete')).toBe(false)
  })

  it('applies the event copy of a subscription Stripe no longer has', async () => {
    const { supabase, calls } = recordingSupabase()
    const retrieve = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('No such subscription'), { code: 'resource_missing' }))

    await handleStripeEvent(
      supabase,
      { subscriptions: { retrieve } } as unknown as Stripe,
      event('customer.subscription.deleted', 'canceled'),
    )

    expect(calls.find((c) => c.table === 'company_subscriptions' && c.op === 'upsert')?.payload).toMatchObject({
      status: 'canceled',
    })
    expect(calls.some((c) => c.table === 'capability_grants' && c.op === 'delete')).toBe(true)
  })

  it('fails the event when Stripe cannot be read, writing nothing', async () => {
    const { supabase, calls } = recordingSupabase()
    const retrieve = vi.fn().mockRejectedValue(Object.assign(new Error('api down'), { code: 'api_error' }))

    await expect(
      handleStripeEvent(
        supabase,
        { subscriptions: { retrieve } } as unknown as Stripe,
        event('customer.subscription.updated', 'active'),
      ),
    ).rejects.toThrow('api down')
    expect(calls).toHaveLength(0)
  })
})

// crm#1378: a subscription event of a paying company writes the company's
// identity onto its Stripe customer, so a renewal invoice (still a draft
// when the event arrives) is made out to the company as it now stands.
describe('handleStripeEvent: company identity on the customer', () => {
  const retrieve = vi.fn()
  const stripe = { subscriptions: { retrieve } } as unknown as Stripe

  // Stripe holds the subscription as the event carries it.
  function event(type: string, sub: Stripe.Subscription): Stripe.Event {
    retrieve.mockResolvedValue(sub)
    return { id: 'evt_1', type, data: { object: sub } } as unknown as Stripe.Event
  }
  function companySub(status: string): Stripe.Subscription {
    return { ...fakeSub({ status }), metadata: { company_id: 'co_1' } } as unknown as Stripe.Subscription
  }

  afterEach(() => syncIdentityMock.mockReset())

  it.each(['customer.subscription.created', 'customer.subscription.updated'])(
    'writes it on %s of a paying subscription, with the event customer',
    async (type) => {
      const { supabase, calls } = recordingSupabase()
      syncIdentityMock.mockResolvedValue(null)

      await handleStripeEvent(supabase, stripe, event(type, companySub('active')))

      expect(calls.some((c) => c.table === 'company_subscriptions' && c.op === 'upsert')).toBe(true)
      expect(syncIdentityMock).toHaveBeenCalledWith(supabase, 'co_1', { stripe, customerId: 'cus_123' })
    },
  )

  it.each(['canceled', 'incomplete', 'unpaid'])('leaves the customer alone for a %s subscription', async (status) => {
    const { supabase } = recordingSupabase()

    await handleStripeEvent(supabase, stripe, event('customer.subscription.updated', companySub(status)))

    expect(syncIdentityMock).not.toHaveBeenCalled()
  })

  it('leaves the customer alone when the subscription is deleted', async () => {
    const { supabase } = recordingSupabase()

    await handleStripeEvent(supabase, stripe, event('customer.subscription.deleted', companySub('canceled')))

    expect(syncIdentityMock).not.toHaveBeenCalled()
  })

  it('never fails the webhook over the identity: the access state is what the event is for', async () => {
    const { supabase, calls } = recordingSupabase()
    syncIdentityMock.mockRejectedValue(new Error('stripe down'))

    await expect(
      handleStripeEvent(supabase, stripe, event('customer.subscription.updated', companySub('active'))),
    ).resolves.toBeUndefined()
    expect(calls.some((c) => c.table === 'capability_grants' && c.op === 'upsert')).toBe(true)
  })
})

// Found while fixing crm#1373: a migration reset moves the company's row to
// the replacement company, but the subscription's metadata still names the
// archived source. Resolved by metadata first, the next event wrote the
// source and let the paying replacement's grants lapse.
describe('handleStripeEvent: which company an event is for', () => {
  const retrieve = vi.fn()
  const stripe = { subscriptions: { retrieve } } as unknown as Stripe
  const updated = (sub: Stripe.Subscription) => {
    retrieve.mockResolvedValue(sub)
    return { id: 'evt_1', type: 'customer.subscription.updated', data: { object: sub } } as unknown as Stripe.Event
  }
  const sourceSub = () =>
    ({ ...fakeSub({ status: 'active' }), metadata: { company_id: 'co_source' } }) as unknown as Stripe.Subscription

  afterEach(() => syncIdentityMock.mockReset())

  const upsertedCompany = (calls: RecordedOp[]) =>
    (calls.find((c) => c.table === 'company_subscriptions' && c.op === 'upsert')?.payload as { company_id: string })
      ?.company_id

  it('follows the row that holds the subscription, not the stale metadata', async () => {
    const { supabase, calls } = recordingSupabase((filters) =>
      filters.some(([col, val]) => col === 'stripe_subscription_id' && val === 'sub_123')
        ? [{ company_id: 'co_replacement' }]
        : [],
    )

    await handleStripeEvent(supabase, stripe, updated(sourceSub()))

    expect(upsertedCompany(calls)).toBe('co_replacement')
  })

  it('follows the row that holds the customer when no row has the subscription yet', async () => {
    const { supabase, calls } = recordingSupabase((filters) =>
      filters.some(([col, val]) => col === 'stripe_customer_id' && val === 'cus_123')
        ? [{ company_id: 'co_checkout' }]
        : [],
    )

    await handleStripeEvent(supabase, stripe, updated(sourceSub()))

    expect(upsertedCompany(calls)).toBe('co_checkout')
  })

  it('falls back to the metadata when no row knows the subscription or its customer', async () => {
    const { supabase, calls } = recordingSupabase()

    await handleStripeEvent(supabase, stripe, updated(sourceSub()))

    expect(upsertedCompany(calls)).toBe('co_source')
  })

  it('does not guess between two rows sharing a customer', async () => {
    const { supabase, calls } = recordingSupabase((filters) =>
      filters.some(([col]) => col === 'stripe_customer_id') ? [{ company_id: 'co_a' }, { company_id: 'co_b' }] : [],
    )

    await handleStripeEvent(supabase, stripe, updated(sourceSub()))

    expect(upsertedCompany(calls)).toBe('co_source')
  })
})

// PH 191: our own paid invoice is the underlag of the company's card payment.
describe('handleStripeEvent: a paid invoice goes to the paying company\'s Inkorg', () => {
  const stripe = {} as Stripe
  function paid(over: Record<string, unknown> = {}): Stripe.Event {
    const invoice = {
      id: 'in_1',
      status: 'paid',
      amount_paid: 24875,
      collection_method: 'charge_automatically',
      customer: 'cus_123',
      parent: { subscription_details: { subscription: 'sub_123', metadata: { company_id: 'co_meta' } } },
      ...over,
    }
    return { id: 'evt_1', type: 'invoice.paid', data: { object: invoice } } as unknown as Stripe.Event
  }

  afterEach(() => deliverMock.mockReset())

  it('delivers to the company whose row holds the subscription', async () => {
    const { supabase } = recordingSupabase((filters) =>
      filters.some(([col, val]) => col === 'stripe_subscription_id' && val === 'sub_123') ? [{ company_id: 'co_row' }] : [],
    )
    deliverMock.mockResolvedValue({ inboxItemId: 'inbox-1' })

    await handleStripeEvent(supabase, stripe, paid())

    expect(deliverMock).toHaveBeenCalledWith(supabase, stripe, {
      invoice: expect.objectContaining({ id: 'in_1' }),
      companyId: 'co_row',
    })
  })

  it("falls back to the subscription's metadata when the event outruns the checkout's row", async () => {
    const { supabase } = recordingSupabase()
    deliverMock.mockResolvedValue({ inboxItemId: 'inbox-1' })

    await handleStripeEvent(supabase, stripe, paid())

    expect(deliverMock.mock.calls[0][2]).toMatchObject({ companyId: 'co_meta' })
  })

  it("skips a trial's 0 kr invoice before any lookup", async () => {
    const { supabase, calls } = recordingSupabase()

    await handleStripeEvent(supabase, stripe, paid({ amount_paid: 0 }))

    expect(calls).toHaveLength(0)
    expect(deliverMock).not.toHaveBeenCalled()
  })

  it('lets a failed delivery fail the webhook, so Stripe delivers the event again', async () => {
    const { supabase } = recordingSupabase()
    deliverMock.mockRejectedValue(new Error('invoice PDF fetch failed with status 503'))

    await expect(handleStripeEvent(supabase, stripe, paid())).rejects.toThrow('503')
  })

  it('writes no access state for an invoice', async () => {
    const { supabase, calls } = recordingSupabase()
    deliverMock.mockResolvedValue({ inboxItemId: 'inbox-1' })

    await handleStripeEvent(supabase, stripe, paid())

    expect(calls.some((c) => c.op === 'upsert' || c.op === 'delete' || c.op === 'update')).toBe(false)
  })
})
