import { chunk as chunked } from '@/lib/utils'
import type Stripe from 'stripe'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getStripe } from '@/lib/stripe/client'
import { ingestTransactions } from '@/lib/transactions/ingest'
import { ensureManualCashAccount } from '@/lib/cash-accounts/service'
import { syncMappedAccounts } from '@/lib/import/account-sync'
import {
  connectionStartMs,
  isBeforeFirstAdvance,
  resolveWindowStartMs,
  type CursorWindowConnection,
} from '@/lib/feed-sync/cursor-window'
import { addDaysIso, stockholmWallTimeToUtc, todayIsoStockholm } from '@/lib/dates/iso'
import { ISO_DATE_RE } from '@/lib/invariants'
import { sumAccountBalance } from '@/lib/reconciliation/gl-balance'
import { createLogger, type Logger } from '@/lib/logger'
import { roundOre } from '@/lib/money'
import type { RawTransaction, TransactionMethod } from '@/types'
import { connectedAccountOptions, isRevokedConnectionError } from './connect'
import { markConnectionRevokedUpstream } from './revoked'
import type { StripeConnection } from '../types'

const defaultLog = createLogger('stripe/transaction-sync')

/**
 * Stripe balance-transaction sync: the connected Stripe balance treated as a
 * bank feed.
 *
 * The Stripe balance becomes a cash account on ledger 1686 (Fordringar för
 * kontokort), and the account's balance transactions land in the transactions
 * inbox exactly like PSD2 bank rows: deduped on external_id, bound to the
 * cash account so booking settles against 1686, and categorized/booked by the
 * user through the normal flows. Nothing here auto-books.
 *
 * Row model (two-row gross+fee split): every balance transaction produces a
 * main row for its gross amount, plus a fee row (negative) when Stripe
 * deducted a fee. The feed then sums to Stripe's actual balance movements
 * (+gross -fee per charge, -net per payout), which is what makes the cash
 * account reconcile against the real Stripe balance.
 *
 * Cursor: stripe_connections.last_balance_txn_synced_at (max `created`
 * processed, or the run start once a window is listed to its end), re-polled
 * with a 24h overlap. Safe because balance transactions
 * are immutable and carry stable txn_... ids: a re-seen transaction collides
 * on (company_id, external_id) and is skipped. The OAuth callback seeds the
 * cursor with the connection moment; older history is an explicit choice
 * (POST /backfill moves the cursor back to the start of a Swedish day).
 * Every window is floored at the day after the company lock date: rows
 * behind the lock can never be booked and would only be permanent inbox
 * noise.
 *
 * Feed start (crm#1344): neither the connection moment nor a backfill day
 * may cut through the Stripe balance. Money Stripe paid out before the start
 * is in the bank and already booked from there; money still on the balance
 * is not, and the next payout carries it out against 1686. So the run from a
 * start reads that balance into the feed (planFetch) unless 1686 already
 * holds a balance in the ledger, in which case the books carry it and the
 * feed starts at Swedish midnight of the start day.
 *
 * Currency (accounted#58 P1.10): the cash account on 1686 is kept in SEK, and
 * a cash account has exactly one currency. A Stripe account can also hold
 * balances in other currencies; Stripe states each balance transaction in
 * the currency of its balance and gives no kronor value for it. Such a row
 * on the SEK account can never be booked (the bank-booking guards refuse a
 * row whose currency differs from its cash account's) and hides from the
 * account's views and reconciliation, so the feed leaves it out and counts
 * it in `foreignCurrency`.
 */

