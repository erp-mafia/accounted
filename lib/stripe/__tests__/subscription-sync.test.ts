import { describe, it, expect, afterEach, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type Stripe from 'stripe'
import {
  statusGrantsAccess,
  subscriptionToState,
  applySubscriptionState,
} from '../subscription-sync'

afterEach(() => vi.unstubAllEnvs())

// Recording mock: captures the from()/upsert()/delete()/eq() operations so we
// can assert what applySubscriptionState wrote, without a real DB.
interface RecordedOp {
  table: string
  op: 'upsert' | 'delete' | null
  payload: unknown
  conflict: string | undefined
  filters: Array<[string, unknown]>
}
function recordingSupabase() {
  const calls: RecordedOp[] = []
  const supabase = {
    from(table: string) {
      const ctx: RecordedOp = { table, op: null, payload: null, conflict: undefined, filters: [] }
      const chain = {
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
        eq(col: string, val: unknown) {
          ctx.filters.push([col, val])
          return chain
        },
        then(resolve: (v: { data: null; error: null }) => void) {
          resolve({ data: null, error: null })
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
    expect(rows.map((r) => r.capability_key).sort()).toEqual(['ai', 'bank_sync', 'email_send', 'skatteverket', 'stripe_payments'])
    expect(rows.every((r) => r.source === 'stripe')).toBe(true)
  })

  it('removes only the stripe grants when canceled (freeze-and-retain)', async () => {
    const { supabase, calls } = recordingSupabase()
    await applySubscriptionState(supabase, {
      companyId: 'co_1',
      stripeCustomerId: 'cus_1',
      stripeSubscriptionId: 'sub_1',
      status: 'canceled',
      plan: null,
      currentPeriodEnd: null,
    })
    const grantOp = calls.find((c) => c.table === 'capability_grants')
    expect(grantOp?.op).toBe('delete')
    expect(grantOp?.filters).toContainEqual(['company_id', 'co_1'])
    expect(grantOp?.filters).toContainEqual(['source', 'stripe'])
  })
})
