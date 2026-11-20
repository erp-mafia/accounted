/**
 * Tests for POST /api/stripe/webhook (crm#1736): an event whose state could
 * not be written answers 500 and stays unprocessed, so Stripe delivers it
 * again; a delivery of an event already processed changes nothing.
 *
 * The subscription sync is real: the route is tested with the writes it
 * makes, against an in-memory stand-in for the four tables it touches.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type Stripe from 'stripe'
import { parseJsonResponse } from '@/tests/helpers'

type Write = { table: string; op: 'insert' | 'upsert' | 'update' | 'delete'; payload: unknown }

const db = vi.hoisted(() => ({
  /** stripe_webhook_events rows, by event id. */
  processed: new Set<string>(),
  /** Event ids another delivery records between this one's lookup and its insert. */
  recordedConcurrently: new Set<string>(),
  /** `table:op` writes that answer an error. */
  failing: new Set<string>(),
  writes: [] as Write[],
}))

function fakeService() {
  return {
    from(table: string) {
      let op: Write['op'] | 'select' = 'select'
      let payload: unknown = null
      const filters: Record<string, unknown> = {}
      const result = () => {
        if (op === 'select') {
          if (table !== 'stripe_webhook_events') return { data: [], error: null }
          const id = filters.event_id as string
          return { data: db.processed.has(id) ? { event_id: id } : null, error: null }
        }
        if (db.failing.has(`${table}:${op}`)) return { data: null, error: { message: 'boom', code: '57014' } }
        if (table === 'stripe_webhook_events') {
          const id = (payload as { event_id: string }).event_id
          if (db.processed.has(id) || db.recordedConcurrently.has(id)) {
            return { data: null, error: { message: 'duplicate key value', code: '23505' } }
          }
          db.processed.add(id)
        }
        db.writes.push({ table, op, payload })
        return { data: null, error: null }
      }
      const chain = {
        select: () => chain,
        insert: (p: unknown) => ((op = 'insert'), (payload = p), chain),
        upsert: (p: unknown) => ((op = 'upsert'), (payload = p), chain),
        update: (p: unknown) => ((op = 'update'), (payload = p), chain),
        delete: () => ((op = 'delete'), chain),
        eq: (col: string, val: unknown) => ((filters[col] = val), chain),
        neq: () => chain,
        or: () => chain,
        limit: () => chain,
        maybeSingle: () => Promise.resolve(result()),
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve(result()).then(resolve, reject),
      }
      return chain
    },
  }
}

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => fakeService(),
}))

const stripeMock = vi.hoisted(() => ({
  webhooks: { constructEvent: vi.fn() },
  subscriptions: { retrieve: vi.fn() },
}))
vi.mock('@/lib/stripe/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/stripe/client')>()),
  getStripe: () => stripeMock,
}))

// The identity sync is best effort and its own unit (customer-identity.test.ts).
vi.mock('@/lib/stripe/customer-identity', () => ({
  syncCompanyStripeIdentity: vi.fn().mockResolvedValue(null),
}))

import { POST } from '../route'

const COMPANY_ID = '11111111-1111-4111-8111-111111111111'

function subscription(status: string): Stripe.Subscription {
  return {
    id: 'sub_1',
    customer: 'cus_1',
    status,
    metadata: { company_id: COMPANY_ID },
    items: {
      data: [{ price: { id: 'price_month', recurring: { interval: 'month' } }, current_period_end: 1795132800 }],
    },
  } as unknown as Stripe.Subscription
}

/** Stripe sends `type` for a subscription that Stripe now holds as `status`. */
function stripeSends(type: string, status: string, id = 'evt_1'): void {
  const sub = subscription(status)
  stripeMock.webhooks.constructEvent.mockReturnValue({ id, type, data: { object: sub } })
  stripeMock.subscriptions.retrieve.mockResolvedValue(sub)
}

function deliver(): Promise<Response> {
  return POST(
    new Request('http://localhost:3000/api/stripe/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': 't=1,v1=sig' },
      body: '{"id":"evt_1"}',
    }),
  )
}

const writesTo = (table: string) => db.writes.filter((w) => w.table === table)

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec_test')
  db.processed.clear()
  db.recordedConcurrently.clear()
  db.failing.clear()
  db.writes.length = 0
})