/** BAS ledger account for the Stripe balance cash account. */
export const STRIPE_LEDGER_ACCOUNT = '1686'
/** Currency of the Stripe balance cash account; see "Currency" above. */
const STRIPE_LEDGER_CURRENCY = 'SEK'
/** BAS 2026 name for 1686; used when creating the chart account. */
const STRIPE_LEDGER_ACCOUNT_NAME = 'Fordringar för kontokort och kuponger'
/** transactions.import_source for Stripe feed rows. */
export const STRIPE_IMPORT_SOURCE = 'stripe'
/** Cursor re-poll overlap; external_id dedup makes duplicates no-ops. */
const CURSOR_OVERLAP_SECONDS = 24 * 60 * 60
/** Balance transactions per ingest chunk (each maps to at most 2 rows). */
const INGEST_CHUNK_SIZE = 200
/** Hard cap per run; the cursor resumes where a truncated run stopped. */
const MAX_TXNS_PER_RUN = 10_000
/** Balance transactions per list call: Stripe's largest page. */
const LIST_PAGE_SIZE = 100
/**
 * The longest one connection's listing may take of the nightly run, counted
 * from its own start. A listing that runs out of it does not fit any night:
 * its cursor never moves, so it stays first in the cron's order, and without
 * a share of its own it used the whole run every night and left nothing for
 * the connections behind it. That is a failure, not a pause.
 */
const FAIR_LIST_BUDGET_MS = 120_000
/**
 * What the connection says when its history does not fit (the cron's runner
 * stores it after its lead sentence, lib/webshop-orders/order-cron.ts). No
 * later night gets through either, so it promises no retry: this is for us
 * to solve, and the error log is how we hear of it.
 */
export const STRIPE_HISTORY_TOO_LARGE_MESSAGE =
  'Historiken hos Stripe är för stor för att hämtas automatiskt. Supporten har fått veta det.'
/**
 * Bound on one list call under a deadline: 25 s and one retry, so a page
 * started at the last moment ends within the minute the cron's budget leaves
 * inside maxDuration. The client's defaults (80 s, two retries) allow four
 * minutes for one page.
 */
const DEADLINE_PAGE_OPTIONS = { timeout: 25_000, maxNetworkRetries: 1 } as const
/**
 * Longest time Stripe holds a charge before it can be paid out (a payout
 * schedule's delay_days stays within 30). A charge still on the balance when
 * the last payout before a feed start ran was created at most this long
 * before that payout.
 */
const MAX_PAYOUT_DELAY_SECONDS = 31 * 86_400
/**
 * How far back a feed start reads when the account had no payout before it:
 * then everything on it is still on the balance. Bounded so a dormant
 * account cannot ask for an unbounded scan.
 */
const NO_PAYOUT_LOOKBACK_SECONDS = 90 * 86_400
/** Payouts read to find the last one per currency before a feed start. */
const PAYOUT_PAGE_SIZE = 100

/**
 * ⚠️ STORED-KEY FORMATS. These are persisted to transactions.external_id and
 * dedup compares stored ids byte-for-byte, exactly like the Enable Banking
 * scheme in lib/transactions/external-id.ts. Changing either template
 * silently orphans every prior row and re-imports the whole feed on the next
 * sync. Locked by the frozen-format test in transaction-sync.test.ts; any
 * change MUST ship a coordinated backfill.
 */
export function stripeExternalId(stripeAccountId: string, balanceTxnId: string): string {
  return `stripe_${stripeAccountId}_${balanceTxnId}`
}

/** Fee-split row id for a balance transaction (see stripeExternalId). */
export function stripeFeeExternalId(stripeAccountId: string, balanceTxnId: string): string {
  return `stripe_${stripeAccountId}_${balanceTxnId}_fee`
}

export interface StripeTransactionSyncSummary {
  /** Balance transactions listed from Stripe. */
  fetched: number
  /** New inbox rows inserted. */
  imported: number
  /** Rows skipped by external_id / content dedup. */
  duplicates: number
  errors: number
  /** Processed balance transactions left out for not being in SEK. */
  foreignCurrency: number
  /** Set when the caller's time budget ran out before all chunks processed. */
  deadlineReached?: boolean
  /** Set when the connection turned out to be revoked upstream. */
  revoked?: boolean
}

