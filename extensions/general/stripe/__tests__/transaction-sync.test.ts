import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const balanceTransactionsList = vi.fn()

vi.mock('@/lib/stripe/client', () => ({
  getStripe: () => ({ balanceTransactions: { list: balanceTransactionsList } }),
}))

vi.mock('@/lib/transactions/ingest', () => ({
  ingestTransactions: vi.fn(),
}))

vi.mock('@/lib/cash-accounts/service', () => ({
  ensureManualCashAccount: vi.fn().mockResolvedValue('cash-account-1'),
}))

vi.mock('@/lib/import/account-sync', () => ({
  syncMappedAccounts: vi.fn().mockResolvedValue({ error: null }),
}))

import { ingestTransactions } from '@/lib/transactions/ingest'
import { ensureManualCashAccount } from '@/lib/cash-accounts/service'
import {
  BACKFILL_DAYS,
  STRIPE_IMPORT_SOURCE,
  STRIPE_LEDGER_ACCOUNT,
  linkPayoutFeedRows,
  mapBalanceTransaction,
  stripeExternalId,
  stripeFeeExternalId,
  syncStripeBalanceTransactions,
  type BalanceTxnLike,
} from '../lib/transaction-sync'
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
  transaction_sync_enabled: true,
  last_balance_txn_synced_at: null,
  error_message: null,
  connected_at: '2026-07-01T00:00:00.000Z',
  disconnected_at: null,
  created_at: '2026-07-01T00:00:00.000Z',
  updated_at: '2026-07-01T00:00:00.000Z',
}

// 2026-07-10T12:00:00Z
const CREATED = 1_783_425_600
const CREATED_DATE = new Date(CREATED * 1000).toISOString().split('T')[0]

function makeCharge(overrides: Partial<BalanceTxnLike> = {}): BalanceTxnLike {
  return {
    id: 'txn_charge_1',
    type: 'charge',
    amount: 50_000,
    fee: 1_450,
    currency: 'sek',
    created: CREATED,
    description: 'Payment for invoice',
    source: {
      id: 'ch_1',
      object: 'charge',
      payment_intent: 'pi_1',
      billing_details: { name: 'Anna Andersson' },
    } as unknown as BalanceTxnLike['source'],
    ...overrides,
  }
}

function makePayoutTxn(overrides: Partial<BalanceTxnLike> = {}): BalanceTxnLike {
  return {
    id: 'txn_payout_1',
    type: 'payout',
    amount: -48_550,
    fee: 0,
    currency: 'sek',
    created: CREATED + 3600,
    description: 'STRIPE PAYOUT',
    source: { id: 'po_1', object: 'payout' } as unknown as BalanceTxnLike['source'],
    ...overrides,
  }
}

function stubList(byWindow: BalanceTxnLike[], byPayout: BalanceTxnLike[] = []) {
  balanceTransactionsList.mockImplementation((params: Record<string, unknown>) => ({
    autoPagingToArray: vi.fn().mockResolvedValue('payout' in params ? byPayout : byWindow),
  }))
}

/**
 * Arg-capturing Supabase mock: each from(table) consumes the next queued
 * result for that table and records every chained call, so tests can assert
 * filters and update payloads (createQueuedMockSupabase discards args).
 */
interface CapturedQuery {
  table: string
  ops: Array<{ method: string; args: unknown[] }>
}

function createCaptureSupabase(resultsByTable: Record<string, unknown[]> = {}) {
  const queries: CapturedQuery[] = []
  const queues = new Map<string, unknown[]>(
    Object.entries(resultsByTable).map(([table, results]) => [table, [...results]]),
  )
  const supabase = {
    from(table: string) {
      const captured: CapturedQuery = { table, ops: [] }
      queries.push(captured)
      const queue = queues.get(table)
      const result = queue && queue.length > 0 ? queue.shift() : { data: null, error: null }
      const chain: Record<string, unknown> = {}
      const recorder =
        (method: string) =>
        (...args: unknown[]) => {
          captured.ops.push({ method, args })
          return chain
        }
      for (const method of [
        'select', 'update', 'insert', 'upsert', 'eq', 'neq', 'in', 'is', 'not',
        'order', 'limit', 'gte', 'lte', 'maybeSingle', 'single',
      ]) {
        chain[method] = recorder(method)
      }
      chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
      return chain
    },
  }
  const queriesFor = (table: string) => queries.filter((q) => q.table === table)
  const op = (query: CapturedQuery, method: string) =>
    query.ops.find((o) => o.method === method)
  return { supabase: supabase as unknown as SupabaseClient, queries, queriesFor, op }
}

