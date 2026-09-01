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
  op: 'upsert' | 'delete' | 'update' | null
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
    expect(rows.map((r) => r.capability_key).sort()).toEqual(['ai', 'bank_sync', 'email_send', 'multi_user', 'shopify_sync', 'skatteverket', 'stripe_payments', 'woocommerce_sync'])
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