/**
 * The Swedish calendar day of a Stripe timestamp. The verifikation carries
 * the date of the affärshändelse (BFL 5 kap 7 §), which for a Swedish
 * company is the Swedish day: a payment at 00:30 in Stockholm belongs to
 * that day, not to the UTC day before it (which can be another month or
 * fiscal year, and another daily samlingsverifikat).
 */
function isoDate(epochSeconds: number): string {
  return todayIsoStockholm(new Date(epochSeconds * 1000))
}

/** Midnight in Stockholm at the start of a Swedish calendar day (epoch ms). */
function stockholmDayStartMs(isoDay: string): number {
  return stockholmWallTimeToUtc(isoDay, '00:00').getTime()
}

/** Minimal shape shared by live Stripe objects and test fixtures. */
export type BalanceTxnLike = Pick<Stripe.BalanceTransaction, 'id' | 'type' | 'fee'> & {
  amount: number
  currency: string
  created: number
  /** When the funds become payable; live objects always carry it. */
  available_on?: number
  description?: string | null
  reporting_category?: string
  source?: Stripe.BalanceTransaction['source']
}

function sourceId(source: BalanceTxnLike['source']): string | null {
  if (!source) return null
  return typeof source === 'string' ? source : source.id
}

/** Expanded charge behind a charge/payment balance transaction, if present. */
function chargeOf(txn: BalanceTxnLike): Stripe.Charge | null {
  const source = txn.source
  if (!source || typeof source === 'string') return null
  return source.object === 'charge' ? (source as Stripe.Charge) : null
}

/**
 * Swedish-first display title per balance-transaction type. Deterministic
 * from immutable Stripe data (charges never change payer name after
 * creation), so the same transaction always derives the same description:
 * important because the content-dedup bridge keys off it.
 */
function describeBalanceTxn(txn: BalanceTxnLike): string {
  switch (txn.type) {
    case 'charge':
    case 'payment': {
      const charge = chargeOf(txn)
      const detail =
        charge?.billing_details?.name?.trim() ||
        charge?.description?.trim() ||
        sourceId(txn.source)
      return detail ? `Stripe-betalning ${detail}` : 'Stripe-betalning'
    }
    case 'refund':
    case 'payment_refund':
    case 'payment_failure_refund':
      return 'Stripe-återbetalning'
    case 'adjustment':
      // Disputes surface as adjustments; the reporting_category tells them apart.
      if (txn.reporting_category === 'dispute') return 'Stripe-tvist'
      return txn.description ? `Stripe-justering: ${txn.description}` : 'Stripe-justering'
    case 'payout':
      // Carries the po_ id so the row reads as the same event as the bank
      // deposit of that payout. Never reword: content dedup keys off it.
      return `Stripe-utbetalning ${sourceId(txn.source) ?? txn.id}`
    default:
      return txn.description ? `Stripe: ${txn.description}` : `Stripe ${txn.type}`
  }
}

/**
 * Payment rail per balance-transaction type: Stripe's `type` is a structured
 * discriminator, so the feed sets transaction_method explicitly instead of
 * letting the ingest boundary guess from the description string. Charges and
 * their refunds travel the card rail; payouts are transfers to the bank
 * account; Stripe's own billing/tax deductions are fees; disputes surface as
 * adjustments. Unknown types return null (unclassified).
 */
function methodForBalanceTxn(txn: BalanceTxnLike): TransactionMethod | null {
  // Widened to string: live Stripe sends types the SDK union doesn't model
  // (e.g. 'tax' for automatic-tax deductions).
  switch (txn.type as string) {
    case 'charge':
    case 'payment':
    case 'refund':
    case 'payment_refund':
    case 'payment_failure_refund':
      return 'card'
    case 'payout':
      return 'transfer'
    case 'stripe_fee':
    case 'stripe_fx_fee':
    case 'tax':
      return 'fee'
    case 'adjustment':
      return 'adjustment'
    default:
      return null
  }
}

