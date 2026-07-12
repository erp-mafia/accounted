import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createQueuedMockSupabase, makeInvoice } from '@/tests/helpers'
import type { SupabaseClient } from '@supabase/supabase-js'

const eventsList = vi.fn()

vi.mock('@/lib/stripe/client', () => ({
  getStripe: () => ({ events: { list: eventsList } }),
}))

vi.mock('@/lib/invoices/settle-invoice-payment', () => ({
  settleInvoicePayment: vi.fn(),
}))

import { settleInvoicePayment } from '@/lib/invoices/settle-invoice-payment'
import { eventBus } from '@/lib/events/bus'
import { syncStripeConnection } from '../lib/sync'
import type { StripeConnection } from '../types'

const CONNECTION: StripeConnection = {
  id: 'conn-1',
  company_id: 'company-1',
  user_id: 'user-1',
  stripe_account_id: 'acct_1',
  livemode: false,
  status: 'active',
  oauth_state: null,
  display_name: 'Test AB',
  last_event_created_at: null,
  last_event_id: null,
  error_message: null,
  connected_at: '2026-07-01T00:00:00.000Z',
  disconnected_at: null,
  created_at: '2026-07-01T00:00:00.000Z',
  updated_at: '2026-07-01T00:00:00.000Z',
}

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cs_1',
    payment_link: 'plink_1',
    payment_intent: 'pi_1',
    amount_total: 125000, // 1250.00 SEK in öre
    currency: 'sek',
    payment_status: 'paid',
    livemode: false,
    metadata: { invoice_id: 'inv-1', company_id: 'company-1' },
    ...overrides,
  }
}

function makeEvent(session: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt_1',
    type: 'checkout.session.completed',
    created: 1_767_000_000,
    data: { object: session },
    ...overrides,
  }
}

function stubEvents(events: unknown[]) {
  eventsList.mockReturnValue({
    autoPagingToArray: vi.fn().mockResolvedValue(events),
  })
}

function payableInvoice(overrides: Record<string, unknown> = {}) {
  return {
    ...makeInvoice({
      id: 'inv-1',
      status: 'sent',
      currency: 'SEK',
      total: 1250,
    }),
    remaining_amount: 1250,
    paid_amount: 0,
    stripe_payment_link_id: 'plink_1',
    customer: { name: 'Kund AB' },
    items: [],
    ...overrides,
  }
}

