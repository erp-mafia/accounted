import { chunk as chunked } from '@/lib/utils'
import type Stripe from 'stripe'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getStripe } from '@/lib/stripe/client'
import { ingestTransactions } from '@/lib/transactions/ingest'
import { ensureManualCashAccount } from '@/lib/cash-accounts/service'
import { syncMappedAccounts } from '@/lib/import/account-sync'
import {
  isBeforeFirstAdvance,
  resolveWindowStartMs,
  type CursorWindowConnection,
} from '@/lib/feed-sync/cursor-window'
import { createLogger, type Logger } from '@/lib/logger'
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
 * cursor with the connection moment, so the first run starts there (money
 * that moved before the connection is already booked from the bank side);
 * older history is an explicit choice (POST /backfill moves the cursor
 * back). Every window is floored at the day after the company lock date:
 * rows behind the lock can never be booked and would only be permanent
 * inbox noise.
 */

/** BAS ledger account for the Stripe balance cash account. */
export const STRIPE_LEDGER_ACCOUNT = '1686'
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
  /** Set when the caller's time budget ran out before all chunks processed. */
  deadlineReached?: boolean
  /** Set when the connection turned out to be revoked upstream. */
  revoked?: boolean
}

const round = (n: number) => Math.round(n * 100) / 100

function isoDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().split('T')[0]
}

/** Minimal shape shared by live Stripe objects and test fixtures. */
export type BalanceTxnLike = Pick<Stripe.BalanceTransaction, 'id' | 'type' | 'fee'> & {
  amount: number
  currency: string
  created: number
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
      amount: round(txn.amount / 100),
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
      amount: round(-txn.fee / 100),
      currency,
      external_id: stripeFeeExternalId(stripeAccountId, txn.id),
      import_source: STRIPE_IMPORT_SOURCE,
      transaction_method: 'fee',
    })
  }
  return rows
}

/** Moves the cursor forward to `ms`, never back. */
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
    .update({ last_balance_txn_synced_at: iso })
    .eq('id', connection.id)
  connection.last_balance_txn_synced_at = iso
}

/** The cursor-window view of a connection (see lib/feed-sync/cursor-window). */
function cursorWindowOf(connection: StripeConnection): CursorWindowConnection {
  return {
    cursor: connection.last_balance_txn_synced_at,
    connectedAt: connection.connected_at,
    createdAt: connection.created_at,
  }
}

/**
 * Window start (epoch seconds) for the balance-transaction list call. The
 * cursor is the start date: cursor minus the 24h overlap, clamped so the
 * overlap never reaches behind the point this connection is responsible for
 * (the connection moment, or an explicit backfill cursor when that is
 * earlier); a null cursor falls back to the connection's own start, never to
 * a fixed number of days.
 *
 * Every window is then floored at the day AFTER the company lock date (rows
 * on/before it are unbookable by the enforce_company_lock_date trigger). The
 * floor used to apply to the first run only; now that the first run starts
 * at the connection moment like every other run starts at its cursor, an
 * explicit backfill is the one way to reach into locked history, and the
 * floor has to sit on the resolved window to catch it.
 */
export async function resolveWindowStartSeconds(
  supabase: SupabaseClient,
  connection: StripeConnection,
): Promise<number> {
  let startMs = resolveWindowStartMs(cursorWindowOf(connection), CURSOR_OVERLAP_SECONDS * 1000)
  const { data: settings } = await supabase
    .from('company_settings')
    .select('bookkeeping_locked_through')
    .eq('company_id', connection.company_id)
    .maybeSingle()
  const lockThrough = (settings as { bookkeeping_locked_through?: string | null } | null)
    ?.bookkeeping_locked_through
  if (lockThrough) {
    const firstBookableMs = Date.parse(`${lockThrough}T00:00:00Z`) + 86_400_000
    if (Number.isFinite(firstBookableMs)) startMs = Math.max(startMs, firstBookableMs)
  }
  return Math.max(0, Math.floor(startMs / 1000))
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
    'SEK',
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
  }
  if (!connection.stripe_account_id || connection.status !== 'active') return summary

  const stripe = getStripe()
  const requestOptions = connectedAccountOptions(connection.stripe_account_id)
  // One-time chart setup (1686) runs until the cursor has moved past the
  // connection moment: a freshly activated connection carries a seeded
  // cursor, so "no cursor" no longer identifies the first run.
  const firstRun = isBeforeFirstAdvance(cursorWindowOf(connection))
  const runStartMs = Date.now()
  const gte = await resolveWindowStartSeconds(supabase, connection)

  let txns: BalanceTxnLike[]
  try {
    txns = await stripe.balanceTransactions
      .list({ created: { gte }, limit: 100, expand: ['data.source'] }, requestOptions)
      .autoPagingToArray({ limit: MAX_TXNS_PER_RUN })
  } catch (err) {
    if (isRevokedConnectionError(err)) {
      await markConnectionRevokedUpstream(supabase, connection, log)
      summary.revoked = true
      return summary
    }
    throw err
  }

  summary.fetched = txns.length
  // Fewer than the cap: the list ran to the end of the window.
  const windowExhausted = txns.length < MAX_TXNS_PER_RUN
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

    const rows = chunk.flatMap((txn) =>
      mapBalanceTransaction(connection.stripe_account_id!, txn),
    )
    // Auto-categorization is skipped on purpose: booking Stripe money is a
    // human decision in the inbox, like any bank feed. Invoice matching still
    // runs (suggestions only), and FX enrichment covers non-SEK rows.
    //
    // stableExternalIds: the ids embed Stripe's balance-transaction id, which
    // names one booking for good. Two refunds of the same amount on the same
    // day share a title ("Stripe-återbetalning"); when they land in different
    // ingest calls (a chunk boundary, a later run), the second must not be
    // dropped as a copy of the first.
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

    // Persist the cursor after each chunk so a crash or deadline stop resumes
    // from the last fully-processed chunk (the 24h overlap absorbs the rest).
    const maxCreated = chunk[chunk.length - 1].created
    await supabase
      .from('stripe_connections')
      .update({ last_balance_txn_synced_at: new Date(maxCreated * 1000).toISOString() })
      .eq('id', connection.id)
    connection.last_balance_txn_synced_at = new Date(maxCreated * 1000).toISOString()
  }

  // Scanned-through watermark, as in the webshop order syncs: a window listed
  // to its end and fully processed means "synced through run start", even
  // when the last transaction is days old. The 24h overlap re-poll covers
  // transactions Stripe made visible while the run was in flight.
  if (windowExhausted && !summary.deadlineReached) {
    await advanceWatermark(supabase, connection, runStartMs)
  }

  log.info('stripe balance-transaction sync done', {
    connectionId: connection.id,
    ...summary,
  })
  return summary
}