/**
 * Map one balance transaction to its feed row(s): a main row for the gross
 * amount and, when Stripe deducted a fee, a separate negative fee row. Dates
 * use `created` (when the money moved: the economic event), NOT
 * `available_on` (Stripe's internal settlement schedule, days later): booked
 * entries, invoice matching, and month boundaries all want the payment date.
 */
export function mapBalanceTransaction(
  stripeAccountId: string,
  txn: BalanceTxnLike,
): RawTransaction[] {
  const date = isoDate(txn.created)
  const currency = txn.currency.toUpperCase()
  const description = describeBalanceTxn(txn)

  const rows: RawTransaction[] = [
    {
      date,
      description,
      amount: roundOre(txn.amount / 100),
      currency,
      external_id: stripeExternalId(stripeAccountId, txn.id),
      import_source: STRIPE_IMPORT_SOURCE,
      transaction_method: methodForBalanceTxn(txn),
    },
  ]
  if (txn.fee) {
    rows.push({
      date,
      description: `Stripe-avgift (${description})`,
      amount: roundOre(-txn.fee / 100),
      currency,
      external_id: stripeFeeExternalId(stripeAccountId, txn.id),
      import_source: STRIPE_IMPORT_SOURCE,
      transaction_method: 'fee',
    })
  }
  return rows
}

/**
 * Whether a balance transaction can land on the SEK cash account on 1686:
 * only one in SEK (see "Currency" in the header).
 */
export function isLedgerCurrency(txn: Pick<BalanceTxnLike, 'currency'>): boolean {
  return txn.currency.toUpperCase() === STRIPE_LEDGER_CURRENCY
}

/**
 * Moves the cursor forward to `ms`, never back. Progress also clears
 * error_message, as in the webshop order syncs: a failure the nightly run
 * wrote on the connection is over once a sync (the button's too) gets through.
 */
async function advanceWatermark(
  supabase: SupabaseClient,
  connection: StripeConnection,
  ms: number,
): Promise<void> {
  const current = connection.last_balance_txn_synced_at
    ? Date.parse(connection.last_balance_txn_synced_at)
    : Number.NEGATIVE_INFINITY
  if (!(ms > current)) return
  const iso = new Date(ms).toISOString()
  await supabase
    .from('stripe_connections')
    .update({ last_balance_txn_synced_at: iso, error_message: null })
    .eq('id', connection.id)
  connection.last_balance_txn_synced_at = iso
}

/**
 * Lists the window's balance transactions page by page (newest first, as
 * Stripe returns them), up to MAX_TXNS_PER_RUN, checking the caller's
 * deadline before each page. One awaited autoPagingToArray could not be
 * stopped: up to 100 requests ran to the end whatever was left of the cron's
 * budget, and a kill at the route's maxDuration takes the rest of the run's
 * connections with it.
 *
 * `cut` means the deadline stopped the listing early. What was listed is then
 * the newest part of the window only, so the caller must not ingest it and
 * move the cursor: the older transactions behind it would be skipped for good.
 */
async function listBalanceTransactions(
  stripe: Pick<Stripe, 'balanceTransactions'>,
  gte: number,
  requestOptions: Stripe.RequestOptions,
  deadlineMs: number | undefined,
): Promise<{ listed: BalanceTxnLike[]; cut: boolean }> {
  const listed: BalanceTxnLike[] = []
  // The button's sync passes no deadline and keeps the client's defaults.
  const pageOptions = deadlineMs === undefined ? requestOptions : { ...requestOptions, ...DEADLINE_PAGE_OPTIONS }
  let startingAfter: string | undefined
  while (listed.length < MAX_TXNS_PER_RUN) {
    if (deadlineMs !== undefined && Date.now() >= deadlineMs) return { listed, cut: true }
    const page = await stripe.balanceTransactions.list(
      {
        created: { gte },
        limit: LIST_PAGE_SIZE,
        expand: ['data.source'],
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      },
      pageOptions,
    )
    listed.push(...page.data)
    if (!page.has_more || page.data.length === 0) break
    startingAfter = page.data[page.data.length - 1].id
  }
  return { listed: listed.slice(0, MAX_TXNS_PER_RUN), cut: false }
}