function listWindowGte(): number {
  const params = balanceTransactionsList.mock.calls[0][0] as {
    created: { gte: number }
  }
  return params.created.gte
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-07-23T10:00:00.000Z'))
  vi.mocked(ingestTransactions).mockResolvedValue({
    imported: 0,
    duplicates: 0,
    reconciled: 0,
    auto_categorized: 0,
    auto_matched_invoices: 0,
    errors: 0,
    transaction_ids: [],
  } as never)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('external id formats', () => {
  // ⚠️ FROZEN FORMATS: these strings are stored keys in
  // transactions.external_id. If either assertion fails, you are about to
  // orphan every previously imported Stripe row and re-import the whole feed
  // (the June 2026 Enable Banking incident, again). Do NOT update the
  // expected values without a coordinated backfill of existing rows.
  it('main row id is stripe_{acct}_{txn}', () => {
    expect(stripeExternalId('acct_1', 'txn_abc')).toBe('stripe_acct_1_txn_abc')
  })

  it('fee row id is stripe_{acct}_{txn}_fee', () => {
    expect(stripeFeeExternalId('acct_1', 'txn_abc')).toBe('stripe_acct_1_txn_abc_fee')
  })
})

describe('mapBalanceTransaction', () => {
  it('splits a charge into a gross row and a negative fee row', () => {
    const rows = mapBalanceTransaction('acct_1', makeCharge())

    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      date: CREATED_DATE,
      amount: 500,
      currency: 'SEK',
      external_id: 'stripe_acct_1_txn_charge_1',
      import_source: STRIPE_IMPORT_SOURCE,
      description: 'Stripe-betalning Anna Andersson',
      transaction_method: 'card',
    })
    expect(rows[1]).toMatchObject({
      date: CREATED_DATE,
      amount: -14.5,
      currency: 'SEK',
      external_id: 'stripe_acct_1_txn_charge_1_fee',
      description: 'Stripe-avgift (Stripe-betalning Anna Andersson)',
      transaction_method: 'fee',
    })
  })

  it('uses the charge description when billing details carry no name', () => {
    const rows = mapBalanceTransaction(
      'acct_1',
      makeCharge({
        source: {
          id: 'ch_1',
          object: 'charge',
          description: 'Order 1042',
          billing_details: { name: null },
        } as unknown as BalanceTxnLike['source'],
      }),
    )
    expect(rows[0].description).toBe('Stripe-betalning Order 1042')
  })

  it('maps a zero-fee refund to a single negative row', () => {
    const rows = mapBalanceTransaction('acct_1', {
      id: 'txn_refund_1',
      type: 'refund',
      amount: -20_000,
      fee: 0,
      currency: 'sek',
      created: CREATED,
      description: 'REFUND FOR CHARGE',
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      amount: -200,
      description: 'Stripe-återbetalning',
      external_id: 'stripe_acct_1_txn_refund_1',
      transaction_method: 'card',
    })
  })

  it('maps the payout row with the po_ id in the description (matches the payout entry)', () => {
    const rows = mapBalanceTransaction('acct_1', makePayoutTxn())
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      amount: -485.5,
      description: 'Stripe-utbetalning po_1',
      external_id: 'stripe_acct_1_txn_payout_1',
      transaction_method: 'transfer',
    })
  })

  it('labels dispute adjustments as tvist via reporting_category', () => {
    const rows = mapBalanceTransaction('acct_1', {
      id: 'txn_adj_1',
      type: 'adjustment',
      amount: -50_000,
      fee: 1_500,
      currency: 'sek',
      created: CREATED,
      description: 'Chargeback withdrawal for ch_1',
      reporting_category: 'dispute',
    })
    expect(rows).toHaveLength(2)
    expect(rows[0].description).toBe('Stripe-tvist')
    expect(rows[0].transaction_method).toBe('adjustment')
    expect(rows[1]).toMatchObject({
      amount: -15,
      external_id: 'stripe_acct_1_txn_adj_1_fee',
      transaction_method: 'fee',
    })
  })

  it("maps the SDK-unmodeled 'tax' type to a fee", () => {
    // Live Stripe sends type 'tax' for automatic-tax deductions even though
    // this SDK's BalanceTransaction union does not model it.
    const rows = mapBalanceTransaction('acct_1', {
      id: 'txn_tax_1',
      type: 'tax' as BalanceTxnLike['type'],
      amount: -1_374,
      fee: 0,
      currency: 'sek',
      created: CREATED,
      description: 'Automatic Taxes (2026-07-26)',
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].description).toBe('Stripe: Automatic Taxes (2026-07-26)')
    expect(rows[0].transaction_method).toBe('fee')
  })

  it('dates rows on created, not available_on semantics', () => {
    // created is the only date input: a mapped row for a txn created on the
    // 10th must land on the 10th even though Stripe settles days later.
    const rows = mapBalanceTransaction('acct_1', makeCharge())
    expect(rows.every((r) => r.date === CREATED_DATE)).toBe(true)
  })
})

