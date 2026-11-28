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

// The nightly runner's own gate; the sync never reads it.
vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/has-capability')>()
  return { ...actual, hasCapability: vi.fn().mockResolvedValue(true) }
})

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
import { failureNote, runWebshopOrderCron } from '@/lib/webshop-orders/order-cron'
import { CAPABILITY } from '@/lib/entitlements/keys'

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

// 2026-07-07T12:00:00Z
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

interface ListParams {
  created: { gte: number; lt?: number }
  limit: number
  starting_after?: string
}

/**
 * Stripe's balance-transaction list over a fixed history: the transactions
 * created in the window, newest first, one page after `starting_after`.
 */
function listPage(sorted: BalanceTxnLike[], params: ListParams) {
  const { gte, lt = Number.POSITIVE_INFINITY } = params.created
  const inWindow = sorted.filter((t) => t.created >= gte && t.created < lt)
  const start = params.starting_after ? inWindow.findIndex((t) => t.id === params.starting_after) + 1 : 0
  const data = inWindow.slice(start, start + params.limit)
  return { data, has_more: start + data.length < inWindow.length }
}

function newestFirst(history: BalanceTxnLike[]): BalanceTxnLike[] {
  return [...history].sort((a, b) => b.created - a.created || (a.id < b.id ? 1 : -1))
}

function stubList(history: BalanceTxnLike[], onPage?: (params: ListParams) => void) {
  const sorted = newestFirst(history)
  balanceTransactionsList.mockImplementation(async (params: ListParams) => {
    onPage?.(params)
    return listPage(sorted, params)
  })
}

/** The windows listed, in order: each window's first page. */
function listWindows(): Array<{ gte: number; lt: number | undefined }> {
  return balanceTransactionsList.mock.calls
    .map((call) => call[0] as ListParams)
    .filter((params) => !params.starting_after)
    .map((params) => ({ gte: params.created.gte, lt: params.created.lt }))
}

/** `count` SEK charges without a fee, spread evenly over [fromSec, toSec). */
function charges(count: number, fromSec: number, toSec: number, prefix: string): BalanceTxnLike[] {
  const step = (toSec - fromSec) / count
  return Array.from({ length: count }, (_, i) =>
    makeCharge({ id: `${prefix}_${i}`, created: fromSec + Math.floor(i * step), fee: 0 }),
  )
}

/**
 * ingestTransactions over the (company_id, external_id) unique index: a row
 * whose id is already stored is a duplicate. Returns the stored ids.
 */
function stubIngestDedup(): Set<string> {
  const stored = new Set<string>()
  vi.mocked(ingestTransactions).mockImplementation(async (_s, _c, _u, rows) => {
    let imported = 0
    let duplicates = 0
    for (const { external_id } of rows as Array<{ external_id: string }>) {
      if (stored.has(external_id)) duplicates += 1
      else {
        stored.add(external_id)
        imported += 1
      }
    }
    return {
      imported, duplicates, reconciled: 0, auto_categorized: 0,
      auto_matched_invoices: 0, errors: 0, transaction_ids: [],
    } as never
  })
  return stored
}

/** The external ids handed to each ingest call, fee rows left out. */
function ingestedIds(): string[][] {
  return vi.mocked(ingestTransactions).mock.calls.map((call) =>
    (call[3] as Array<{ external_id: string }>).map((r) => r.external_id).filter((id) => !id.endsWith('_fee')),
  )
}