/** The cursor-window view of a connection (see lib/feed-sync/cursor-window). */
function cursorWindowOf(connection: StripeConnection): CursorWindowConnection {
  return {
    cursor: connection.last_balance_txn_synced_at,
    connectedAt: connection.connected_at,
    createdAt: connection.created_at,
  }
}

const toSeconds = (ms: number) => Math.max(0, Math.floor(ms / 1000))

/**
 * Start (epoch ms) of the first Swedish day after the company lock date, or
 * 0 when nothing is locked: rows on/before the lock date are unbookable by
 * the enforce_company_lock_date trigger. Swedish midnight, because rows are
 * dated on the Swedish day.
 */
async function firstBookableMs(supabase: SupabaseClient, companyId: string): Promise<number> {
  const { data: settings } = await supabase
    .from('company_settings')
    .select('bookkeeping_locked_through')
    .eq('company_id', companyId)
    .maybeSingle()
  const lockThrough = (settings as { bookkeeping_locked_through?: string | null } | null)
    ?.bookkeeping_locked_through
  if (!lockThrough || !ISO_DATE_RE.test(lockThrough)) return 0
  const ms = stockholmDayStartMs(addDaysIso(lockThrough, 1))
  return Number.isFinite(ms) ? ms : 0
}

/** What one run lists from Stripe, and which listed transactions it keeps. */
export interface FetchPlan {
  /** created.gte for the list call (epoch seconds). */
  gte: number
  /** False for a listed transaction the feed must leave out. */
  keep: (txn: BalanceTxnLike) => boolean
}

const keepAll = () => true

/**
 * The newest payout per currency created before `beforeSec`, as its
 * `created` (epoch seconds). A payout takes everything payable when it is
 * created off the balance, so funds that became payable after the last one
 * were still on the balance at `beforeSec`. Failed and cancelled payouts
 * count too: the money they return comes back as its own
 * payout_failure/payout_cancel transaction after them.
 */
async function lastPayoutPerCurrency(
  stripe: Pick<Stripe, 'payouts'>,
  requestOptions: Stripe.RequestOptions,
  beforeSec: number,
): Promise<Map<string, number>> {
  const page = await stripe.payouts.list(
    { created: { lt: beforeSec }, limit: PAYOUT_PAGE_SIZE },
    requestOptions,
  )
  const last = new Map<string, number>()
  for (const payout of page.data) {
    const currency = payout.currency.toLowerCase()
    last.set(currency, Math.max(last.get(currency) ?? 0, payout.created))
  }
  return last
}

/**
 * Where a run starts reading, and what it keeps (crm#1344).
 *
 * Once the cursor has passed the connection moment, a run reads from its
 * cursor minus the 24h overlap and keeps everything.
 *
 * Until then the cursor is a feed start: the connection moment the OAuth
 * callback seeded, or the day a backfill chose. A feed start must not cut
 * through the Stripe balance. Money Stripe paid out before it is in the bank
 * and booked from there; money still on the balance is not, and the next
 * payout takes it out against 1686: left out of the feed, that payout never
 * adds up and the sales in it are never booked. So the balance at the start
 * has to reach the books exactly once:
 * - 1686 already has a balance in the ledger before the start day (kept by
 *   hand, imported, or an earlier connection): the books carry it, and the
 *   feed starts at Swedish midnight of the start day, as the panel promises.
 *   A failed ledger read takes this path too: it never reads more than the
 *   feed did before.
 * - 1686 is empty: the run also reads every transaction that was still on
 *   the balance at the start, i.e. made payable after the last payout before
 *   it, and never an earlier payout itself.
 * external_id dedup keeps a rerun from the same start idempotent. Every
 * window is floored at the day after the company lock date.
 */