describe('linkPayoutFeedRows', () => {
  it('links the payout row and every fee row to the payout entry, unlinked rows only', async () => {
    const { supabase, queriesFor, op } = createCaptureSupabase({
      transactions: [{ data: [{ id: 't1' }, { id: 't2' }, { id: 't3' }], error: null }],
    })

    const linked = await linkPayoutFeedRows(supabase, 'company-1', 'acct_1', 'je-po-1', [
      { id: 'txn_c1', type: 'charge', fee: 1450 },
      { id: 'txn_c2', type: 'charge', fee: 0 },
      { id: 'txn_p1', type: 'payout', fee: 0 },
    ])

    expect(linked).toBe(3)
    const query = queriesFor('transactions')[0]
    expect(op(query, 'update')!.args[0]).toEqual({ journal_entry_id: 'je-po-1' })
    expect(op(query, 'in')!.args).toEqual([
      'external_id',
      ['stripe_acct_1_txn_c1_fee', 'stripe_acct_1_txn_p1'],
    ])
    expect(op(query, 'is')!.args).toEqual(['journal_entry_id', null])
    expect(op(query, 'eq')!.args).toEqual(['company_id', 'company-1'])
  })

  it('is a no-op without fee or payout rows', async () => {
    const { supabase, queries } = createCaptureSupabase()
    const linked = await linkPayoutFeedRows(supabase, 'company-1', 'acct_1', 'je-1', [
      { id: 'txn_c1', type: 'charge', fee: 0 },
    ])
    expect(linked).toBe(0)
    expect(queries).toHaveLength(0)
  })
})

