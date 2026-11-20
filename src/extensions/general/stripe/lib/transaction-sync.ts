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
import { TIME_BUDGET_MS } from '@/lib/webshop-orders/order-cron'
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
 * Cursor: stripe_connections.last_balance_txn_synced_at, re-polled with a
 * 24h overlap, which a run reads first as one window. From the cursor on it
 * reads in bounded windows (created in [gte, lt)), oldest first: it lists a
 * window to its end, ingests it and moves the cursor to the window's end
 * before the next one, so a run that stops loses at most the window it was
 * in and the next run goes on from the cursor. A window read in part is
 * never ingested: Stripe lists newest first, so the part holds the window's
 * newest transactions, and moving the cursor past it would skip the older
 * ones for good. Rereading is safe
 * because balance transactions are immutable and carry stable txn_... ids:
 * a re-seen transaction collides on (company_id, external_id) and is
 * skipped. The OAuth callback seeds the cursor with the connection moment;
 * older history is an explicit choice (POST /backfill moves the cursor back
 * to the start of a Swedish day). Every window is floored at the day after
 * the company lock date: rows behind the lock can never be booked and would
 * only be permanent inbox noise.
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
/**
 * Balance transactions a run reads from where its cursor stood before it
 * stops: it starts no window that could take it past this, and the next run
 * goes on from the cursor. A bound on one run's work, never on what the feed
 * imports. Not counted: the re-read before the cursor (FetchPlan.wholeUntil),
 * which holds nothing the cursor can move past. One window can still take a
 * run past it: a single second, which cannot be split and is read whole (up
 * to WHOLE_WINDOW_PAGE_CAP) once the windows before it are in.
 */
const MAX_TXNS_PER_RUN = 10_000
/** Balance transactions per list call: Stripe's largest page. */
const LIST_PAGE_SIZE = 100
/**
 * Pages one window may take. A window with more is dropped, and since Stripe
 * lists newest first, the part it listed tells where the next one ends (see
 * syncStripeBalanceTransactions). A cut at the deadline loses ten pages at most.
 */
const WINDOW_PAGE_CAP = 10
const MAX_TXNS_PER_WINDOW = WINDOW_PAGE_CAP * LIST_PAGE_SIZE
/**
 * Pages a window that cannot be split may take: a first run's window before
 * its feed start, or a single second. One that holds more gets through no run.
 */
const WHOLE_WINDOW_PAGE_CAP = MAX_TXNS_PER_RUN / LIST_PAGE_SIZE
/** Span of a run's first window; a window under half full doubles the next. */
const FIRST_WINDOW_SECONDS = 7 * 86_400
/**
 * The longest one connection may take of the nightly runner's deadline, which
 * all its connections share (SyncOptions.fairShare), counted from its own
 * start. A connection that reaches it without moving its cursor does not fit
 * any run: its cursor stays, so it stays first in the cron's
 * oldest-cursor-first order, and without a share of its own it would take
 * every night's run from the connections behind it. That is a failure, not
 * a pause. A manual run's deadline is its own: it gets all of it.
 */