export async function planFetch(
  supabase: SupabaseClient,
  connection: StripeConnection,
  stripe: Pick<Stripe, 'payouts'>,
  requestOptions: Stripe.RequestOptions,
  log: Logger = defaultLog,
): Promise<FetchPlan> {
  const floorMs = await firstBookableMs(supabase, connection.company_id)
  const window = cursorWindowOf(connection)
  if (!isBeforeFirstAdvance(window)) {
    const fromMs = resolveWindowStartMs(window, CURSOR_OVERLAP_SECONDS * 1000)
    return { gte: toSeconds(Math.max(fromMs, floorMs)), keep: keepAll }
  }

  const cursorMs = window.cursor ? Date.parse(window.cursor) : Number.NaN
  const startSec = Math.floor((Number.isFinite(cursorMs) ? cursorMs : connectionStartMs(window)) / 1000)
  const startDay = isoDate(startSec)
  const fromStartDay: FetchPlan = {
    gte: toSeconds(Math.max(stockholmDayStartMs(startDay), floorMs)),
    keep: keepAll,
  }

  const ledgerBalance = await sumAccountBalance(
    supabase,
    connection.company_id,
    STRIPE_LEDGER_ACCOUNT,
    { beforeDate: startDay },
  )
  if (ledgerBalance === null || ledgerBalance !== 0) return fromStartDay

  let lastPayout: Map<string, number>
  try {
    lastPayout = await lastPayoutPerCurrency(stripe, requestOptions, startSec)
  } catch (err) {
    if (isRevokedConnectionError(err)) throw err
    log.warn('payout list failed; the feed starts at the start day', {
      connectionId: connection.id,
      error: err instanceof Error ? err.message : String(err),
    })
    return fromStartDay
  }

  const swept = [...lastPayout.values()]
  const listFromSec =
    swept.length > 0
      ? Math.min(...swept) - MAX_PAYOUT_DELAY_SECONDS
      : startSec - NO_PAYOUT_LOOKBACK_SECONDS
  return {
    gte: toSeconds(Math.max(listFromSec * 1000, floorMs)),
    keep: (txn) => {
      if (txn.created >= startSec) return true
      if (txn.type === 'payout') return false
      const sweptAt = lastPayout.get(txn.currency.toLowerCase())
      return sweptAt === undefined || (txn.available_on ?? txn.created) > sweptAt
    },
  }
}

/**
 * Make sure the Stripe balance cash account exists (ledger 1686, source
 * manual so a later remap/promotion follows the normal cash-account rules)
 * and, on the first run, that 1686 exists in the chart of accounts: the
 * booking dialog and AccountPicker only list chart accounts.
 */
async function ensureStripeBalanceAccount(
  supabase: SupabaseClient,
  connection: StripeConnection,
  firstRun: boolean,
  log: Logger,
): Promise<void> {
  await ensureManualCashAccount(
    supabase,
    connection.company_id,
    STRIPE_LEDGER_ACCOUNT,
    STRIPE_LEDGER_CURRENCY,
    'Stripe-saldo',
  )
  if (firstRun) {
    const sync = await syncMappedAccounts(
      supabase,
      connection.company_id,
      connection.user_id,
      [
        {
          sourceAccount: STRIPE_LEDGER_ACCOUNT,
          sourceName: STRIPE_LEDGER_ACCOUNT_NAME,
          targetAccount: STRIPE_LEDGER_ACCOUNT,
          targetName: STRIPE_LEDGER_ACCOUNT_NAME,
          confidence: 1,
          matchType: 'exact',
          isOverride: false,
        },
      ],
      false,
    )
    if (sync.error) {
      // Rows still import and bind to the cash account; only the chart
      // listing is affected (the account can be added manually), so this is
      // deliberately non-fatal.
      log.warn('chart sync for 1686 failed', {
        companyId: connection.company_id,
        error: sync.error,
      })
    }
  }
}