const iso = (sec: number) => new Date(sec * 1000).toISOString()
const DAY = 86_400

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
        'order', 'limit', 'range', 'gte', 'lte', 'maybeSingle', 'single',
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
  /** Every cursor value written, in order. */
  const cursorWrites = () =>
    queriesFor('stripe_connections')
      .map((q) => (op(q, 'update')?.args[0] as { last_balance_txn_synced_at?: string } | undefined)?.last_balance_txn_synced_at)
      .filter((value): value is string => typeof value === 'string')
  return { supabase: supabase as unknown as SupabaseClient, queries, queriesFor, op, cursorWrites }
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
  // A run lists several windows: no test may fall through to another test's list.
  balanceTransactionsList.mockReset()
  stubList([])
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

  it("keeps the buyer's billing address country and card country apart on the sale row, and on no other row", () => {
    const rows = mapBalanceTransaction(
      'acct_1',
      makeCharge({
        source: {
          id: 'ch_1',
          object: 'charge',
          billing_details: { name: 'Anna Andersson', address: { country: 'se' } },
          payment_method_details: { type: 'card', card: { country: 'US' } },
        } as unknown as BalanceTxnLike['source'],
      }),
    )
    expect(rows[0]).toMatchObject({ billing_country: 'SE', card_country: 'US' })
    // The fee is Stripe's own: no buyer.
    expect(rows[1]).not.toHaveProperty('billing_country')
    expect(rows[1]).not.toHaveProperty('card_country')
    // A payout has no buyer either.
    expect(mapBalanceTransaction('acct_1', makePayoutTxn())[0]).toMatchObject({ billing_country: null, card_country: null })
  })

  it('leaves a country empty when Stripe states none, or none in ISO form', () => {
    const rows = mapBalanceTransaction(
      'acct_1',
      makeCharge({
        source: {
          id: 'ch_1',
          object: 'charge',
          billing_details: { name: 'Anna Andersson', address: { country: null } },
          payment_method_details: { type: 'card', card: { country: 'USA' } },
        } as unknown as BalanceTxnLike['source'],
      }),
    )
    expect(rows[0]).toMatchObject({ billing_country: null, card_country: null })
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
        // 1 500 more of those: more than one window holds, so a window that
        // could be halved would be.
        ...charges(1_500, LAST_PAYOUT - 31 * day, LAST_PAYOUT - 8 * day, 'txn_paid_early'),
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
      // The sweep is one window up to the connection moment, never halved:
      // it reaches back far enough for a charge held up to the longest
      // payout delay. The feed goes on from the connection moment.
      expect(listWindows()).toEqual([
        { gte: LAST_PAYOUT - 31 * day, lt: TICKET_SEC },
        { gte: TICKET_SEC, lt: Math.floor(Date.now() / 1000) },
      ])
      // It keeps what it always kept, the sweep's rows first.
      expect(ingestedIds()).toEqual([
        ['stripe_acct_1_txn_pending', 'stripe_acct_1_txn_night'],
        ['stripe_acct_1_txn_after'],
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

    // Later run: the cursor has advanced past it, so the one-time setup stops
    // although the run imports the charge again.
    await syncStripeBalanceTransactions(createCaptureSupabase().supabase, {
      ...CONNECTION,
      last_balance_txn_synced_at: '2026-07-05T00:00:00.000Z',
    })
    expect(vi.mocked(ingestTransactions)).toHaveBeenCalledTimes(2)
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
      stubList([makeCharge({ id: 'txn_eur_1', currency: 'eur', created: CREATED + 4 * DAY })])
      const { supabase, cursorWrites } = createCaptureSupabase({
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
      expect(Date.parse(cursorWrites().at(-1)!)).toBe(Math.floor(Date.now() / 1000) * 1000)
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

  it('moves the cursor on to the run start once its windows are listed to the end', async () => {
    stubList([makeCharge()])
    const { supabase, queriesFor, op, cursorWrites } = createCaptureSupabase({
      company_settings: [{ data: null, error: null }],
    })

    await syncStripeBalanceTransactions(supabase, { ...CONNECTION })

    const [chunk] = queriesFor('stripe_connections')
    expect(op(chunk, 'update')!.args[0]).toEqual({ last_balance_txn_synced_at: new Date(CREATED * 1000).toISOString(), error_message: null })
    // Then the end of each window after it, the last one ending at the run start.
    expect(cursorWrites()).toEqual([
      new Date(CREATED * 1000).toISOString(),
      '2026-07-08T00:00:00.000Z',
      '2026-07-22T00:00:00.000Z',
      '2026-07-23T10:00:00.000Z',
    ])
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

  it('moves a quiet account\'s cursor window by window to the run start on a later run', async () => {
    // Otherwise it keeps the front of the cron's oldest-cursor-first list.
    stubList([])
    const { supabase, cursorWrites } = createCaptureSupabase()

    const summary = await syncStripeBalanceTransactions(supabase, { ...CONNECTION, last_balance_txn_synced_at: '2026-07-10T00:00:00.000Z' })

    // The 24h overlap from 9 July as one window, then from the cursor a week,
    // then the rest to the run start.
    const sec = (at: string) => Math.floor(Date.parse(at) / 1000)
    expect(listWindows()).toEqual([
      { gte: sec('2026-07-09T00:00:00Z'), lt: sec('2026-07-10T00:00:00Z') },
      { gte: sec('2026-07-10T00:00:00Z'), lt: sec('2026-07-17T00:00:00Z') },
      { gte: sec('2026-07-17T00:00:00Z'), lt: sec('2026-07-23T10:00:00Z') },
    ])
    expect(cursorWrites()).toEqual(['2026-07-17T00:00:00.000Z', '2026-07-23T10:00:00.000Z'])
    expect(vi.mocked(ingestTransactions)).not.toHaveBeenCalled()
    expect(summary).toMatchObject({ fetched: 0 })
    expect(summary.deadlineReached).toBeUndefined()
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

  describe('listing in bounded windows, oldest first (accounted#209)', () => {
    // A later run: the cursor is a day past the connection moment, so the
    // run reads from 1 July (the 24h overlap) to the run start.
    const LATER = { last_balance_txn_synced_at: '2026-07-02T00:00:00.000Z' }
    const FROM = Math.floor(Date.parse('2026-07-01T00:00:00Z') / 1000)
    const NOW = Math.floor(Date.parse('2026-07-23T10:00:00Z') / 1000)

    it('ingests window by window, oldest first, moving the cursor to each window\'s end before the next', async () => {
      const { supabase, cursorWrites } = createCaptureSupabase()
      const cursorWhenListed: Array<string | undefined> = []
      stubList(
        [
          makeCharge({ id: 'txn_e', created: FROM + 22 * DAY + 3600, fee: 0 }),
          makeCharge({ id: 'txn_c', created: FROM + 9 * DAY, fee: 0 }),
          makeCharge({ id: 'txn_a', created: FROM + 12 * 3600, fee: 0 }),
          makeCharge({ id: 'txn_d', created: FROM + 15 * DAY, fee: 0 }),
          makeCharge({ id: 'txn_b', created: FROM + 3 * DAY, fee: 0 }),
        ],
        () => cursorWhenListed.push(cursorWrites().at(-1)),
      )

      const summary = await syncStripeBalanceTransactions(supabase, { ...CONNECTION, ...LATER })

      // The 24h overlap as one window; from the cursor bounded windows: a
      // week, twice that after a light one, then the rest up to the run start.
      expect(listWindows()).toEqual([
        { gte: FROM, lt: FROM + DAY },
        { gte: FROM + DAY, lt: FROM + 8 * DAY },
        { gte: FROM + 8 * DAY, lt: FROM + 22 * DAY },
        { gte: FROM + 22 * DAY, lt: NOW },
      ])
      expect(ingestedIds()).toEqual([
        ['stripe_acct_1_txn_a'],
        ['stripe_acct_1_txn_b'],
        ['stripe_acct_1_txn_c', 'stripe_acct_1_txn_d'],
        ['stripe_acct_1_txn_e'],
      ])
      // Each window is listed only once the one before is in and the cursor
      // stands at its end (the overlap ends where the cursor already stood).
      expect(cursorWhenListed).toEqual([undefined, undefined, iso(FROM + 8 * DAY), iso(FROM + 22 * DAY)])
      expect(cursorWrites().at(-1)).toBe(iso(NOW))
      expect(summary).toMatchObject({ fetched: 5 })
      expect(summary.deadlineReached).toBeUndefined()
    })

    it('resumes a window cut mid-listing on the next run: nothing lost, nothing skipped', async () => {
      // After the overlap (one page) and the cursor's first week (one page),
      // 250 transactions in the next window: three pages. Each page takes
      // 25 s and the run has 60 s, so the cut comes inside that window.
      const history = [
        makeCharge({ id: 'txn_w1_a', created: FROM + DAY + 3600, fee: 0 }),
        // Inside the next run's 24h overlap: read twice, stored once.
        makeCharge({ id: 'txn_w1_b', created: FROM + 7 * DAY + 12 * 3600, fee: 0 }),
        ...charges(250, FROM + 9 * DAY, FROM + 12 * DAY, 'txn_w2'),
        makeCharge({ id: 'txn_w3', created: FROM + 22 * DAY, fee: 0 }),
      ]
      const stored = stubIngestDedup()
      const deadlineMs = Date.now() + 60_000
      stubList(history, () => vi.setSystemTime(Date.now() + 25_000))
      const first = createCaptureSupabase()

      const cut = await syncStripeBalanceTransactions(first.supabase, { ...CONNECTION, ...LATER }, undefined, deadlineMs)

      // A pause, not a failure: the first window is in and the cursor at its
      // end, the window in flight is not.
      expect(cut.deadlineReached).toBe(true)
      expect([...stored]).toEqual(['stripe_acct_1_txn_w1_a', 'stripe_acct_1_txn_w1_b'])
      expect(first.cursorWrites().at(-1)).toBe(iso(FROM + 8 * DAY))

      // The next run (the button: no deadline) goes on from that cursor.
      vi.mocked(ingestTransactions).mockClear()
      balanceTransactionsList.mockClear()
      stubList(history)
      const second = createCaptureSupabase()
      const resumed = await syncStripeBalanceTransactions(second.supabase, {
        ...CONNECTION,
        last_balance_txn_synced_at: first.cursorWrites().at(-1)!,
      })

      expect(listWindows()[0]).toEqual({ gte: FROM + 7 * DAY, lt: FROM + 8 * DAY })
      expect(resumed).toMatchObject({ imported: 251, duplicates: 1 })
      expect([...stored].sort()).toEqual(history.map((t) => stripeExternalId('acct_1', t.id)).sort())
      expect(resumed.deadlineReached).toBeUndefined()
    })

    it('imports a history larger than one run over several runs, oldest first, losing nothing', async () => {
      // 12 000 transactions in 60 days: more than one run reads (10 000), and
      // a week holds more than one window may, so the windows halve too.
      const START = Math.floor(Date.parse('2026-05-01T00:00:00Z') / 1000)
      const history = charges(12_000, START, START + 60 * DAY, 'txn')
      const connection = {
        ...CONNECTION,
        connected_at: '2026-05-01T00:00:00.000Z',
        last_balance_txn_synced_at: '2026-05-02T00:00:00.000Z',
      }
      const stored = stubIngestDedup()
      stubList(history)
      const first = createCaptureSupabase()
      const run1 = await syncStripeBalanceTransactions(first.supabase, connection)
      const storedByRun1 = [...stored]
      const windowsOfRun1 = listWindows()
      const cursor1 = first.cursorWrites().at(-1)!
      // The next run goes on from the cursor.
      const second = createCaptureSupabase()
      const run2 = await syncStripeBalanceTransactions(second.supabase, { ...connection, last_balance_txn_synced_at: cursor1 })

      // Every transaction is in after the two runs.
      expect(stored.size).toBe(12_000)
      expect(run2.deadlineReached).toBeUndefined()
      expect(second.cursorWrites().at(-1)).toBe(iso(NOW))
      // The first run stopped at its bound with the oldest part in, and said
      // so; its cursor stands right after that part.
      expect(run1.deadlineReached).toBe(true)
      expect(storedByRun1.length).toBeLessThanOrEqual(10_000)
      expect(storedByRun1.length).toBeGreaterThan(8_000)
      expect(storedByRun1).toEqual(history.slice(0, storedByRun1.length).map((t) => stripeExternalId('acct_1', t.id)))
      expect(Date.parse(cursor1)).toBeGreaterThan(history[storedByRun1.length - 1].created * 1000)
      expect(Date.parse(cursor1)).toBeLessThanOrEqual(history[storedByRun1.length].created * 1000)
      // After the overlap (one window), the cursor's first week held too many.
      // Its listed part (the newest 1 000) began two days in: the next window
      // ends there, and that second is read whole.
      expect(windowsOfRun1.slice(0, 4)).toEqual([
        { gte: START, lt: START + DAY },
        { gte: START + DAY, lt: START + 8 * DAY },
        { gte: START + DAY, lt: START + 3 * DAY },
        { gte: START + 3 * DAY, lt: START + 3 * DAY + 1 },
      ])
    })

    it('reruns the same window without a duplicate row', async () => {
      // The cron's run and then the button from the same cursor: the same
      // windows, the same stable ids, and the second import stores nothing.
      const history = [
        makeCharge({ id: 'txn_a', created: FROM + 2 * DAY }),
        // Two refunds of the same amount on the same day, in different windows.
        { id: 'txn_r1', type: 'refund', amount: -20_000, fee: 0, currency: 'sek', created: FROM + 8 * DAY - 60 },
        { id: 'txn_r2', type: 'refund', amount: -20_000, fee: 0, currency: 'sek', created: FROM + 8 * DAY + 60 },
        makePayoutTxn({ id: 'txn_po', created: FROM + 15 * DAY }),
      ] as BalanceTxnLike[]
      const stored = stubIngestDedup()
      stubList(history)

      const first = await syncStripeBalanceTransactions(createCaptureSupabase().supabase, { ...CONNECTION, ...LATER })
      const firstWindows = listWindows()
      const firstIds = ingestedIds()
      balanceTransactionsList.mockClear()
      vi.mocked(ingestTransactions).mockClear()
      const again = await syncStripeBalanceTransactions(createCaptureSupabase().supabase, { ...CONNECTION, ...LATER })

      expect(firstWindows).toEqual([
        { gte: FROM, lt: FROM + DAY },
        { gte: FROM + DAY, lt: FROM + 8 * DAY },
        { gte: FROM + 8 * DAY, lt: FROM + 22 * DAY },
        { gte: FROM + 22 * DAY, lt: NOW },
      ])
      expect(listWindows()).toEqual(firstWindows)
      expect(ingestedIds()).toEqual(firstIds)
      // Five rows: the charge and its fee, both refunds, the payout.
      expect(first).toMatchObject({ imported: 5, duplicates: 0 })
      expect(again).toMatchObject({ imported: 0, duplicates: 5 })
      expect(stored.size).toBe(5)
    })

    it('stops between pages at the deadline: nothing of the window ingested, the cursor stays, the next run lists it again', async () => {
      // The listed pages are the newest part of the window. Ingesting them and
      // moving the cursor would skip the older transactions for good. The
      // nightly run's end, before this connection's share: a pause.
      const deadlineMs = Date.now() + 30_000
      stubList(charges(150, FROM + 6 * 3600, FROM + 18 * 3600, 'txn'), () => vi.setSystemTime(deadlineMs + 1))
      const { supabase, queriesFor } = createCaptureSupabase({ company_settings: [{ data: null, error: null }] })

      const summary = await syncStripeBalanceTransactions(
        supabase, { ...CONNECTION, ...LATER }, undefined, deadlineMs, { fairShare: true },
      )

      expect(summary).toMatchObject({ deadlineReached: true, fetched: 0, imported: 0 })
      expect(balanceTransactionsList).toHaveBeenCalledTimes(1)
      // Under a deadline each page is bounded, so the last one ends inside the route's limit.
      expect(balanceTransactionsList.mock.calls[0][1]).toEqual({ stripeAccount: 'acct_1', timeout: 25_000, maxNetworkRetries: 1 })
      expect(vi.mocked(ingestTransactions)).not.toHaveBeenCalled()
      expect(queriesFor('stripe_connections')).toHaveLength(0)
    })

    it('asks for the next page after the last id, and ingests all pages', async () => {
      const history = charges(150, FROM + DAY, FROM + 2 * DAY, 'txn')
      stubList(history)
      const { supabase } = createCaptureSupabase()

      const summary = await syncStripeBalanceTransactions(supabase, { ...CONNECTION, ...LATER })

      expect(summary.fetched).toBe(150)
      const firstPage = balanceTransactionsList.mock.calls[0]
      const secondPage = balanceTransactionsList.mock.calls.find((call) => (call[0] as ListParams).starting_after)!
      expect(firstPage[0]).not.toHaveProperty('starting_after')
      expect(secondPage[0]).toMatchObject({
        created: { gte: FROM + DAY, lt: FROM + 8 * DAY },
        starting_after: newestFirst(history)[99].id,
        limit: 100,
      })
      // No deadline (the button): the client's own timeout and retries.
      expect(firstPage[1]).toEqual({ stripeAccount: 'acct_1' })
    })

    it('fails, for us and on the connection, when the window before the feed start holds more than a run reads', async () => {
      // That window cannot be halved (the cursor cannot record progress
      // behind its seeded start), so no run would get through it: an error,
      // not a pause, and no cursor moves.
      const TICKET = { connected_at: '2026-07-20T12:00:00.000Z', last_balance_txn_synced_at: '2026-07-20T12:00:00.000Z' }
      const START_SEC = Math.floor(Date.parse(TICKET.connected_at) / 1000)
      stubList(charges(10_050, START_SEC - 80 * DAY, START_SEC - DAY, 'txn_old'))
      const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }
      const { supabase, queriesFor } = createCaptureSupabase()

      const thrown = await syncStripeBalanceTransactions(
        supabase, { ...CONNECTION, ...TICKET }, log as never, Date.now() + 240_000,
      ).catch((err: unknown) => err)

      expect(thrown).toBeInstanceOf(Error)
      expect((thrown as Error).message).toBe(STRIPE_HISTORY_TOO_LARGE_MESSAGE)
      // Empty 1686 and no payout: the 90-day sweep, as one window, given up
      // at its page cap without asking for more.
      expect(listWindows()).toEqual([{ gte: START_SEC - 90 * DAY, lt: START_SEC }])
      expect(balanceTransactionsList).toHaveBeenCalledTimes(100)
      expect(vi.mocked(ingestTransactions)).not.toHaveBeenCalled()
      expect(queriesFor('stripe_connections')).toHaveLength(0)
      expect(log.error).toHaveBeenCalledWith(
        'stripe balance-transaction window that cannot be split holds more than one run reads',
        expect.objectContaining({ connectionId: 'conn-1', companyId: 'company-1', listed: 10_000 }),
      )
      // What the runner then stores on the connection promises no retry.
      expect(failureNote('Stripe Connect', thrown)).toBe(
        'Den senaste automatiska hämtningen från Stripe Connect misslyckades. Historiken hos Stripe är för stor för att hämtas automatiskt. Supporten har fått veta det.',
      )
    })
  })

  describe('no silent stall: shares, dense days and paused backfills (accounted#209 review)', () => {
    const sec = (at: string) => Math.floor(Date.parse(at) / 1000)
    const mkLog = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() })
    // A first run three days after connecting, with an empty 1686: the sweep.
    const TICKET = { connected_at: '2026-07-20T12:00:00.000Z', last_balance_txn_synced_at: '2026-07-20T12:00:00.000Z' }
    const T = sec(TICKET.connected_at)
    /** The cron route's spec, with the real sync behind it. */
    const cronSpec = {
      extensionId: 'stripe',
      label: 'Stripe Connect',
      table: 'stripe_connections',
      cursorColumn: 'last_balance_txn_synced_at',
      capability: CAPABILITY.stripe_payments,
      isConfigured: () => true,
      sync: async (s: SupabaseClient, c: StripeConnection, l: never, d: number) => {
        const summary = await syncStripeBalanceTransactions(s, c, l, d, { fairShare: true })
        return { inserted: summary.imported, updated: 0, errors: summary.errors, deadlineReached: summary.deadlineReached, revoked: summary.revoked }
      },
    }

    beforeEach(() => {
      vi.setSystemTime(new Date('2026-07-23T03:00:00.000Z'))
    })

    it('fails at its own share, loudly, when a first run cannot get past its sweep', async () => {
      // 9 000 balance transactions in the sweep at 3 s a page: 270 s, more
      // than any run gives one connection. A pause would keep it first in the
      // cron's order and hand it every night's run.
      stubList(charges(9_000, T - 80 * DAY, T - DAY, 'sweep'), () => vi.setSystemTime(Date.now() + 3_000))
      const log = mkLog()
      const { supabase, cursorWrites } = createCaptureSupabase()
      const runStart = Date.now()

      const thrown = await syncStripeBalanceTransactions(
        supabase, { ...CONNECTION, ...TICKET }, log as never, runStart + 240_000, { fairShare: true },
      ).catch((err: unknown) => err)

      expect((thrown as Error).message).toBe(STRIPE_HISTORY_TOO_LARGE_MESSAGE)
      // At its share, half the run, not the run's end.
      expect(Date.now() - runStart).toBeLessThanOrEqual(123_000)
      expect(log.error).toHaveBeenCalledWith(
        'stripe balance-transaction sync does not fit its share of the run',
        expect.objectContaining({ connectionId: 'conn-1', shareMs: 120_000 }),
      )
      expect(cursorWrites()).toEqual([])
      expect(vi.mocked(ingestTransactions)).not.toHaveBeenCalled()
    })

    it('pauses at its share once past its cursor, leaving the rest of the run to the others', async () => {
      // 30 000 transactions a month behind, 3 s a page: it gets on, and stops
      // at its share rather than at the run's end.
      stubIngestDedup()
      stubList(charges(30_000, sec('2026-06-23T00:00:00Z'), sec('2026-07-23T00:00:00Z'), 'old'), () => vi.setSystemTime(Date.now() + 3_000))
      const { supabase, cursorWrites } = createCaptureSupabase()
      const runStart = Date.now()

      const summary = await syncStripeBalanceTransactions(
        supabase, { ...CONNECTION, connected_at: '2026-06-01T00:00:00.000Z', last_balance_txn_synced_at: '2026-06-23T00:00:00.000Z' },
        mkLog() as never, runStart + 240_000, { fairShare: true },
      )

      expect(summary.deadlineReached).toBe(true)
      expect(Date.now() - runStart).toBeLessThanOrEqual(123_000)
      expect(Date.parse(cursorWrites().at(-1)!)).toBeGreaterThan(Date.parse('2026-06-23T00:00:00Z'))
    })

    it('in the nightly runner: an error and a status for the connection that does not fit, and a sync for the one behind it', async () => {
      const A = { ...CONNECTION, ...TICKET, id: 'conn-a', stripe_account_id: 'acct_a' }
      const B = { ...CONNECTION, id: 'conn-b', company_id: 'company-b', stripe_account_id: 'acct_b', last_balance_txn_synced_at: '2026-07-22T03:00:00.000Z' }
      const sweepA = newestFirst(charges(9_000, T - 80 * DAY, T - DAY, 'sweep'))
      const historyB = newestFirst([makeCharge({ id: 'txn_b', created: sec('2026-07-22T12:00:00Z') })])
      balanceTransactionsList.mockImplementation(async (params: ListParams, options: { stripeAccount: string }) => {
        vi.setSystemTime(Date.now() + 3_000)
        return listPage(options.stripeAccount === 'acct_a' ? sweepA : historyB, params)
      })
      const { supabase, queriesFor, op } = createCaptureSupabase({ stripe_connections: [{ data: [A, B], error: null }] })
      const log = mkLog()

      const res = await runWebshopOrderCron({ requestId: 'req-1', log: log as never, supabase }, cronSpec as never)
      const body = await res.json()

      expect(body.results.map((r: { connectionId: string; status: string }) => [r.connectionId, r.status])).toEqual([
        ['conn-a', 'error'],
        ['conn-b', 'synced'],
      ])
      // The alert, and the status the panel shows under connection A.
      expect(log.error).toHaveBeenCalledWith(
        'stripe order sync failed for connection', expect.any(Error), expect.objectContaining({ connectionId: 'conn-a' }),
      )
      const noteOnA = queriesFor('stripe_connections').find(
        (q) => op(q, 'eq')?.args[1] === 'conn-a' && typeof (op(q, 'update')?.args[0] as { error_message?: unknown })?.error_message === 'string',
      )
      expect((op(noteOnA!, 'update')!.args[0] as { error_message: string }).error_message).toBe(
        'Den senaste automatiska hämtningen från Stripe Connect misslyckades. Historiken hos Stripe är för stor för att hämtas automatiskt. Supporten har fått veta det.',
      )
      // Connection B got its turn in the same run, and its cursor moved.
      const cursorOfB = queriesFor('stripe_connections').filter(
        (q) => op(q, 'eq')?.args[1] === 'conn-b' && (op(q, 'update')?.args[0] as { last_balance_txn_synced_at?: string })?.last_balance_txn_synced_at,
      )
      expect(cursorOfB.length).toBeGreaterThan(0)
    })

    it('does not count the 24h overlap against the run bound: a dense day before the cursor still lets the new rows in', async () => {
      vi.setSystemTime(new Date('2026-07-23T10:00:00.000Z'))
      const C = sec('2026-07-22T00:00:00Z')
      const old = charges(9_800, C - DAY, C, 'old')
      const fresh = charges(100, C, sec('2026-07-23T09:00:00Z'), 'new')
      const stored = stubIngestDedup()
      for (const txn of old) stored.add(stripeExternalId('acct_1', txn.id))
      stubList([...old, ...fresh])
      const { supabase, cursorWrites } = createCaptureSupabase()

      const summary = await syncStripeBalanceTransactions(supabase, { ...CONNECTION, last_balance_txn_synced_at: iso(C) })

      expect(fresh.filter((txn) => !stored.has(stripeExternalId('acct_1', txn.id)))).toEqual([])
      expect(summary.imported).toBe(100)
      expect(summary.deadlineReached).toBeUndefined()
      expect(cursorWrites().at(-1)).toBe('2026-07-23T10:00:00.000Z')
    })

    it('lists a burst under the nightly deadline in one run, ending each window where the listed part began', async () => {
      // 1 500 payments in one minute on a quiet account, 2 s a page.
      const B = sec('2026-07-22T12:00:00Z')
      const burst = charges(1_500, B, B + 60, 'burst')
      const quiet = charges(20, sec('2026-07-15T00:00:00Z'), sec('2026-07-23T02:00:00Z'), 'quiet')
      const stored = stubIngestDedup()
      stubList([...burst, ...quiet], () => vi.setSystemTime(Date.now() + 2_000))
      const { supabase, cursorWrites } = createCaptureSupabase()
      const runStart = Date.now()

      const summary = await syncStripeBalanceTransactions(
        supabase, { ...CONNECTION, last_balance_txn_synced_at: '2026-07-22T03:00:00.000Z' }, mkLog() as never, runStart + 240_000,
        { fairShare: true },
      )

      expect(burst.filter((txn) => !stored.has(stripeExternalId('acct_1', txn.id)))).toEqual([])
      expect(summary.deadlineReached).toBeUndefined()
      expect(cursorWrites().at(-1)).toBe(new Date(runStart).toISOString())
      // Main lists it in 16 pages; halving blind took 120 a night and never got through.
      expect(balanceTransactionsList.mock.calls.length).toBeLessThanOrEqual(32)
    })

    it('reads a burst inside one second as a window of its own, whole, in few pages', async () => {
      vi.setSystemTime(new Date('2026-07-23T10:00:00.000Z'))
      const FROM = sec('2026-07-01T00:00:00Z')
      const B = FROM + 3 * DAY
      const burst = Array.from({ length: 2_500 }, (_, i) =>
        makeCharge({ id: `burst_${String(i).padStart(5, '0')}`, created: B, fee: 0 }),
      )
      const stored = stubIngestDedup()
      stubList([...burst, ...charges(50, FROM, FROM + 20 * DAY, 'other')])
      const { supabase } = createCaptureSupabase()

      await syncStripeBalanceTransactions(supabase, { ...CONNECTION, last_balance_txn_synced_at: '2026-07-02T00:00:00.000Z' })

      expect(stored.size).toBe(2_550)
      const ofTheSecond = balanceTransactionsList.mock.calls.filter(
        (call) => (call[0] as ListParams).created.gte === B && (call[0] as ListParams).created.lt === B + 1,
      )
      expect(ofTheSecond).toHaveLength(25)
      // Main lists it in 26 pages; halving blind took 399.
      expect(balanceTransactionsList.mock.calls.length).toBeLessThan(50)
    })

    it('resumes a backfill paused at the run bound from its cursor, not as a new start', async () => {
      // A backfill to 1 January for 300 payments a day, paid out daily at 03:00.
      vi.setSystemTime(new Date('2026-07-23T10:00:00.000Z'))
      const BACKFILL = '2025-12-31T23:00:00.000Z'
      const start = sec('2025-11-01T00:00:00Z')
      const history = charges(300 * 134, start, start + 134 * DAY, 'pay')
      payoutsList.mockImplementation(async (params: { created: { lt: number } }) => {
        const last = Math.floor((params.created.lt - 3 * 3600) / DAY) * DAY + 3 * 3600
        return { data: Array.from({ length: 100 }, (_, i) => ({ id: `po_${i}`, currency: 'sek', created: last - i * DAY })) }
      })
      stubIngestDedup()
      stubList(history)
      const connection = { ...CONNECTION, last_balance_txn_synced_at: BACKFILL }
      const first = createCaptureSupabase()

      const run1 = await syncStripeBalanceTransactions(first.supabase, connection)

      expect(run1.deadlineReached).toBe(true)
      // The start it read the open balance of is recorded once the cursor is past it.
      const feedStarts = first.queriesFor('stripe_connections')
        .map((q) => (first.op(q, 'update')?.args[0] as { balance_txn_feed_start?: string } | undefined)?.balance_txn_feed_start)
        .filter(Boolean)
      expect(feedStarts).toEqual([BACKFILL])
      const cursor1 = first.cursorWrites().at(-1)!
      expect(Date.parse(cursor1)).toBeLessThan(Date.parse(CONNECTION.connected_at!))

      vi.mocked(syncMappedAccounts).mockClear()
      payoutsList.mockClear()
      balanceTransactionsList.mockClear()
      await syncStripeBalanceTransactions(createCaptureSupabase().supabase, {
        ...connection,
        last_balance_txn_synced_at: cursor1,
        balance_txn_feed_start: feedStarts[0],
      })

      // A later run: from its cursor less the overlap, no new sweep, no new setup.
      expect(listWindows()[0].gte).toBe(Date.parse(cursor1) / 1000 - DAY)
      expect(payoutsList).not.toHaveBeenCalled()
      expect(vi.mocked(syncMappedAccounts)).not.toHaveBeenCalled()
    })

    it('lists no payouts once the deadline has passed, and bounds the call under a live one', async () => {
      const passed = await syncStripeBalanceTransactions(
        createCaptureSupabase().supabase, { ...CONNECTION, ...TICKET }, undefined, Date.now() - 1,
      )
      expect(passed.deadlineReached).toBe(true)
      expect(payoutsList).not.toHaveBeenCalled()
      expect(balanceTransactionsList).not.toHaveBeenCalled()

      await syncStripeBalanceTransactions(createCaptureSupabase().supabase, { ...CONNECTION, ...TICKET }, undefined, Date.now() + 240_000)
      expect(payoutsList).toHaveBeenCalledWith(
        { created: { lt: T }, limit: 100 },
        { stripeAccount: 'acct_1', timeout: 25_000, maxNetworkRetries: 1 },
      )
    })

    it('reads the 24h overlap as one window, so a billing run the night before does not hold the feed up', async () => {
      // 200 payments a day, and a billing run of 4 000 in one hour that
      // tonight's 24h overlap reads again, at 2 s a page: 44 pages, 88 s.
      const C = sec('2026-07-22T03:00:00Z')
      const day = charges(400, C - DAY, C + DAY - 3600, 'day')
      const billing = charges(4_000, C - 15 * 3600, C - 14 * 3600, 'bill')
      const stored = stubIngestDedup()
      for (const txn of [...day, ...billing]) if (txn.created < C) stored.add(stripeExternalId('acct_1', txn.id))
      stubList([...day, ...billing], () => vi.setSystemTime(Date.now() + 2_000))
      const { supabase, cursorWrites } = createCaptureSupabase()
      const runStart = Date.now()

      const summary = await syncStripeBalanceTransactions(
        supabase, { ...CONNECTION, last_balance_txn_synced_at: iso(C) }, mkLog() as never, runStart + 240_000, { fairShare: true },
      )

      // Caught up in one run, as main is.
      expect(summary.deadlineReached).toBeUndefined()
      expect(cursorWrites().at(-1)).toBe(new Date(runStart).toISOString())
      expect(day.filter((txn) => !stored.has(stripeExternalId('acct_1', txn.id)))).toEqual([])
      // The overlap in one window, as main reads it; then the day since the cursor.
      expect(listWindows()[0]).toEqual({ gte: C - DAY, lt: C })
    })

    it('re-reads an overlap larger than one window only in part, and goes on from the cursor', async () => {
      // 10 500 payments in the day before the cursor, 300 a day after it, at
      // 1 s a page. Main imports the new ones; failing on a re-read of what the
      // cursor has passed would stop the feed for good.
      const C = sec('2026-07-22T00:00:00Z')
      const old = charges(10_500, C - DAY + 3600, C - 3 * 3600, 'old')
      const fresh = charges(600, C, C + 2 * DAY, 'new')
      const stored = stubIngestDedup()
      for (const txn of old) stored.add(stripeExternalId('acct_1', txn.id))
      stubList([...old, ...fresh], () => vi.setSystemTime(Date.now() + 1_000))
      const log = mkLog()
      const { supabase, cursorWrites } = createCaptureSupabase()
      const runStart = Date.now()

      const summary = await syncStripeBalanceTransactions(
        supabase, { ...CONNECTION, last_balance_txn_synced_at: iso(C) }, log as never, runStart + 240_000, { fairShare: true },
      )

      const visible = fresh.filter((txn) => txn.created * 1000 < runStart)
      expect(visible.filter((txn) => !stored.has(stripeExternalId('acct_1', txn.id)))).toEqual([])
      expect(summary.deadlineReached).toBeUndefined()
      expect(cursorWrites().at(-1)).toBe(new Date(runStart).toISOString())
      expect(log.error).not.toHaveBeenCalled()
      expect(log.warn).toHaveBeenCalledWith(
        'stripe balance-transaction overlap too large to re-read whole; its older part is skipped',
        expect.objectContaining({ connectionId: 'conn-1' }),
      )
    })

    it('fails at its share when a first run gets nowhere before its first row, instead of pausing every night', async () => {
      // A backfill whose months after the start are empty, then one second
      // holding 9 000 payments: at 2 s a page that second takes 180 s. Before
      // its first row a first run's cursor cannot move, so a pause would come
      // back every night with nothing to show.
      const X = sec('2026-06-01T10:00:00Z')
      stubList(
        Array.from({ length: 9_000 }, (_, i) => makeCharge({ id: `x_${String(i).padStart(5, '0')}`, created: X, fee: 0 })),
        () => vi.setSystemTime(Date.now() + 2_000),
      )
      const log = mkLog()
      const { supabase, cursorWrites } = createCaptureSupabase()
      const runStart = Date.now()

      const thrown = await syncStripeBalanceTransactions(
        supabase, { ...CONNECTION, last_balance_txn_synced_at: '2025-12-31T23:00:00.000Z' }, log as never,
        runStart + 240_000, { fairShare: true },
      ).catch((err: unknown) => err)

      expect((thrown as Error).message).toBe(STRIPE_HISTORY_TOO_LARGE_MESSAGE)
      expect(log.error).toHaveBeenCalledTimes(1)
      expect(Date.now() - runStart).toBeLessThanOrEqual(122_000)
      expect(cursorWrites()).toEqual([])
    })

    it('gives "Synka nu" and a backfill their whole budget: a sweep main reads in 140 s is not cut at 120 s', async () => {
      // The share is the nightly runner's, where other connections wait.
      stubIngestDedup()
      stubList(charges(7_000, T - 80 * DAY, T - DAY, 'sweep'), () => vi.setSystemTime(Date.now() + 2_000))
      const runStart = Date.now()

      const summary = await syncStripeBalanceTransactions(
        createCaptureSupabase().supabase, { ...CONNECTION, ...TICKET }, mkLog() as never, runStart + 240_000,
      )

      expect(summary.deadlineReached).toBeUndefined()
      expect(summary.fetched).toBe(7_000)
      expect(Date.now() - runStart).toBeGreaterThan(120_000)
    })

    describe('a feed that falls behind says so (2 000 a day at 3 s a page)', () => {
      /** One nightly run with the cursor `daysBehind` back and the row last written at `writtenAt`. */
      async function runBehind(daysBehind: number, writtenAt: string) {
        const now = Math.floor(Date.now() / 1000)
        const cursor = now - daysBehind * DAY
        stubIngestDedup()
        stubList(charges(2_000 * (daysBehind + 1), cursor - DAY, now, 'pay'), () => vi.setSystemTime(Date.now() + 3_000))
        const log = mkLog()
        const summary = await syncStripeBalanceTransactions(
          createCaptureSupabase().supabase,
          { ...CONNECTION, last_balance_txn_synced_at: iso(cursor), updated_at: writtenAt },
          log as never, Date.now() + 240_000, { fairShare: true },
        )
        expect(summary.deadlineReached).toBe(true)
        return log
      }

      it('warns past 48 hours behind', async () => {
        const log = await runBehind(3, '2026-07-22T03:00:00.000Z')
        expect(log.warn).toHaveBeenCalledWith('stripe balance-transaction feed is falling behind', expect.objectContaining({ connectionId: 'conn-1' }))
        expect(log.error).not.toHaveBeenCalled()
      })

      it('errs once, on the run that takes it past a week', async () => {
        // The previous run, a day ago, left it at most a week behind.
        const crossing = await runBehind(8, '2026-07-22T03:00:00.000Z')
        expect(crossing.error).toHaveBeenCalledTimes(1)
        expect(crossing.error).toHaveBeenCalledWith(
          'stripe balance-transaction feed has fallen more than a week behind', expect.objectContaining({ connectionId: 'conn-1' }),
        )
        // The run after it, already more than a week behind when it was last written: a warning only.
        vi.setSystemTime(new Date('2026-07-23T03:00:00.000Z'))
        const after = await runBehind(8, '2026-07-23T02:00:00.000Z')
        expect(after.error).not.toHaveBeenCalled()
        expect(after.warn).toHaveBeenCalledWith('stripe balance-transaction feed is falling behind', expect.anything())
      })

      it('errs on the crossing run also when the run before ended just under a week behind', async () => {
        // The run before measured its lag at its start; its last write came
        // 110 s later and already reads a little over a week. One run budget
        // of slack still counts that run as under the week.
        const log = await runBehind(8, '2026-07-22T03:01:50.000Z')
        expect(log.error).toHaveBeenCalledTimes(1)
      })

      it('reports no lag for a first run: a backfill pausing on its way catches up on the later runs', async () => {
        // A backfill to 1 June (before the connection moment, 1 July) of 4 000
        // a day: the run pauses at its share having moved less than a day.
        const cursor = sec('2026-06-01T00:00:00Z')
        stubIngestDedup()
        stubList(charges(40_000, cursor, cursor + 10 * DAY, 'pay'), () => vi.setSystemTime(Date.now() + 3_000))
        const log = mkLog()
        const summary = await syncStripeBalanceTransactions(
          createCaptureSupabase().supabase, { ...CONNECTION, last_balance_txn_synced_at: iso(cursor) },
          log as never, Date.now() + 240_000, { fairShare: true },
        )
        expect(summary.deadlineReached).toBe(true)
        expect(log.warn.mock.calls.filter((call) => String(call[0]).includes('behind'))).toEqual([])
        expect(log.error).not.toHaveBeenCalled()
      })
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
