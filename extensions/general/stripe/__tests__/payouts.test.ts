import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { SupabaseClient } from '@supabase/supabase-js'
import type Stripe from 'stripe'
import type { CreateJournalEntryInput } from '@/types'

const balanceTransactionsList = vi.fn()

vi.mock('@/lib/stripe/client', () => ({
  getStripe: () => ({ balanceTransactions: { list: balanceTransactionsList } }),
}))

vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: vi.fn(),
  findFiscalPeriod: vi.fn(),
}))

import { createJournalEntry, findFiscalPeriod } from '@/lib/bookkeeping/engine'
import { processPayoutPaidEvent } from '../lib/payouts'
import type { StripeConnection } from '../types'

const CONNECTION: StripeConnection = {
  id: 'conn-1',
  company_id: 'company-1',
  user_id: 'user-1',
  stripe_account_id: 'acct_1',
  livemode: false,
  status: 'active',
  oauth_state: null,
  display_name: null,
  last_event_created_at: null,
  last_event_id: null,
  error_message: null,
  connected_at: '2026-07-01T00:00:00.000Z',
  disconnected_at: null,
  created_at: '2026-07-01T00:00:00.000Z',
  updated_at: '2026-07-01T00:00:00.000Z',
}

// 2026-07-10 arrival: 1 000,00 gross, 25,50 fees, 974,50 net.
function makePayoutEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt_po_1',
    type: 'payout.paid',
    created: 1_767_000_000,
    data: {
      object: {
        id: 'po_1',
        amount: 97450,
        currency: 'sek',
        arrival_date: 1_767_000_000,
        livemode: false,
        ...overrides,
      },
    },
  } as unknown as Stripe.Event
}

function stubBalanceTxns(txns: Array<Record<string, unknown>>) {
  balanceTransactionsList.mockReturnValue({
    autoPagingToArray: vi.fn().mockResolvedValue(txns),
  })
}

const CLEAN_TXNS = [
  { type: 'charge', amount: 60000, fee: 1530, currency: 'sek' },
  { type: 'charge', amount: 40000, fee: 1020, currency: 'sek' },
  { type: 'payout', amount: -97450, fee: 0, currency: 'sek' },
]