export async function syncStripeBalanceTransactions(
  supabase: SupabaseClient,
  connection: StripeConnection,
  log: Logger = defaultLog,
  /**
   * Absolute deadline (epoch ms) from the caller's time budget. Enforced
   * between ingest chunks: the cursor advances only over processed chunks, so
   * the next run resumes exactly where this one stopped.
   */
  deadlineMs?: number,
): Promise<StripeTransactionSyncSummary> {
  const summary: StripeTransactionSyncSummary = {
    fetched: 0,
    imported: 0,
    duplicates: 0,
    errors: 0,
    foreignCurrency: 0,
  }
  if (!connection.stripe_account_id || connection.status !== 'active') return summary

  const stripe = getStripe()
  const requestOptions = connectedAccountOptions(connection.stripe_account_id)
  // One-time chart setup (1686) runs until the cursor has moved past the
  // connection moment: a freshly activated connection carries a seeded
  // cursor, so "no cursor" no longer identifies the first run.
  const firstRun = isBeforeFirstAdvance(cursorWindowOf(connection))
  const runStartMs = Date.now()

  let listed: BalanceTxnLike[]
  let plan: FetchPlan
  let cut: boolean
  let listStartMs: number
  try {
    plan = await planFetch(supabase, connection, stripe, requestOptions, log)
    listStartMs = Date.now()
    // Under the run's deadline the listing also has a share of its own, so
    // one account too large for any night cannot take the whole run.
    const listDeadlineMs = deadlineMs === undefined ? undefined : Math.min(deadlineMs, listStartMs + FAIR_LIST_BUDGET_MS)
    ;({ listed, cut } = await listBalanceTransactions(stripe, plan.gte, requestOptions, listDeadlineMs))
  } catch (err) {
    if (isRevokedConnectionError(err)) {
      await markConnectionRevokedUpstream(supabase, connection, log)
      summary.revoked = true
      return summary
    }
    throw err
  }

  if (cut) {
    // Nothing is ingested and the cursor stays, so the connection keeps the
    // front of the cron's oldest-cursor-first order and gets its share again
    // next run. Unless it was its own share that ran out: then no run will
    // get through, so it is an error for us, and the cron's runner writes the
    // message on the connection instead of leaving a date that never moves.
    if (deadlineMs !== undefined && listStartMs + FAIR_LIST_BUDGET_MS <= deadlineMs) {
      log.error('stripe balance-transaction listing does not fit its share of the nightly run', {
        connectionId: connection.id,
        companyId: connection.company_id,
        listed: listed.length,
        listedFrom: new Date(plan.gte * 1000).toISOString(),
        shareMs: FAIR_LIST_BUDGET_MS,
      })
      throw new Error(STRIPE_HISTORY_TOO_LARGE_MESSAGE)
    }
    summary.deadlineReached = true
    log.info('time budget exhausted while listing; nothing ingested, the cursor stays', {
      connectionId: connection.id,
      listed: listed.length,
    })
    return summary
  }

  const txns = listed.filter(plan.keep)
  summary.fetched = txns.length
  // Fewer than the cap: the list ran to the end of the window.
  const windowExhausted = listed.length < MAX_TXNS_PER_RUN
  if (txns.length === 0) {
    // A quiet account moves its cursor to the run start too, or it keeps the
    // front of the cron's oldest-cursor-first candidates. Not on the first
    // run: the cursor passing the connection moment is what ends the one-time
    // 1686 chart setup, which only an imported row needs.
    if (!firstRun) await advanceWatermark(supabase, connection, runStartMs)
    return summary
  }

  // Oldest first: cursor advancement stays chronological.
  txns.sort((a, b) => a.created - b.created)

  await ensureStripeBalanceAccount(supabase, connection, firstRun, log)

  /** Left-out non-SEK balance transactions per currency, for the log. */
  const foreignByCurrency: Record<string, number> = {}
  // Earliest chunk with a row that failed to insert; the cursor never passes
  // it, as in the webshop order syncs.
  let failureFloorMs = Number.POSITIVE_INFINITY

  for (const chunk of chunked(txns, INGEST_CHUNK_SIZE)) {
    if (deadlineMs !== undefined && Date.now() >= deadlineMs) {
      summary.deadlineReached = true
      log.info('time budget exhausted; stopping balance-transaction batch', {
        connectionId: connection.id,
        processed: summary.imported + summary.duplicates,
        remaining: summary.fetched - summary.imported - summary.duplicates,
      })
      break
    }

    const bookable: BalanceTxnLike[] = []
    for (const txn of chunk) {
      if (isLedgerCurrency(txn)) {
        bookable.push(txn)
      } else {
        const currency = txn.currency.toUpperCase()
        foreignByCurrency[currency] = (foreignByCurrency[currency] ?? 0) + 1
        summary.foreignCurrency += 1
      }
    }
    const rows = bookable.flatMap((txn) =>
      mapBalanceTransaction(connection.stripe_account_id!, txn),
    )
    // Auto-categorization is skipped on purpose: booking Stripe money is a
    // human decision in the inbox, like any bank feed. Invoice matching still
    // runs (suggestions only).
    //
    // stableExternalIds: the ids embed Stripe's balance-transaction id, which
    // names one booking for good. Two refunds of the same amount on the same
    // day share a title ("Stripe-återbetalning"); when they land in different
    // ingest calls (a chunk boundary, a later run), the second must not be
    // dropped as a copy of the first.
    if (rows.length > 0) {
      const result = await ingestTransactions(
        supabase,
        connection.company_id,
        connection.user_id,
        rows,
        { settlementAccount: STRIPE_LEDGER_ACCOUNT, skipAutoCategorization: true, stableExternalIds: true },
      )
      summary.imported += result.imported
      summary.duplicates += result.duplicates
      summary.errors += result.errors
      if (result.errors > 0) {
        // A failed insert is counted, not stored. Hold the cursor below this
        // chunk so the next run lists it again and retries the row (the stored
        // ones are external_id duplicates there); moving on would leave a row
        // that fails two runs in a row outside the 24h overlap for good. The
        // cron runner reports the count as an error (lib/webshop-orders/order-cron).
        failureFloorMs = Math.min(failureFloorMs, chunk[0].created * 1000 - 1000)
        log.warn('balance-transaction rows not imported; cursor held below them', {
          connectionId: connection.id,
          errors: result.errors,
          code: result.first_error?.code ?? null,
          reason: result.first_error?.message ?? null,
        })
      }
    }

    // Persist the cursor after each chunk so a crash or deadline stop resumes
    // from the last fully-processed chunk (the 24h overlap absorbs the rest),
    // capped by the failure floor. Never back: a first run's chunks from
    // before the connection moment leave the seeded cursor where it is, so a
    // stopped first run reruns as a first run instead of reading as a
    // backfill to that earlier date.
    await advanceWatermark(supabase, connection, Math.min(chunk[chunk.length - 1].created * 1000, failureFloorMs))
  }

  // Scanned-through watermark, as in the webshop order syncs: a window listed
  // to its end and fully processed means "synced through run start", even
  // when the last transaction is days old. The 24h overlap re-poll covers
  // transactions Stripe made visible while the run was in flight.
  if (windowExhausted && !summary.deadlineReached) {
    await advanceWatermark(supabase, connection, Math.min(runStartMs, failureFloorMs))
  }

  if (summary.foreignCurrency > 0) {
    log.warn('non-SEK balance transactions left out of the feed', {
      connectionId: connection.id,
      currencies: foreignByCurrency,
    })
  }

  log.info('stripe balance-transaction sync done', {
    connectionId: connection.id,
    ...summary,
  })
  return summary
}