afterEach(() => vi.unstubAllEnvs())

describe('POST /api/stripe/webhook', () => {
  it('applies a new subscription and marks the event processed', async () => {
    stripeSends('customer.subscription.created', 'trialing')

    const res = await deliver()

    expect(res.status).toBe(200)
    expect((await parseJsonResponse(res)).body).toEqual({ received: true })
    expect(writesTo('company_subscriptions')[0]).toMatchObject({
      op: 'upsert',
      payload: { company_id: COMPANY_ID, status: 'trialing', stripe_subscription_id: 'sub_1' },
    })
    const grants = writesTo('capability_grants')[0]
    expect(grants.op).toBe('upsert')
    expect((grants.payload as Array<{ capability_key: string }>).map((r) => r.capability_key)).toContain('bank_sync')
    expect(db.processed.has('evt_1')).toBe(true)
  })

  it('answers 500 and leaves the event unprocessed when the subscription row cannot be written', async () => {
    stripeSends('customer.subscription.created', 'trialing')
    db.failing.add('company_subscriptions:upsert')

    const res = await deliver()

    expect(res.status).toBe(500)
    expect((await parseJsonResponse(res)).body).toEqual({ error: 'processing_failed' })
    expect(writesTo('capability_grants')).toHaveLength(0)
    expect(db.processed.has('evt_1')).toBe(false)
  })

  it('answers 500 and leaves the event unprocessed when the grants cannot be written', async () => {
    stripeSends('customer.subscription.created', 'trialing')
    db.failing.add('capability_grants:upsert')

    const res = await deliver()

    expect(res.status).toBe(500)
    expect(db.processed.has('evt_1')).toBe(false)
  })

  it('grants the access when Stripe delivers the failed event again', async () => {
    stripeSends('customer.subscription.created', 'trialing')
    db.failing.add('capability_grants:upsert')
    expect((await deliver()).status).toBe(500)

    db.failing.clear()
    const res = await deliver()

    expect(res.status).toBe(200)
    expect(writesTo('capability_grants')).toHaveLength(1)
    expect(db.processed.has('evt_1')).toBe(true)
  })

  it('answers 500 when the grants of a cancelled subscription cannot be removed', async () => {
    stripeSends('customer.subscription.deleted', 'canceled')
    db.failing.add('capability_grants:delete')

    const res = await deliver()

    expect(res.status).toBe(500)
    expect(db.processed.has('evt_1')).toBe(false)
  })

  it('does nothing for a delivery of an event already processed', async () => {
    stripeSends('customer.subscription.created', 'trialing')
    expect((await deliver()).status).toBe(200)
    const writesAfterFirst = db.writes.length

    const res = await deliver()

    expect(res.status).toBe(200)
    expect((await parseJsonResponse(res)).body).toEqual({ received: true, duplicate: true })
    expect(db.writes).toHaveLength(writesAfterFirst)
    expect(stripeMock.subscriptions.retrieve).toHaveBeenCalledTimes(1)
  })

  it('answers 500 when the event cannot be marked processed, so Stripe delivers it again', async () => {
    stripeSends('customer.subscription.created', 'trialing')
    db.failing.add('stripe_webhook_events:insert')

    const res = await deliver()

    expect(res.status).toBe(500)
    expect(db.processed.has('evt_1')).toBe(false)
  })

  it('answers 200 when a concurrent delivery marked the event processed first', async () => {
    stripeSends('customer.subscription.created', 'trialing')
    db.recordedConcurrently.add('evt_1')

    const res = await deliver()

    expect(res.status).toBe(200)
    expect((await parseJsonResponse(res)).body).toEqual({ received: true })
  })

  it('rejects a request without a signature, writing nothing', async () => {
    const res = await POST(new Request('http://localhost:3000/api/stripe/webhook', { method: 'POST', body: '{}' }))

    expect(res.status).toBe(400)
    expect(db.writes).toHaveLength(0)
  })

  it('rejects a request whose signature does not verify, writing nothing', async () => {
    stripeMock.webhooks.constructEvent.mockImplementationOnce(() => {
      throw new Error('No signatures found matching the expected signature')
    })

    const res = await deliver()

    expect(res.status).toBe(400)
    expect(db.writes).toHaveLength(0)
  })
})