describe('syncStripeConnection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_123')
    vi.stubEnv('STRIPE_CONNECT_CLIENT_ID', 'ca_test_123')
    vi.mocked(settleInvoicePayment).mockResolvedValue({
      ok: true,
      newStatus: 'paid',
      newPaidAmount: 1250,
      newRemaining: 0,
      journalEntryId: 'je-9',
      paidAt: '2026-07-12T00:00:00.000Z',
    })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('settles a deterministic match against 1686 and advances the cursor', async () => {
    stubEvents([makeEvent(makeSession())])
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'spe-1' }] }) // claim insert
    enqueue({ data: payableInvoice() }) // invoice by payment link
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'aktiebolag' } })
    enqueue({ data: null }) // event row finalize
    enqueue({ data: null }) // cursor update

    const summary = await syncStripeConnection(supabase as unknown as SupabaseClient, CONNECTION)

    expect(summary).toMatchObject({ fetched: 1, settled: 1, needsReview: 0, ignored: 0 })
    expect(vi.mocked(settleInvoicePayment)).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({
        paymentAmountInInvoiceCurrency: 1250,
        settlementAccountNumber: '1686',
        accountingMethod: 'accrual',
        entityType: 'aktiebolag',
        paymentDate: new Date(1_767_000_000 * 1000).toISOString().split('T')[0],
      }),
    )
  })

  it('records amount drift as needs_review and never settles', async () => {
    stubEvents([makeEvent(makeSession({ amount_total: 100000 }))]) // 1000 vs 1250 remaining
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'spe-1' }] })
    enqueue({ data: payableInvoice() })
    enqueue({ data: null }) // event row finalize
    enqueue({ data: null }) // cursor update

    const summary = await syncStripeConnection(supabase as unknown as SupabaseClient, CONNECTION)

    expect(summary).toMatchObject({ settled: 0, needsReview: 1 })
    expect(vi.mocked(settleInvoicePayment)).not.toHaveBeenCalled()
  })

  it('records an already-paid invoice as needs_review (double payment)', async () => {
    stubEvents([makeEvent(makeSession())])
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'spe-1' }] })
    enqueue({ data: payableInvoice({ status: 'paid' }) })
    enqueue({ data: null })
    enqueue({ data: null })

    const summary = await syncStripeConnection(supabase as unknown as SupabaseClient, CONNECTION)

    expect(summary.needsReview).toBe(1)
    expect(vi.mocked(settleInvoicePayment)).not.toHaveBeenCalled()
  })

  it('records non-SEK invoices as needs_review (v1 automation scope)', async () => {
    stubEvents([makeEvent(makeSession({ currency: 'eur', amount_total: 50000 }))])
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'spe-1' }] })
    enqueue({
      data: payableInvoice({ currency: 'EUR', total: 500, remaining_amount: 500 }),
    })
    enqueue({ data: null })
    enqueue({ data: null })

    const summary = await syncStripeConnection(supabase as unknown as SupabaseClient, CONNECTION)

    expect(summary.needsReview).toBe(1)
    expect(vi.mocked(settleInvoicePayment)).not.toHaveBeenCalled()
  })

  it('ignores test-mode events on a live-mode connection', async () => {
    stubEvents([makeEvent(makeSession({ livemode: false }))])
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'spe-1' }] })
    enqueue({ data: null }) // event row finalize
    enqueue({ data: null }) // cursor update

    const summary = await syncStripeConnection(
      supabase as unknown as SupabaseClient,
      { ...CONNECTION, livemode: true },
    )

    expect(summary).toMatchObject({ settled: 0, needsReview: 0, ignored: 1 })
  })

  it('skips events already claimed by an earlier run', async () => {
    stubEvents([makeEvent(makeSession())])
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [] }) // claim conflict
    enqueue({ data: [] }) // reclaim: not stale
    enqueue({ data: null }) // cursor update

    const summary = await syncStripeConnection(supabase as unknown as SupabaseClient, CONNECTION)

    expect(summary).toMatchObject({ alreadyProcessed: 1, settled: 0 })
    expect(vi.mocked(settleInvoicePayment)).not.toHaveBeenCalled()
  })

  it('marks the connection revoked when Stripe reports severed access', async () => {
    eventsList.mockReturnValue({
      autoPagingToArray: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('The account acct_1 is not connected to your platform'), {
            type: 'StripePermissionError',
          }),
        ),
    })
    const disconnected = vi.fn()
    eventBus.on('stripe.disconnected', disconnected)
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null }) // connection status update

    const summary = await syncStripeConnection(supabase as unknown as SupabaseClient, CONNECTION)

    expect(summary.revoked).toBe(true)
    expect(summary.settled).toBe(0)
    // Auto-detected revocation must reach the audit trail, mirroring the
    // user-initiated disconnect emission.
    expect(disconnected).toHaveBeenCalledWith({
      connectionId: 'conn-1',
      stripeAccountId: 'acct_1',
      reason: 'revoked_upstream',
      userId: 'user-1',
      companyId: 'company-1',
    })
  })

  it('falls back to accrual/enskild_firma when the company has no settings row', async () => {
    stubEvents([makeEvent(makeSession())])
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'spe-1' }] }) // claim insert
    enqueue({ data: payableInvoice() }) // invoice by payment link
    enqueue({ data: null }) // company_settings: no row (maybeSingle -> null, no error)
    enqueue({ data: null }) // event row finalize
    enqueue({ data: null }) // cursor update

    const summary = await syncStripeConnection(supabase as unknown as SupabaseClient, CONNECTION)

    expect(summary.settled).toBe(1)
    expect(vi.mocked(settleInvoicePayment)).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({
        accountingMethod: 'accrual',
        entityType: 'enskild_firma',
      }),
    )
  })

  it('stops mid-batch at the deadline and persists the cursor only over processed events', async () => {
    let now = 1_000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      // Settling the first event burns the remaining time budget.
      vi.mocked(settleInvoicePayment).mockImplementation(async () => {
        now = 10_000
        return {
          ok: true,
          newStatus: 'paid',
          newPaidAmount: 1250,
          newRemaining: 0,
          journalEntryId: 'je-9',
          paidAt: '2026-07-12T00:00:00.000Z',
        }
      })
      stubEvents([
        makeEvent(makeSession()),
        makeEvent(makeSession({ id: 'cs_2' }), { id: 'evt_2', created: 1_767_000_100 }),
      ])
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ data: [{ id: 'spe-1' }] }) // claim insert (evt_1)
      enqueue({ data: payableInvoice() }) // invoice by payment link
      enqueue({ data: { accounting_method: 'accrual', entity_type: 'aktiebolag' } })
      enqueue({ data: null }) // event row finalize (evt_1)
      enqueue({ data: null }) // cursor update

      const summary = await syncStripeConnection(
        supabase as unknown as SupabaseClient,
        CONNECTION,
        undefined,
        5_000, // deadline passes between the first and second event
      )

      expect(summary).toMatchObject({
        fetched: 2,
        settled: 1,
        needsReview: 0,
        deadlineReached: true,
      })
      expect(vi.mocked(settleInvoicePayment)).toHaveBeenCalledTimes(1)
      // evt_2 was never claimed and the cursor advanced only over evt_1, so
      // the next run refetches evt_2 (cursor overlap) and processes it then.
      expect(vi.mocked(supabase.from).mock.calls.map((c) => c[0])).toEqual([
        'stripe_payment_events', // claim evt_1
        'invoices',
        'company_settings',
        'stripe_payment_events', // finalize evt_1
        'stripe_connections', // cursor persisted up to evt_1
      ])
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('records a settle failure (e.g. locked period) as needs_review', async () => {
    vi.mocked(settleInvoicePayment).mockResolvedValue({
      ok: false,
      code: 'BOOKKEEPING_ERROR',
      error: new Error('Cannot write to locked/closed fiscal period'),
    })
    stubEvents([makeEvent(makeSession())])
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'spe-1' }] })
    enqueue({ data: payableInvoice() })
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'aktiebolag' } })
    enqueue({ data: null })
    enqueue({ data: null })

    const summary = await syncStripeConnection(supabase as unknown as SupabaseClient, CONNECTION)

    expect(summary.needsReview).toBe(1)
  })
})