describe('processPayoutPaidEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_123')
    vi.mocked(findFiscalPeriod).mockResolvedValue('period-1')
    vi.mocked(createJournalEntry).mockResolvedValue({ id: 'je-po-1' } as never)
    stubBalanceTxns(CLEAN_TXNS)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('books a clean SEK payout with reverse-charge fee lines', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'po-row-1' }] }) // claim
    enqueue({ data: { vat_registered: true } }) // company_settings
    enqueue({ data: null }) // finalize row

    const outcome = await processPayoutPaidEvent(
      supabase as unknown as SupabaseClient,
      CONNECTION,
      makePayoutEvent(),
    )

    expect(outcome).toEqual({ status: 'booked', reason: null })
    expect(vi.mocked(createJournalEntry)).toHaveBeenCalledTimes(1)
    const input = vi.mocked(createJournalEntry).mock.calls[0][3] as CreateJournalEntryInput
    expect(input.source_type).toBe('stripe_payout')

    const byAccount = new Map(
      input.lines.map((l) => [l.account_number, l]),
    )
    // Net to bank
    expect(byAccount.get('1930')).toMatchObject({ debit_amount: 974.5 })
    // Fees as cost
    expect(byAccount.get('6570')).toMatchObject({ debit_amount: 25.5 })
    // Ruta 21 basis pair
    expect(byAccount.get('4535')).toMatchObject({ debit_amount: 25.5 })
    expect(byAccount.get('4598')).toMatchObject({ credit_amount: 25.5 })
    // Fiktiv moms 25% of fees
    expect(byAccount.get('2645')).toMatchObject({ debit_amount: 6.38 })
    expect(byAccount.get('2614')).toMatchObject({ credit_amount: 6.38 })
    // Clearing of the gross
    expect(byAccount.get('1686')).toMatchObject({ credit_amount: 1000 })

    // The entry balances to the öre.
    const debits = input.lines.reduce((s, l) => s + (l.debit_amount || 0), 0)
    const credits = input.lines.reduce((s, l) => s + (l.credit_amount || 0), 0)
    expect(Math.round(debits * 100)).toBe(Math.round(credits * 100))
  })

  it('skips a payout already claimed by an earlier run', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [] }) // claim conflict

    const outcome = await processPayoutPaidEvent(
      supabase as unknown as SupabaseClient,
      CONNECTION,
      makePayoutEvent(),
    )

    expect(outcome.status).toBe('already_processed')
    expect(vi.mocked(createJournalEntry)).not.toHaveBeenCalled()
  })

  it('sends payouts containing refunds to needs_review', async () => {
    stubBalanceTxns([
      ...CLEAN_TXNS,
      { type: 'refund', amount: -10000, fee: 0, currency: 'sek' },
    ])
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'po-row-1' }] })
    enqueue({ data: { vat_registered: true } })
    enqueue({ data: null })

    const outcome = await processPayoutPaidEvent(
      supabase as unknown as SupabaseClient,
      CONNECTION,
      makePayoutEvent(),
    )

    expect(outcome.status).toBe('needs_review')
    expect(outcome.reason).toBe('non_deterministic_txn_refund')
    expect(vi.mocked(createJournalEntry)).not.toHaveBeenCalled()
  })

  it('sends non-SEK payouts to needs_review', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'po-row-1' }] })
    enqueue({ data: null }) // finalize

    const outcome = await processPayoutPaidEvent(
      supabase as unknown as SupabaseClient,
      CONNECTION,
      makePayoutEvent({ currency: 'eur' }),
    )

    expect(outcome.status).toBe('needs_review')
    expect(outcome.reason).toBe('non_sek_payout')
  })

  it('sends arithmetic drift to needs_review', async () => {
    stubBalanceTxns([
      { type: 'charge', amount: 60000, fee: 1530, currency: 'sek' },
      { type: 'payout', amount: -97450, fee: 0, currency: 'sek' },
    ]) // gross 600 - fees 15.30 = 584.70 != net 974.50
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'po-row-1' }] })
    enqueue({ data: { vat_registered: true } })
    enqueue({ data: null })

    const outcome = await processPayoutPaidEvent(
      supabase as unknown as SupabaseClient,
      CONNECTION,
      makePayoutEvent(),
    )

    expect(outcome.status).toBe('needs_review')
    expect(outcome.reason).toBe('arithmetic_mismatch')
  })

  it('sends non-VAT-registered companies to needs_review (RC on fees)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'po-row-1' }] })
    enqueue({ data: { vat_registered: false } })
    enqueue({ data: null })

    const outcome = await processPayoutPaidEvent(
      supabase as unknown as SupabaseClient,
      CONNECTION,
      makePayoutEvent(),
    )

    expect(outcome.status).toBe('needs_review')
    expect(outcome.reason).toBe('not_vat_registered')
  })

  it('records a locked-period booking failure as needs_review', async () => {
    vi.mocked(createJournalEntry).mockRejectedValue(
      new Error('Cannot write to locked/closed fiscal period'),
    )
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'po-row-1' }] })
    enqueue({ data: { vat_registered: true } })
    enqueue({ data: null })

    const outcome = await processPayoutPaidEvent(
      supabase as unknown as SupabaseClient,
      CONNECTION,
      makePayoutEvent(),
    )

    expect(outcome.status).toBe('needs_review')
    expect(outcome.reason).toContain('booking_failed')
  })

  it('books a zero-fee payout without any reverse-charge lines', async () => {
    stubBalanceTxns([
      { type: 'charge', amount: 97450, fee: 0, currency: 'sek' },
      { type: 'payout', amount: -97450, fee: 0, currency: 'sek' },
    ])
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'po-row-1' }] })
    enqueue({ data: { vat_registered: true } })
    enqueue({ data: null })

    const outcome = await processPayoutPaidEvent(
      supabase as unknown as SupabaseClient,
      CONNECTION,
      makePayoutEvent(),
    )

    expect(outcome.status).toBe('booked')
    const input = vi.mocked(createJournalEntry).mock.calls[0][3] as CreateJournalEntryInput
    const accounts = input.lines.map((l) => l.account_number)
    expect(accounts).toEqual(['1930', '1686'])
  })
})