const FAIR_SHARE_MS = 120_000
/** After a pause that moved the cursor less than a day: a warning this far behind. */
const BEHIND_WARN_MS = 48 * 3_600_000
/** ...and an error, once, on the run that takes it this far behind. */
const BEHIND_ERROR_MS = 7 * 86_400_000
/**
 * What the connection says when no run can get through (the cron's runner
 * stores it after its lead sentence, lib/webshop-orders/order-cron.ts). It
 * promises no retry: this is for us to solve, and the error log is how we
 * hear of it.
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

/** A Stripe call's options: bounded by DEADLINE_PAGE_OPTIONS under a deadline. */
function withDeadlineBounds(requestOptions: Stripe.RequestOptions, deadlineMs: number | undefined): Stripe.RequestOptions {
  return deadlineMs === undefined ? requestOptions : { ...requestOptions, ...DEADLINE_PAGE_OPTIONS }
}
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
  /**
   * Set when the run stopped before the end of its range: the caller's time
   * budget ran out, or the run read MAX_TXNS_PER_RUN. The cursor holds what
   * was ingested, and the next run goes on from there.
   */
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
 * Moves the cursor forward to `ms`, never back; true when it moved. Progress
 * also clears error_message, as in the webshop order syncs: a failure the
 * nightly run wrote on the connection is over once a sync (the button's too)
 * gets through.
 */
async function advanceWatermark(
  supabase: SupabaseClient,
  connection: StripeConnection,
  ms: number,
): Promise<boolean> {
  const current = connection.last_balance_txn_synced_at
    ? Date.parse(connection.last_balance_txn_synced_at)
    : Number.NEGATIVE_INFINITY
  if (!(ms > current)) return false
  const iso = new Date(ms).toISOString()
  await supabase
    .from('stripe_connections')
    .update({ last_balance_txn_synced_at: iso, error_message: null })
    .eq('id', connection.id)
  connection.last_balance_txn_synced_at = iso
  return true
}

/** One window's listing, whole only when neither `cut` nor `overflow` is set. */
interface WindowListing {
  /**
   * The window's transactions the plan keeps, oldest first. After an
   * overflow: its listed, newest part only (see listWindow). After a cut:
   * nothing.
   */
  kept: BalanceTxnLike[]
  /** Balance transactions listed, kept or not. */
  listed: number
  /** The oldest `created` listed (epoch seconds); null when nothing was. */
  oldest: number | null
  /** The deadline came before the window's end. */
  cut: boolean
  /** The window took its page cap and Stripe had more: the rest was not listed. */
  overflow: boolean
}

/**
 * Lists one window, created in [gte, lt), page by page (newest first, as
 * Stripe returns them), checking the caller's deadline before each page. One
 * awaited autoPagingToArray could not be stopped: up to 100 requests ran to
 * the end whatever was left of the cron's budget, and a kill at the route's
 * maxDuration takes the rest of the run's connections with it.
 *
 * A cut or an overflow leaves the window's newest part only: the cursor must
 * not pass the older transactions behind that part. A cut returns nothing; an
 * overflow stops at the page cap without asking for one more, and returns its
 * listed part, which only a re-read behind the cursor may ingest.
 */
async function listWindow(
  stripe: Pick<Stripe, 'balanceTransactions'>,
  window: { gte: number; lt: number },
  keep: FetchPlan['keep'],
  requestOptions: Stripe.RequestOptions,
  deadlineMs: number | undefined,
  pageCap: number,
): Promise<WindowListing> {
  const kept: BalanceTxnLike[] = []
  let listed = 0
  let oldest: number | null = null
  const pageOptions = withDeadlineBounds(requestOptions, deadlineMs)
  let startingAfter: string | undefined
  for (let pages = 0; ; pages++) {
    if (pages === pageCap) {
      kept.sort((a, b) => a.created - b.created)
      return { kept, listed, oldest, cut: false, overflow: true }
    }
    if (deadlineMs !== undefined && Date.now() >= deadlineMs) return { kept: [], listed, oldest, cut: true, overflow: false }
    const page = await stripe.balanceTransactions.list(
      {
        created: { gte: window.gte, lt: window.lt },
        limit: LIST_PAGE_SIZE,
        expand: ['data.source'],
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      },
      pageOptions,
    )
    listed += page.data.length
    for (const txn of page.data) {
      if (oldest === null || txn.created < oldest) oldest = txn.created
      if (keep(txn)) kept.push(txn)
    }
    if (!page.has_more || page.data.length === 0) break
    startingAfter = page.data[page.data.length - 1].id
  }
  // Oldest first: the cursor moves through the window in time order.
  kept.sort((a, b) => a.created - b.created)
  return { kept, listed, oldest, cut: false, overflow: false }
}

/**
 * The cursor-window view of a connection (see lib/feed-sync/cursor-window).
 * Its start is the feed start the feed has read the open balance of, when one
 * is recorded (a backfill's day): a cursor past it is a later run, so a
 * backfill paused partway resumes from its cursor instead of reading the
 * balance there as a new start.
 */
function cursorWindowOf(connection: StripeConnection): CursorWindowConnection {
  return {
    cursor: connection.last_balance_txn_synced_at,
    connectedAt: connection.balance_txn_feed_start ?? connection.connected_at,
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
  /** created.gte of the run's first window (epoch seconds). */
  gte: number
  /**
   * Where the cursor stands (epoch seconds): a later run's cursor, or a first
   * run's feed start. What the run reads before it (the 24h overlap, or the
   * open balance at a feed start) is one window, never split and not counted
   * against MAX_TXNS_PER_RUN, as main read the overlap: the cursor cannot
   * record progress there. An overlap too large for one window is only a
   * re-read: its older part is skipped. An open balance too large for one
   * fails the run.
   */
  wholeUntil: number
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
 * cursor minus the 24h overlap and keeps everything; the overlap is one
 * window (FetchPlan.wholeUntil).
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
 * Either way, what the run reads before the feed start is one window
 * (FetchPlan.wholeUntil). external_id dedup keeps a rerun from the same start
 * idempotent. Every window is floored at the day after the company lock date.
 *
 * Null when `deadlineMs` passed before the payout list: the run stops there.
 */
export async function planFetch(
  supabase: SupabaseClient,
  connection: StripeConnection,
  stripe: Pick<Stripe, 'payouts'>,
  requestOptions: Stripe.RequestOptions,
  log: Logger = defaultLog,
  deadlineMs?: number,
): Promise<FetchPlan | null> {
  const floorMs = await firstBookableMs(supabase, connection.company_id)
  const window = cursorWindowOf(connection)
  if (!isBeforeFirstAdvance(window)) {
    const fromMs = resolveWindowStartMs(window, CURSOR_OVERLAP_SECONDS * 1000)
    return {
      gte: toSeconds(Math.max(fromMs, floorMs)),
      wholeUntil: toSeconds(Date.parse(window.cursor!)),
      keep: keepAll,
    }
  }

  const cursorMs = window.cursor ? Date.parse(window.cursor) : Number.NaN
  const startSec = Math.floor((Number.isFinite(cursorMs) ? cursorMs : connectionStartMs(window)) / 1000)
  const startDay = isoDate(startSec)
  const fromStartDay: FetchPlan = {
    gte: toSeconds(Math.max(stockholmDayStartMs(startDay), floorMs)),
    wholeUntil: startSec,
    keep: keepAll,
  }

  const ledgerBalance = await sumAccountBalance(
    supabase,
    connection.company_id,
    STRIPE_LEDGER_ACCOUNT,
    { beforeDate: startDay },
  )
  if (ledgerBalance === null || ledgerBalance !== 0) return fromStartDay

  if (deadlineMs !== undefined && Date.now() >= deadlineMs) return null
  let lastPayout: Map<string, number>
  try {
    lastPayout = await lastPayoutPerCurrency(stripe, withDeadlineBounds(requestOptions, deadlineMs), startSec)
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
    wholeUntil: startSec,
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

export interface SyncOptions {
  /**
   * The deadline is the nightly runner's, shared with the connections behind
   * this one: take at most FAIR_SHARE_MS of it. Without it, as for "Synka nu"
   * and a backfill, the deadline is all this connection's own.
   */
  fairShare?: boolean
}

export async function syncStripeBalanceTransactions(
  supabase: SupabaseClient,
  connection: StripeConnection,
  log: Logger = defaultLog,
  /**
   * Absolute deadline (epoch ms) from the caller's time budget, checked
   * before each Stripe call and each ingest chunk. The cursor advances only
   * over what was ingested, so the next run resumes where this one stopped.
   */
  deadlineMs?: number,
  options: SyncOptions = {},
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
  const syncStartMs = Date.now()
  const view = cursorWindowOf(connection)
  // One-time chart setup (1686) runs until the cursor has moved past the
  // connection moment: a freshly activated connection carries a seeded
  // cursor, so "no cursor" no longer identifies the first run.
  const firstRun = isBeforeFirstAdvance(view)
  // Where the cursor stood. What the run reads before it is a re-read: the
  // 24h overlap, or a first run's window before its feed start.
  const cursorMs = view.cursor ? Date.parse(view.cursor) : Number.NaN
  const startMs = Number.isFinite(cursorMs) ? cursorMs : connectionStartMs(view)
  // The run reads up to its own start, in Stripe's whole seconds: what is
  // created while it runs is the next run's, whose 24h overlap reads it.
  const untilSec = Math.floor(syncStartMs / 1000)
  // Under the nightly runner's shared deadline a connection also has a share
  // of its own, so one that cannot get through takes no more of the run than
  // that (FAIR_SHARE_MS). A manual run's deadline is all its own.
  const shareEndMs = deadlineMs !== undefined && options.fairShare ? syncStartMs + FAIR_SHARE_MS : undefined
  const stopAtMs = deadlineMs === undefined ? undefined : Math.min(deadlineMs, shareEndMs ?? deadlineMs)

  /** No run gets through: an error for us, and the message for the connection. */
  const tooLarge = (reason: string, details: Record<string, unknown>): never => {
    log.error(reason, { connectionId: connection.id, companyId: connection.company_id, ...details })
    throw new Error(STRIPE_HISTORY_TOO_LARGE_MESSAGE)
  }

  // Any Stripe call can find the connection severed: it is then marked
  // revoked, and the run ends with what it did. Other errors go on up.
  const endIfRevoked = async (err: unknown): Promise<StripeTransactionSyncSummary> => {
    if (!isRevokedConnectionError(err)) throw err
    await markConnectionRevokedUpstream(supabase, connection, log)
    summary.revoked = true
    return summary
  }

  let plan: FetchPlan | null
  try {
    plan = await planFetch(supabase, connection, stripe, requestOptions, log, stopAtMs)
  } catch (err) {
    return endIfRevoked(err)
  }
  if (plan === null) {
    summary.deadlineReached = true
    log.info('time budget exhausted before listing; the next run starts here', { connectionId: connection.id })
    return summary
  }

  /** Left-out non-SEK balance transactions per currency, for the log. */
  const foreignByCurrency: Record<string, number> = {}
  // Earliest chunk with a row that failed to insert; the cursor never passes
  // it, as in the webshop order syncs.
  let failureFloorMs = Number.POSITIVE_INFINITY
  // Whether the 1686 cash account is ensured this run. A first run moves no
  // cursor before that: the cursor passing the connection moment is what
  // ends the one-time chart setup, which only an imported row needs.
  let accountReady = false
  // Whether the run got past where its cursor stood, whatever a failed row let
  // the cursor record: a stop after that is a pause, never a failure. Not for
  // a first run before its first row: its cursor cannot move yet, so the next
  // run would do the same again.
  let progressed = false
  let feedStartRecorded = false

  /**
   * Records the start this first run read the open balance of, once its
   * cursor is past it, so the next run resumes from the cursor instead of
   * reading that balance again (cursorWindowOf). Best effort: without it the
   * next run reads it again, which the external_id dedup makes harmless.
   */
  const recordFeedStart = async (): Promise<void> => {
    if (feedStartRecorded) return
    feedStartRecorded = true
    const recorded = connection.balance_txn_feed_start ?? connection.connected_at
    if (recorded && Date.parse(recorded) === startMs) return
    const iso = new Date(startMs).toISOString()
    const { error } = await supabase
      .from('stripe_connections')
      .update({ balance_txn_feed_start: iso })
      .eq('id', connection.id)
    if (error) {
      log.warn('could not record the feed start; the next run reads its open balance again', {
        connectionId: connection.id,
        error: error.message,
      })
      return
    }
    connection.balance_txn_feed_start = iso
  }

  /**
   * Moves the cursor forward to `ms`, held below a failed row. Never back: a
   * first run's window before the connection moment leaves the seeded cursor
   * where it is, so a stopped first run reruns as a first run instead of
   * reading as a backfill to that earlier date.
   */
  const advanceTo = async (ms: number): Promise<void> => {
    if (firstRun && !accountReady) return
    if (ms > startMs) progressed = true
    if ((await advanceWatermark(supabase, connection, Math.min(ms, failureFloorMs))) && firstRun) {
      await recordFeedStart()
    }
  }

  /** Imports one chunk's SEK rows; the rest are counted as foreignCurrency. */
  const ingestChunk = async (chunk: BalanceTxnLike[]): Promise<void> => {
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
  }

  /** Ingests one window's transactions, oldest first; false when the deadline stopped it. */
  const ingestWindow = async (txns: BalanceTxnLike[]): Promise<boolean> => {
    if (txns.length === 0) return true
    if (!accountReady) {
      await ensureStripeBalanceAccount(supabase, connection, firstRun, log)
      accountReady = true
    }
    summary.fetched += txns.length
    for (const chunk of chunked(txns, INGEST_CHUNK_SIZE)) {
      if (stopAtMs !== undefined && Date.now() >= stopAtMs) return false
      await ingestChunk(chunk)
      // Persist the cursor after each chunk so a crash or deadline stop
      // resumes from the last fully-processed chunk (the 24h overlap absorbs
      // the rest), capped by the failure floor.
      await advanceTo(chunk[chunk.length - 1].created * 1000)
    }
    return true
  }

  /**
   * After a later run's pause that moved the cursor less than a day, a feed
   * synced once a night falls further behind: a warning past BEHIND_WARN_MS,
   * and an error on the run that takes it past BEHIND_ERROR_MS. Where the
   * cursor stood when the row was last written (its previous run, updated_at)
   * tells that run apart, so the error comes once, not every night; that
   * write came up to one run budget after the previous run measured its own
   * lag, hence the slack. Not on a first run: a backfill pausing on its way
   * catches up on the later runs.
   */
  const reportBehind = (): void => {
    if (firstRun) return
    const cursorAfterMs = Date.parse(connection.last_balance_txn_synced_at ?? '')
    if (!Number.isFinite(cursorAfterMs) || cursorAfterMs - startMs >= 24 * 3_600_000) return
    const behindMs = syncStartMs - cursorAfterMs
    if (behindMs <= BEHIND_WARN_MS) return
    const lastWrittenMs = Date.parse(connection.updated_at)
    const behindBeforeMs = Number.isFinite(lastWrittenMs) ? lastWrittenMs - startMs - TIME_BUDGET_MS : 0
    const details = {
      connectionId: connection.id,
      companyId: connection.company_id,
      behindHours: Math.round(behindMs / 3_600_000),
    }
    if (behindMs > BEHIND_ERROR_MS && behindBeforeMs <= BEHIND_ERROR_MS) {
      log.error('stripe balance-transaction feed has fallen more than a week behind', details)
    } else {
      log.warn('stripe balance-transaction feed is falling behind', details)
    }
  }

  // What lies before where the cursor stands is read as one window: a later
  // run's 24h overlap, or a first run's open balance at its feed start.
  const wholeUntil = plan.wholeUntil
  let from = plan.gte
  let span = FIRST_WINDOW_SECONDS
  // After a window too full to list: the oldest second its listed part
  // reached. The windows before it end there, and that second is then read on
  // its own, whole, since it can hold more than a window does.
  let barrier: number | null = null
  /** Rows of this run's finished windows from where the cursor stood (MAX_TXNS_PER_RUN). */
  let fresh = 0
  let windows = 0
  let stop: 'deadline' | 'bound' | null = null
  while (from < untilSec) {
    const whole = from < wholeUntil
    const second = !whole && barrier === from
    if (!whole && !second && fresh + MAX_TXNS_PER_WINDOW > MAX_TXNS_PER_RUN) {
      stop = 'bound'
      break
    }
    const lt = whole
      ? Math.min(wholeUntil, untilSec)
      : second
        ? from + 1
        : Math.min(from + span, barrier ?? untilSec, untilSec)
    const unsplittable = whole || lt - from === 1
    let listing: WindowListing
    try {
      listing = await listWindow(
        stripe, { gte: from, lt }, plan.keep, requestOptions, stopAtMs,
        unsplittable ? WHOLE_WINDOW_PAGE_CAP : WINDOW_PAGE_CAP,
      )
    } catch (err) {
      return endIfRevoked(err)
    }
    if (listing.cut) {
      stop = 'deadline'
      break
    }
    if (listing.overflow) {
      if (whole && !firstRun) {
        // A later run's 24h overlap with more than one window holds is only a
        // re-read of what the cursor has passed: its listed, newest part goes
        // in, as main took it, its older part is skipped, and the run goes on
        // from the cursor.
        log.warn('stripe balance-transaction overlap too large to re-read whole; its older part is skipped', {
          connectionId: connection.id,
          skippedBefore: new Date((listing.oldest ?? from) * 1000).toISOString(),
        })
        windows += 1
        if (!(await ingestWindow(listing.kept))) {
          stop = 'deadline'
          break
        }
        from = lt
        continue
      }
      if (unsplittable) {
        tooLarge('stripe balance-transaction window that cannot be split holds more than one run reads', {
          from: new Date(from * 1000).toISOString(),
          to: new Date(lt * 1000).toISOString(),
          listed: listing.listed,
        })
      }
      // Stripe lists newest first, so the listed part is the window's newest,
      // from its oldest second on. The next window ends at that second, and
      // is half as long as the listed part took; a shorter guess than needed
      // grows back by doubling.
      const oldest = listing.oldest ?? from
      barrier = oldest
      span = Math.max(1, Math.floor((lt - oldest) / 2))
      continue
    }
    windows += 1
    if (!whole) fresh += listing.kept.filter((txn) => txn.created * 1000 >= startMs).length
    if (!(await ingestWindow(listing.kept))) {
      stop = 'deadline'
      break
    }
    // Listed to its end and ingested: the cursor moves to the window's end,
    // even when its last transaction is days older.
    await advanceTo(lt * 1000)
    if (second) barrier = null
    else if (!whole && listing.listed < MAX_TXNS_PER_WINDOW / 2) span *= 2
    from = lt
  }

  if (stop === 'deadline') {
    // The time this connection had ran out, and it got nowhere: it fits no
    // run, and a pause would hand it the front of every night's run. Under
    // the nightly runner that time is its share; when the run's end came
    // first, it started late and the next night gives it the whole share. A
    // manual run's deadline is all its own.
    const ownTimeOver = shareEndMs === undefined || (shareEndMs < deadlineMs! && Date.now() >= shareEndMs)
    if (!progressed && ownTimeOver) {
      tooLarge('stripe balance-transaction sync does not fit its share of the run', {
        from: new Date(from * 1000).toISOString(),
        windows,
        shareMs: shareEndMs === undefined ? deadlineMs! - syncStartMs : FAIR_SHARE_MS,
      })
    }
    summary.deadlineReached = true
    log.info('time budget exhausted; the next run goes on from the cursor', {
      connectionId: connection.id,
      from: new Date(from * 1000).toISOString(),
      progressed,
    })
    if (progressed) reportBehind()
  } else if (stop === 'bound') {
    summary.deadlineReached = true
    log.info('balance-transaction run bound reached; the next run goes on from the cursor', {
      connectionId: connection.id,
      fresh,
    })
    reportBehind()
  } else {
    // Read through to the run start, also when there was nothing to read: a
    // quiet account leaves the front of the cron's oldest-cursor-first order.
    await advanceTo(untilSec * 1000)
  }

  if (summary.foreignCurrency > 0) {
    log.warn('non-SEK balance transactions left out of the feed', {
      connectionId: connection.id,
      currencies: foreignByCurrency,
    })
  }

  log.info('stripe balance-transaction sync done', {
    connectionId: connection.id,
    windows,
    ...summary,
  })
  return summary
}
