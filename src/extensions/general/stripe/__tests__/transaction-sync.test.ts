import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const balanceTransactionsList = vi.fn()
const payoutsList = vi.fn()

vi.mock('@/lib/stripe/client', () => ({
  getStripe: () => ({
    balanceTransactions: { list: balanceTransactionsList },
    payouts: { list: payoutsList },
  }),
}))

vi.mock('@/lib/reconciliation/gl-balance', () => ({
  sumAccountBalance: vi.fn(),
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
import { syncMappedAccounts } from '@/lib/import/account-sync'
import { sumAccountBalance } from '@/lib/reconciliation/gl-balance'
import { eventBus } from '@/lib/events/bus'
import {
  STRIPE_IMPORT_SOURCE,
  STRIPE_LEDGER_ACCOUNT,
  isLedgerCurrency,
  mapBalanceTransaction,
  stripeExternalId,
  STRIPE_HISTORY_TOO_LARGE_MESSAGE,
  stripeFeeExternalId,
  syncStripeBalanceTransactions,
  type BalanceTxnLike,
} from '../lib/transaction-sync'
import type { StripeConnection } from '../types'
import { PROVIDER_BOOKING_ID_SOURCES } from '@/lib/transactions/external-id'
import { failureNote } from '@/lib/webshop-orders/order-cron'

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
  balanceTransactionsList.mockImplementation(async (params: Record<string, unknown>) => ({
    data: 'payout' in params ? byPayout : byWindow,
    has_more: false,
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
  eventBus.clear()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-07-23T10:00:00.000Z'))
  // Default: an empty 1686 and no payout before the connection.
  vi.mocked(sumAccountBalance).mockResolvedValue(0)
  payoutsList.mockResolvedValue({ data: [] })
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

  // The booking-time duplicate guard trusts a different id between two Stripe
  // rows as proof of two movements (crm#1271). That holds only while these
  // ids embed Stripe's own balance-transaction id, which the frozen formats
  // above pin, and while the feed's import_source stays the trusted label.
  it('is a feed whose stored ids the booking guard trusts as per-booking references', () => {
    expect(PROVIDER_BOOKING_ID_SOURCES.has(STRIPE_IMPORT_SOURCE)).toBe(true)
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

  it('dates rows on the Swedish day, not the UTC day (crm#1344)', () => {
    // 2026-10-17T23:00:55Z is 01:00 on 18 October in Stockholm.
    const rows = mapBalanceTransaction('acct_1', makeCharge({ created: 1_792_278_055 }))
    expect(rows.map((r) => r.date)).toEqual(['2026-10-18', '2026-10-18'])
    // Winter time: 2026-12-31T23:30Z is already 1 January in Stockholm.
    const newYear = Math.floor(Date.parse('2026-12-31T23:30:00Z') / 1000)
    expect(mapBalanceTransaction('acct_1', makeCharge({ created: newYear }))[0].date).toBe('2027-01-01')
  })

  it('dates rows on created, not available_on semantics', () => {
    // created is the only date input: a mapped row for a txn created on the
    // 10th must land on the 10th even though Stripe settles days later.
    const rows = mapBalanceTransaction('acct_1', makeCharge())
    expect(rows.every((r) => r.date === CREATED_DATE)).toBe(true)
  })
})

describe('syncStripeBalanceTransactions', () => {
  const CONNECTED_SEC = Math.floor(Date.parse(CONNECTION.connected_at!) / 1000)

  describe('first run after connecting (crm#1344)', () => {
    // 2026-10-17T23:17:34Z = 01:17 on 18 October in Stockholm (CEST).
    const TICKET = { connected_at: '2026-10-17T23:17:34.194Z', last_balance_txn_synced_at: '2026-10-17T23:17:34.194Z' }
    const TICKET_SEC = Math.floor(Date.parse(TICKET.connected_at) / 1000)
    // Swedish midnight starting 18 October.
    const DAY_START_SEC = Math.floor(Date.parse('2026-10-17T22:00:00Z') / 1000)
    // The charge from the ticket: 23:00:55Z, 17 minutes before connecting.
    const BEFORE_CONNECTING = 1_792_278_055

    beforeEach(() => {
      vi.setSystemTime(new Date('2026-10-20T03:30:00.000Z'))
    })

    it('starts at Swedish midnight of the connection day when 1686 already carries the balance', async () => {
      // The books hold the Stripe balance (kept by hand up to the day before):
      // the feed starts at the connection day, as the panel says, so a payment
      // made earlier that same day is not lost between the two.
      vi.mocked(sumAccountBalance).mockResolvedValue(2116.99)
      stubList([makeCharge({ id: 'txn_night', created: BEFORE_CONNECTING })])
      const { supabase } = createCaptureSupabase({
        company_settings: [{ data: { bookkeeping_locked_through: null }, error: null }],
      })

      const summary = await syncStripeBalanceTransactions(supabase, { ...CONNECTION, ...TICKET })

      expect(listWindowGte()).toBe(DAY_START_SEC)
      expect(vi.mocked(sumAccountBalance)).toHaveBeenCalledWith(supabase, 'company-1', '1686', {
        beforeDate: '2026-10-18',
      })
      // The ledger already answers it: Stripe's payouts are never asked.
      expect(payoutsList).not.toHaveBeenCalled()
      expect(summary.fetched).toBe(1)
      const rows = vi.mocked(ingestTransactions).mock.calls[0][3] as Array<{ date: string; external_id: string }>
      expect(rows[0]).toMatchObject({ date: '2026-10-18', external_id: 'stripe_acct_1_txn_night' })
    })

    it('treats a failed ledger read like a carried balance (never imports more than before)', async () => {
      vi.mocked(sumAccountBalance).mockResolvedValue(null)
      stubList([])
      const { supabase } = createCaptureSupabase()

      await syncStripeBalanceTransactions(supabase, { ...CONNECTION, ...TICKET })

      expect(listWindowGte()).toBe(DAY_START_SEC)
      expect(payoutsList).not.toHaveBeenCalled()
    })

    it('reads what was still on the Stripe balance at the connection moment when 1686 is empty', async () => {
      // Last payout before connecting: 15 October 03:00Z. It took everything
      // payable by then; anything payable later was still on the balance.
      const LAST_PAYOUT = Math.floor(Date.parse('2026-10-15T03:00:00Z') / 1000)
      payoutsList.mockResolvedValue({
        data: [
          { id: 'po_last', currency: 'sek', created: LAST_PAYOUT },
          { id: 'po_older', currency: 'sek', created: LAST_PAYOUT - 86_400 },
        ],
      })
      const day = 86_400
      stubList([
        // Paid out on the 15th: in the bank, booked from there.
        makeCharge({ id: 'txn_paid', created: LAST_PAYOUT - 8 * day, available_on: LAST_PAYOUT - day }),
        // The payout itself, before connecting: booked from the bank deposit.
        makePayoutTxn({ id: 'txn_po_last', created: LAST_PAYOUT, available_on: LAST_PAYOUT }),
        // Charged before the last payout but payable only after it: still on
        // the balance, so the next payout carries it out against 1686.
        makeCharge({ id: 'txn_pending', created: LAST_PAYOUT - 2 * day, available_on: LAST_PAYOUT + 5 * day }),
        // The ticket's charge: made 17 minutes before connecting, not yet paid out.
        makeCharge({ id: 'txn_night', created: BEFORE_CONNECTING, available_on: BEFORE_CONNECTING + 7 * day }),
        // After connecting: always in.
        makeCharge({ id: 'txn_after', created: TICKET_SEC + 3600, available_on: TICKET_SEC + 8 * day }),
      ])
      const { supabase, queriesFor, op } = createCaptureSupabase({
        company_settings: [{ data: { bookkeeping_locked_through: null }, error: null }],
      })
      vi.mocked(ingestTransactions).mockResolvedValue({
        imported: 6, duplicates: 0, reconciled: 0, auto_categorized: 0,
        auto_matched_invoices: 0, errors: 0, transaction_ids: [],
      } as never)

      const summary = await syncStripeBalanceTransactions(supabase, { ...CONNECTION, ...TICKET })

      // Payouts before the connection moment, on the connected account.
      expect(payoutsList).toHaveBeenCalledWith(
        { created: { lt: TICKET_SEC }, limit: 100 },
        { stripeAccount: 'acct_1' },
      )
      // Reaches back far enough for a charge held up to the longest payout delay.
      expect(listWindowGte()).toBe(LAST_PAYOUT - 31 * day)
      const ids = (vi.mocked(ingestTransactions).mock.calls[0][3] as Array<{ external_id: string }>)
        .map((r) => r.external_id)
        .filter((id) => !id.endsWith('_fee'))
      expect(ids).toEqual([
        'stripe_acct_1_txn_pending',
        'stripe_acct_1_txn_night',
        'stripe_acct_1_txn_after',
      ])
      expect(summary.fetched).toBe(3)
      // No cursor write ever lands before the connection moment: a stopped
      // first run must rerun as a first run, not read as a backfill.
      for (const q of queriesFor('stripe_connections')) {
        const written = (op(q, 'update')!.args[0] as { last_balance_txn_synced_at: string }).last_balance_txn_synced_at
        expect(Date.parse(written)).toBeGreaterThanOrEqual(Date.parse(TICKET.connected_at))
      }
    })

    it('keeps a pre-connection chunk without moving the seeded cursor back', async () => {
      const LAST_PAYOUT = Math.floor(Date.parse('2026-10-15T03:00:00Z') / 1000)
      payoutsList.mockResolvedValue({ data: [{ id: 'po_last', currency: 'sek', created: LAST_PAYOUT }] })
      stubList([makeCharge({ id: 'txn_night', created: BEFORE_CONNECTING, available_on: BEFORE_CONNECTING + 86_400 })])
      const { supabase, queriesFor, op } = createCaptureSupabase()

      await syncStripeBalanceTransactions(supabase, { ...CONNECTION, ...TICKET })

      // Only the run-start watermark is written; the chunk at 23:00Z is not.
      const writes = queriesFor('stripe_connections').map(
        (q) => (op(q, 'update')!.args[0] as { last_balance_txn_synced_at: string }).last_balance_txn_synced_at,
      )
      expect(writes).toEqual(['2026-10-20T03:30:00.000Z'])
    })

    it('reads the lookback in full when the account had no payout before connecting', async () => {
      stubList([
        makeCharge({ id: 'txn_old', created: TICKET_SEC - 20 * 86_400, available_on: TICKET_SEC - 13 * 86_400 }),
        makePayoutTxn({ id: 'txn_po', created: TICKET_SEC - 86_400 }),
      ])
      const { supabase } = createCaptureSupabase()

      const summary = await syncStripeBalanceTransactions(supabase, { ...CONNECTION, ...TICKET })

      expect(listWindowGte()).toBe(TICKET_SEC - 90 * 86_400)
      expect(summary.fetched).toBe(1)
    })

    it('falls back to the connection day when Stripe will not list payouts', async () => {
      payoutsList.mockRejectedValue(Object.assign(new Error('boom'), { type: 'StripeAPIError' }))
      stubList([])
      const { supabase } = createCaptureSupabase()

      await syncStripeBalanceTransactions(supabase, { ...CONNECTION, ...TICKET })

      expect(listWindowGte()).toBe(DAY_START_SEC)
    })

    it('marks the connection revoked when the payout list says access is gone', async () => {
      payoutsList.mockRejectedValue({ type: 'StripePermissionError' })
      const { supabase } = createCaptureSupabase()

      const summary = await syncStripeBalanceTransactions(supabase, { ...CONNECTION, ...TICKET })

      expect(summary.revoked).toBe(true)
      expect(balanceTransactionsList).not.toHaveBeenCalled()
    })

    it('floors the open-balance window at the first Swedish day after the lock date', async () => {
      payoutsList.mockResolvedValue({ data: [] })
      stubList([])
      const { supabase } = createCaptureSupabase({
        company_settings: [{ data: { bookkeeping_locked_through: '2026-09-30' }, error: null }],
      })

      await syncStripeBalanceTransactions(supabase, { ...CONNECTION, ...TICKET })

      expect(listWindowGte()).toBe(Math.floor(Date.parse('2026-09-30T22:00:00Z') / 1000))
    })
  })

  it('treats a legacy null cursor as a first run', async () => {
    stubList([makeCharge()])
    const { supabase } = createCaptureSupabase()

    await syncStripeBalanceTransactions(supabase, { ...CONNECTION })

    // Empty 1686, no payout: the open-balance lookback from the connection.
    expect(listWindowGte()).toBe(CONNECTED_SEC - 90 * 86_400)
    expect(vi.mocked(sumAccountBalance)).toHaveBeenCalledTimes(1)
  })

  it('clamps the overlap at the connection moment while still within a day of it', async () => {
    stubList([makeCharge()])
    const { supabase } = createCaptureSupabase()

    await syncStripeBalanceTransactions(supabase, {
      ...CONNECTION,
      last_balance_txn_synced_at: '2026-07-01T12:00:00.000Z',
    })

    expect(listWindowGte()).toBe(CONNECTED_SEC)
  })

  // A backfill to 1 January: Swedish midnight, as the backfill route sets it.
  const BACKFILL = '2025-12-31T23:00:00.000Z'
  const BACKFILL_SEC = Math.floor(Date.parse(BACKFILL) / 1000)

  it('honours a backfill day exactly when 1686 already carries the balance before it', async () => {
    vi.mocked(sumAccountBalance).mockResolvedValue(-120.5)
    stubList([makeCharge()])
    const { supabase } = createCaptureSupabase({
      company_settings: [{ data: { bookkeeping_locked_through: null }, error: null }],
    })

    await syncStripeBalanceTransactions(supabase, { ...CONNECTION, last_balance_txn_synced_at: BACKFILL })

    expect(listWindowGte()).toBe(BACKFILL_SEC)
    expect(vi.mocked(sumAccountBalance)).toHaveBeenCalledWith(supabase, 'company-1', '1686', {
      beforeDate: '2026-01-01',
    })
    expect(payoutsList).not.toHaveBeenCalled()
  })

  it('reads the balance still unpaid on a backfill day when 1686 is empty before it', async () => {
    // The chosen day must not cut through the Stripe balance either: the
    // first payout after it carries that money out against 1686.
    const LAST_PAYOUT = Math.floor(Date.parse('2025-12-30T03:00:00Z') / 1000)
    payoutsList.mockResolvedValue({ data: [{ id: 'po_dec', currency: 'sek', created: LAST_PAYOUT }] })
    stubList([
      makeCharge({ id: 'txn_paid_out', created: LAST_PAYOUT - 9 * 86_400, available_on: LAST_PAYOUT - 86_400 }),
      makeCharge({ id: 'txn_unpaid', created: BACKFILL_SEC - 3600, available_on: BACKFILL_SEC + 6 * 86_400 }),
    ])
    const { supabase } = createCaptureSupabase()

    const summary = await syncStripeBalanceTransactions(supabase, {
      ...CONNECTION,
      last_balance_txn_synced_at: BACKFILL,
    })

    expect(payoutsList).toHaveBeenCalledWith(
      { created: { lt: BACKFILL_SEC }, limit: 100 },
      { stripeAccount: 'acct_1' },
    )
    expect(listWindowGte()).toBe(LAST_PAYOUT - 31 * 86_400)
    expect(summary.fetched).toBe(1)
    const rows = vi.mocked(ingestTransactions).mock.calls[0][3] as Array<{ external_id: string; date: string }>
    expect(rows[0]).toMatchObject({ external_id: 'stripe_acct_1_txn_unpaid', date: '2025-12-31' })
  })

  it('floors a backfill window at Swedish midnight after the company lock date', async () => {
    // Rows on/before the lock date can never be booked; a backfill reaching
    // behind it would only leave permanent inbox noise.
    stubList([makeCharge()])
    const { supabase } = createCaptureSupabase({
      company_settings: [{ data: { bookkeeping_locked_through: '2026-06-30' }, error: null }],
    })

    await syncStripeBalanceTransactions(supabase, {
      ...CONNECTION,
      last_balance_txn_synced_at: '2026-01-01T00:00:00.000Z',
    })

    // Rows are dated on the Swedish day, and 1 July starts at 22:00Z (CEST).
    expect(listWindowGte()).toBe(Math.floor(Date.parse('2026-06-30T22:00:00Z') / 1000))
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
    // The lock-date floor sits on every resolved window now, not only on
    // the first run: one indexed company_settings read per run.
    expect(queriesFor('company_settings')).toHaveLength(1)
  })

  it('seeds 1686 into the chart until the cursor has passed the connection moment', async () => {
    stubList([makeCharge()])

    // First real run: the cursor is still the seeded connection moment.
    await syncStripeBalanceTransactions(createCaptureSupabase().supabase, {
      ...CONNECTION,
      last_balance_txn_synced_at: CONNECTION.connected_at,
    })
    expect(vi.mocked(syncMappedAccounts)).toHaveBeenCalledTimes(1)

    // Later run: the cursor has advanced past it, so the one-time setup stops.
    await syncStripeBalanceTransactions(createCaptureSupabase().supabase, {
      ...CONNECTION,
      last_balance_txn_synced_at: '2026-07-10T00:00:00.000Z',
    })
    expect(vi.mocked(syncMappedAccounts)).toHaveBeenCalledTimes(1)
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
    // stableExternalIds: a Stripe id names one booking for good, so a second
    // identical refund in a later ingest call is never a copy of the first.
    expect(options).toEqual({
      settlementAccount: STRIPE_LEDGER_ACCOUNT,
      skipAutoCategorization: true,
      stableExternalIds: true,
    })
  })

  describe('non-SEK balance transactions (accounted#58 P1.10)', () => {
    it('ingests only the SEK rows and counts the rest as foreignCurrency', async () => {
      // A Stripe account holding a USD balance: Stripe states those balance
      // transactions in USD and gives no kronor value, and the 1686 cash
      // account is kept in SEK, where the bank-booking guards refuse them.
      stubList([
        makeCharge(),
        makeCharge({ id: 'txn_usd_1', currency: 'usd' }),
        makePayoutTxn({ id: 'txn_usd_po', currency: 'usd' }),
      ])
      const { supabase } = createCaptureSupabase({
        company_settings: [{ data: null, error: null }],
      })
      const warn = vi.fn()
      const log = { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never

      const summary = await syncStripeBalanceTransactions(supabase, { ...CONNECTION }, log)

      expect(summary).toMatchObject({ fetched: 3, foreignCurrency: 2 })
      const rows = vi.mocked(ingestTransactions).mock.calls[0][3] as Array<{ currency: string; external_id: string }>
      expect(rows.map((r) => r.currency)).toEqual(['SEK', 'SEK'])
      expect(rows.map((r) => r.external_id)).toEqual([
        stripeExternalId('acct_1', 'txn_charge_1'),
        stripeFeeExternalId('acct_1', 'txn_charge_1'),
      ])
      expect(warn).toHaveBeenCalledWith('non-SEK balance transactions left out of the feed', {
        connectionId: 'conn-1',
        currencies: { USD: 2 },
      })
    })

    it('ingests nothing for a run with only non-SEK rows but still moves the cursor past them', async () => {
      stubList([makeCharge({ id: 'txn_eur_1', currency: 'eur' })])
      const { supabase, queriesFor, op } = createCaptureSupabase({
        company_settings: [{ data: null, error: null }],
      })

      const summary = await syncStripeBalanceTransactions(supabase, {
        ...CONNECTION,
        last_balance_txn_synced_at: '2026-07-10T00:00:00.000Z',
      })

      expect(summary).toMatchObject({ fetched: 1, imported: 0, foreignCurrency: 1 })
      expect(vi.mocked(ingestTransactions)).not.toHaveBeenCalled()
      // Left out is processed: the cursor moves on to the run start, so the
      // next run does not list them again.
      const updates = queriesFor('stripe_connections')
      expect(updates).toHaveLength(1)
      const iso = (op(updates[0], 'update')!.args[0] as { last_balance_txn_synced_at: string }).last_balance_txn_synced_at
      expect(Math.abs(Date.parse(iso) - Date.now())).toBeLessThan(60_000)
    })

    it('reports zero foreignCurrency for an all-SEK run', async () => {
      stubList([makeCharge()])
      const { supabase } = createCaptureSupabase({
        company_settings: [{ data: null, error: null }],
      })

      const summary = await syncStripeBalanceTransactions(supabase, { ...CONNECTION })

      expect(summary.foreignCurrency).toBe(0)
      expect(vi.mocked(ingestTransactions)).toHaveBeenCalledTimes(1)
    })
  })

  describe('isLedgerCurrency', () => {
    it('accepts SEK in any case and nothing else', () => {
      expect(isLedgerCurrency({ currency: 'sek' })).toBe(true)
      expect(isLedgerCurrency({ currency: 'SEK' })).toBe(true)
      expect(isLedgerCurrency({ currency: 'usd' })).toBe(false)
      expect(isLedgerCurrency({ currency: 'chf' })).toBe(false)
    })
  })

  it('advances the cursor to the newest processed transaction', async () => {
    stubList([makeCharge(), makePayoutTxn()])
    const { supabase, queriesFor, op } = createCaptureSupabase({
      company_settings: [{ data: null, error: null }],
    })

    await syncStripeBalanceTransactions(supabase, { ...CONNECTION })

    const cursorUpdate = queriesFor('stripe_connections')[0]
    // Progress also clears a failure the nightly run wrote on the connection.
    expect(op(cursorUpdate, 'update')!.args[0]).toEqual({
      last_balance_txn_synced_at: new Date((CREATED + 3600) * 1000).toISOString(),
      error_message: null,
    })
    expect(op(cursorUpdate, 'eq')!.args).toEqual(['id', 'conn-1'])
  })

  it('moves the cursor on to the run start once the window is listed to its end', async () => {
    stubList([makeCharge()])
    const { supabase, queriesFor, op } = createCaptureSupabase({
      company_settings: [{ data: null, error: null }],
    })

    await syncStripeBalanceTransactions(supabase, { ...CONNECTION })

    const [chunk, watermark] = queriesFor('stripe_connections')
    expect(op(chunk, 'update')!.args[0]).toEqual({ last_balance_txn_synced_at: new Date(CREATED * 1000).toISOString(), error_message: null })
    const iso = (op(watermark, 'update')!.args[0] as { last_balance_txn_synced_at: string }).last_balance_txn_synced_at
    expect(Math.abs(Date.parse(iso) - Date.now())).toBeLessThan(60_000)
  })

  it('holds the cursor below a chunk with a row that failed to insert, so the next run retries it', async () => {
    // Moving on would leave a row that fails two runs in a row outside the 24h overlap for good.
    stubList([makeCharge()])
    const { supabase, queriesFor, op } = createCaptureSupabase({
      company_settings: [{ data: null, error: null }],
    })
    vi.mocked(ingestTransactions).mockResolvedValue({
      imported: 1, duplicates: 0, reconciled: 0, auto_categorized: 0,
      auto_matched_invoices: 0, errors: 1, transaction_ids: ['t1'],
      first_error: { message: 'statement timeout', code: '57014' },
    } as never)
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }

    const summary = await syncStripeBalanceTransactions(
      supabase, { ...CONNECTION, last_balance_txn_synced_at: '2026-07-05T00:00:00.000Z' }, log as never,
    )

    expect(summary.errors).toBe(1)
    // Up to just below the failed chunk, and no run-start watermark past it.
    const updates = queriesFor('stripe_connections')
    expect(updates).toHaveLength(1)
    expect(op(updates[0], 'update')!.args[0]).toEqual({ last_balance_txn_synced_at: new Date((CREATED - 1) * 1000).toISOString(), error_message: null })
    expect(log.warn).toHaveBeenCalledWith('balance-transaction rows not imported; cursor held below them', {
      connectionId: 'conn-1', errors: 1, code: '57014', reason: 'statement timeout',
    })
  })

  it('moves a quiet account\'s cursor to the run start on a later run', async () => {
    // Otherwise it keeps the front of the cron's oldest-cursor-first list.
    stubList([])
    const { supabase, queriesFor, op } = createCaptureSupabase()

    await syncStripeBalanceTransactions(supabase, { ...CONNECTION, last_balance_txn_synced_at: '2026-07-10T00:00:00.000Z' })

    const updates = queriesFor('stripe_connections')
    expect(updates).toHaveLength(1)
    const iso = (op(updates[0], 'update')!.args[0] as { last_balance_txn_synced_at: string }).last_balance_txn_synced_at
    expect(Math.abs(Date.parse(iso) - Date.now())).toBeLessThan(60_000)
  })

  it('keeps the seeded cursor on a quiet first run, so the one-time 1686 setup still runs on the first row', async () => {
    stubList([])
    const { supabase, queriesFor } = createCaptureSupabase()

    await syncStripeBalanceTransactions(supabase, { ...CONNECTION, last_balance_txn_synced_at: CONNECTION.connected_at })

    expect(queriesFor('stripe_connections')).toHaveLength(0)
    expect(vi.mocked(syncMappedAccounts)).not.toHaveBeenCalled()
  })

  it('stops before ingesting when the deadline already passed and reports it', async () => {
    stubList([makeCharge()])
    const { supabase, queriesFor } = createCaptureSupabase({
      company_settings: [{ data: null, error: null }],
    })

    const summary = await syncStripeBalanceTransactions(
      supabase, { ...CONNECTION }, undefined, Date.now() - 1,
    )

    expect(summary.deadlineReached).toBe(true)
    expect(vi.mocked(ingestTransactions)).not.toHaveBeenCalled()
    // Unprocessed rows remain, so no watermark either.
    expect(queriesFor('stripe_connections')).toHaveLength(0)
  })

  describe('listing page by page under the deadline', () => {
    const page = (ids: string[], has_more: boolean) => ({
      data: ids.map((id, i) => makeCharge({ id, created: CREATED - i })),
      has_more,
    })

    it('asks for the next page after the last id, and ingests all pages', async () => {
      balanceTransactionsList
        .mockResolvedValueOnce(page(['txn_3', 'txn_2'], true))
        .mockResolvedValueOnce(page(['txn_1'], false))
      const { supabase } = createCaptureSupabase({ company_settings: [{ data: null, error: null }] })

      const summary = await syncStripeBalanceTransactions(supabase, { ...CONNECTION })

      expect(summary.fetched).toBe(3)
      expect(balanceTransactionsList).toHaveBeenCalledTimes(2)
      expect(balanceTransactionsList.mock.calls[0][0]).not.toHaveProperty('starting_after')
      expect(balanceTransactionsList.mock.calls[1][0]).toMatchObject({ starting_after: 'txn_2', limit: 100 })
      // No deadline (the button): the client's own timeout and retries.
      expect(balanceTransactionsList.mock.calls[0][1]).toEqual({ stripeAccount: 'acct_1' })
    })

    it('stops between pages at the deadline: nothing ingested, the cursor stays, the next run lists again', async () => {
      // The listed pages are the newest part of the window. Ingesting them and
      // moving the cursor would skip the older transactions for good.
      const deadlineMs = Date.now() + 30_000
      balanceTransactionsList.mockImplementationOnce(async () => {
        vi.setSystemTime(deadlineMs + 1)
        return page(['txn_3', 'txn_2'], true)
      })
      const { supabase, queriesFor } = createCaptureSupabase({ company_settings: [{ data: null, error: null }] })

      const summary = await syncStripeBalanceTransactions(supabase, { ...CONNECTION }, undefined, deadlineMs)

      expect(summary).toMatchObject({ deadlineReached: true, fetched: 0, imported: 0 })
      expect(balanceTransactionsList).toHaveBeenCalledTimes(1)
      // Under a deadline each page is bounded, so the last one ends inside the route's limit.
      expect(balanceTransactionsList.mock.calls[0][1]).toEqual({ stripeAccount: 'acct_1', timeout: 25_000, maxNetworkRetries: 1 })
      expect(vi.mocked(ingestTransactions)).not.toHaveBeenCalled()
      expect(queriesFor('stripe_connections')).toHaveLength(0)
    })

    it('stops at its own share of the run, not the run\'s end, and says so in words the connection can show', async () => {
      // A listing too large for any night used the whole 240 s run every
      // night: its cursor never moves, so it stayed first, and the runner
      // stopped at the deadline before any connection behind it.
      const startMs = Date.now()
      const deadlineMs = startMs + 240_000
      balanceTransactionsList.mockImplementationOnce(async () => {
        vi.setSystemTime(startMs + 120_001)
        return page(['txn_3', 'txn_2'], true)
      })
      const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }
      const { supabase, queriesFor } = createCaptureSupabase({ company_settings: [{ data: null, error: null }] })

      const thrown = await syncStripeBalanceTransactions(supabase, { ...CONNECTION }, log as never, deadlineMs).catch((err: unknown) => err)

      expect(thrown).toBeInstanceOf(Error)
      expect((thrown as Error).message).toBe(STRIPE_HISTORY_TOO_LARGE_MESSAGE)
      // Well before the run's end: the rest of the run is left to the others.
      expect(Date.now()).toBeLessThan(deadlineMs - 100_000)
      expect(balanceTransactionsList).toHaveBeenCalledTimes(1)
      expect(vi.mocked(ingestTransactions)).not.toHaveBeenCalled()
      expect(queriesFor('stripe_connections')).toHaveLength(0)
      // For us to solve: no night gets through.
      expect(log.error).toHaveBeenCalledWith('stripe balance-transaction listing does not fit its share of the nightly run', expect.objectContaining({ connectionId: 'conn-1', listed: 2 }))
      // What the runner then stores on the connection promises no retry.
      expect(failureNote('Stripe Connect', thrown)).toBe(
        'Den senaste automatiska hämtningen från Stripe Connect misslyckades. Historiken hos Stripe är för stor för att hämtas automatiskt. Supporten har fått veta det.',
      )
    })

    it('pauses instead when the run\'s end comes before its own share: a later night gives it the whole share', async () => {
      const startMs = Date.now()
      const deadlineMs = startMs + 90_000
      balanceTransactionsList.mockImplementationOnce(async () => {
        vi.setSystemTime(deadlineMs + 1)
        return page(['txn_3'], true)
      })
      const { supabase } = createCaptureSupabase({ company_settings: [{ data: null, error: null }] })
      const summary = await syncStripeBalanceTransactions(supabase, { ...CONNECTION }, undefined, deadlineMs)
      expect(summary).toMatchObject({ deadlineReached: true, fetched: 0 })
    })
  })

  it('marks a connection revoked upstream as revoked and audits it', async () => {
    // The nightly feed is the only sync that runs: if it only reported the
    // revocation, the connection would stay "active" in settings forever.
    balanceTransactionsList.mockRejectedValue({ type: 'StripePermissionError' })
    const disconnected = vi.fn()
    eventBus.on('stripe.disconnected', disconnected)
    const { supabase, queriesFor, op } = createCaptureSupabase({
      company_settings: [{ data: null, error: null }],
    })

    const summary = await syncStripeBalanceTransactions(supabase, { ...CONNECTION })

    expect(summary.revoked).toBe(true)
    expect(summary.fetched).toBe(0)
    expect(vi.mocked(ingestTransactions)).not.toHaveBeenCalled()

    const updates = queriesFor('stripe_connections').filter((q) => op(q, 'update'))
    expect(updates).toHaveLength(1)
    expect(op(updates[0], 'update')!.args[0]).toEqual({
      status: 'revoked',
      disconnected_at: '2026-07-23T10:00:00.000Z',
      error_message: 'Åtkomsten återkallades hos Stripe.',
    })
    expect(op(updates[0], 'eq')!.args).toEqual(['id', 'conn-1'])

    expect(disconnected).toHaveBeenCalledWith({
      connectionId: 'conn-1',
      stripeAccountId: 'acct_1',
      reason: 'revoked_upstream',
      userId: 'user-1',
      companyId: 'company-1',
    })
  })

  it('still marks the connection revoked when the audit event fails', async () => {
    balanceTransactionsList.mockRejectedValue({ code: 'account_invalid' })
    eventBus.on('stripe.disconnected', () => {
      throw new Error('audit down')
    })
    const { supabase, queriesFor, op } = createCaptureSupabase({
      company_settings: [{ data: null, error: null }],
    })

    const summary = await syncStripeBalanceTransactions(supabase, { ...CONNECTION })

    expect(summary.revoked).toBe(true)
    const updates = queriesFor('stripe_connections').filter((q) => op(q, 'update'))
    expect(updates).toHaveLength(1)
    expect(op(updates[0], 'update')!.args[0]).toMatchObject({ status: 'revoked' })
  })

  it('leaves the connection alone on an error that is not a revocation', async () => {
    balanceTransactionsList.mockRejectedValue(
      Object.assign(new Error('Invalid API Key provided'), { type: 'StripeAuthenticationError' }),
    )
    const disconnected = vi.fn()
    eventBus.on('stripe.disconnected', disconnected)
    const { supabase, queriesFor } = createCaptureSupabase({
      company_settings: [{ data: null, error: null }],
    })

    await expect(syncStripeBalanceTransactions(supabase, { ...CONNECTION })).rejects.toThrow(
      'Invalid API Key provided',
    )
    expect(queriesFor('stripe_connections')).toHaveLength(0)
    expect(disconnected).not.toHaveBeenCalled()
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