describe('syncStripeBalanceTransactions', () => {
  it('backfills 90 days on the first run', async () => {
    stubList([makeCharge()])
    const { supabase } = createCaptureSupabase({
      company_settings: [{ data: { bookkeeping_locked_through: null }, error: null }],
    })

    await syncStripeBalanceTransactions(supabase, { ...CONNECTION })

    const expected = Math.floor(
      (Date.parse('2026-07-23T10:00:00.000Z') - BACKFILL_DAYS * 86_400_000) / 1000,
    )
    expect(listWindowGte()).toBe(expected)
  })

  it('floors the first-run backfill at the day after the company lock date', async () => {
    stubList([makeCharge()])
    const { supabase } = createCaptureSupabase({
      company_settings: [{ data: { bookkeeping_locked_through: '2026-06-30' }, error: null }],
    })

    await syncStripeBalanceTransactions(supabase, { ...CONNECTION })

    expect(listWindowGte()).toBe(Math.floor(Date.parse('2026-07-01T00:00:00Z') / 1000))
  })

  it('polls from the cursor minus the 24h overlap on later runs', async () => {
    stubList([makeCharge()])
    const { supabase, queriesFor } = createCaptureSupabase()

    await syncStripeBalanceTransactions(supabase, {
      ...CONNECTION,
      last_balance_txn_synced_at: '2026-07-20T00:00:00.000Z',
    })

    expect(listWindowGte()).toBe(
      Math.floor(Date.parse('2026-07-20T00:00:00Z') / 1000) - 86_400,
    )
    // No cursor → no company_settings (lock date) lookup.
    expect(queriesFor('company_settings')).toHaveLength(0)
  })

  it('ingests the mapped rows onto the 1686 cash account without auto-categorization', async () => {
    stubList([makeCharge()])
    const { supabase } = createCaptureSupabase({
      company_settings: [{ data: null, error: null }],
    })
    vi.mocked(ingestTransactions).mockResolvedValue({
      imported: 2, duplicates: 0, reconciled: 0, auto_categorized: 0,
      auto_matched_invoices: 0, errors: 0, transaction_ids: ['t1', 't2'],
    } as never)

    const summary = await syncStripeBalanceTransactions(supabase, { ...CONNECTION })

    expect(summary).toMatchObject({ fetched: 1, imported: 2, duplicates: 0, errors: 0 })
    expect(vi.mocked(ensureManualCashAccount)).toHaveBeenCalledWith(
      supabase, 'company-1', STRIPE_LEDGER_ACCOUNT, 'SEK', 'Stripe-saldo',
    )
    const [, companyId, userId, rows, options] =
      vi.mocked(ingestTransactions).mock.calls[0]
    expect(companyId).toBe('company-1')
    expect(userId).toBe('user-1')
    expect((rows as unknown[]).length).toBe(2)
    expect(options).toEqual({
      settlementAccount: STRIPE_LEDGER_ACCOUNT,
      skipAutoCategorization: true,
    })
  })

  it('advances the cursor to the newest processed transaction', async () => {
    stubList([makeCharge(), makePayoutTxn()])
    const { supabase, queriesFor, op } = createCaptureSupabase({
      company_settings: [{ data: null, error: null }],
    })

    await syncStripeBalanceTransactions(supabase, { ...CONNECTION })

    const cursorUpdate = queriesFor('stripe_connections')[0]
    expect(op(cursorUpdate, 'update')!.args[0]).toEqual({
      last_balance_txn_synced_at: new Date((CREATED + 3600) * 1000).toISOString(),
    })
    expect(op(cursorUpdate, 'eq')!.args).toEqual(['id', 'conn-1'])
  })

  it('pre-links gross rows of charges the checkout flow already settled', async () => {
    stubList([makeCharge()])
    const { supabase, queriesFor, op } = createCaptureSupabase({
      company_settings: [{ data: null, error: null }],
      stripe_payment_events: [
        { data: [{ payment_intent_id: 'pi_1', journal_entry_id: 'je-settle-1' }], error: null },
      ],
      transactions: [{ data: [{ id: 't1' }], error: null }],
    })

    const summary = await syncStripeBalanceTransactions(supabase, { ...CONNECTION })

    expect(summary.linked).toBe(1)
    const eventsQuery = queriesFor('stripe_payment_events')[0]
    expect(op(eventsQuery, 'in')!.args).toEqual(['payment_intent_id', ['pi_1']])
    const linkQuery = queriesFor('transactions')[0]
    expect(op(linkQuery, 'update')!.args[0]).toEqual({ journal_entry_id: 'je-settle-1' })
    expect(op(linkQuery, 'in')!.args).toEqual(['external_id', ['stripe_acct_1_txn_charge_1']])
    expect(op(linkQuery, 'is')!.args).toEqual(['journal_entry_id', null])
  })

  it('claims fee rows and the payout row of an already-booked payout', async () => {
    const charge = makeCharge()
    const payoutTxn = makePayoutTxn()
    stubList([charge, payoutTxn], [charge, payoutTxn])
    const { supabase, queriesFor, op } = createCaptureSupabase({
      company_settings: [{ data: null, error: null }],
      stripe_payment_events: [{ data: [], error: null }],
      stripe_payouts: [
        { data: [{ payout_id: 'po_1', journal_entry_id: 'je-po-1' }], error: null },
      ],
      transactions: [{ data: [{ id: 't1' }, { id: 't2' }], error: null }],
    })

    const summary = await syncStripeBalanceTransactions(supabase, { ...CONNECTION })

    expect(summary.linked).toBe(2)
    const payoutQuery = queriesFor('stripe_payouts')[0]
    expect(op(payoutQuery, 'in')!.args).toEqual(['payout_id', ['po_1']])
    // The per-payout balance transaction list resolves the fee rows.
    const payoutListCall = balanceTransactionsList.mock.calls.find(
      (c) => 'payout' in (c[0] as Record<string, unknown>),
    )
    expect(payoutListCall?.[0]).toMatchObject({ payout: 'po_1' })
    const linkQuery = queriesFor('transactions')[0]
    expect(op(linkQuery, 'update')!.args[0]).toEqual({ journal_entry_id: 'je-po-1' })
    expect(op(linkQuery, 'in')!.args).toEqual([
      'external_id',
      ['stripe_acct_1_txn_charge_1_fee', 'stripe_acct_1_txn_payout_1'],
    ])
  })

  it('stops before ingesting when the deadline already passed and reports it', async () => {
    stubList([makeCharge()])
    const { supabase } = createCaptureSupabase({
      company_settings: [{ data: null, error: null }],
    })

    const summary = await syncStripeBalanceTransactions(
      supabase, { ...CONNECTION }, undefined, Date.now() - 1,
    )

    expect(summary.deadlineReached).toBe(true)
    expect(vi.mocked(ingestTransactions)).not.toHaveBeenCalled()
  })

  it('reports a revoked connection without throwing', async () => {
    balanceTransactionsList.mockImplementation(() => ({
      autoPagingToArray: vi.fn().mockRejectedValue({ type: 'StripePermissionError' }),
    }))
    const { supabase } = createCaptureSupabase({
      company_settings: [{ data: null, error: null }],
    })

    const summary = await syncStripeBalanceTransactions(supabase, { ...CONNECTION })

    expect(summary.revoked).toBe(true)
    expect(summary.fetched).toBe(0)
  })

  it('does nothing for a non-active connection', async () => {
    const { supabase, queries } = createCaptureSupabase()
    const summary = await syncStripeBalanceTransactions(supabase, {
      ...CONNECTION,
      status: 'revoked',
    })
    expect(summary.fetched).toBe(0)
    expect(queries).toHaveLength(0)
    expect(balanceTransactionsList).not.toHaveBeenCalled()
  })
})
