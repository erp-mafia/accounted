import { chunk as chunked } from '@/lib/utils'
import type Stripe from 'stripe'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getStripe } from '@/lib/stripe/client'
import { ingestTransactions } from '@/lib/transactions/ingest'
import { ensureManualCashAccount } from '@/lib/cash-accounts/service'
import { syncMappedAccounts } from '@/lib/import/account-sync'
import { createLogger, type Logger } from '@/lib/logger'
import type { RawTransaction, TransactionMethod } from '@/types'
import { connectedAccountOptions, isRevokedConnectionError } from './connect'
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
 * Double-booking protection: money the deterministic flows already booked is
 * imported pre-linked to its journal entry instead of appearing bookable:
 *   - charge gross rows whose checkout session settled an invoice link to the
 *     settlement entry (stripe_payment_events.matched_booked),
 *   - payout rows AND the fee rows of the charges inside a booked payout link
 *     to the payout entry (stripe_payouts.booked): the payout booking carries
 *     the whole payout's fees in aggregate (see payouts.ts), so its 1686+6570
 *     movement equals the payout row plus those fee rows.
 * Fee rows whose payout has not been booked yet stay unbooked and are claimed
 * by processPayoutPaidEvent when the payout books (linkPayoutFeedRows below).
 *
 * Cursor: stripe_connections.last_balance_txn_synced_at (max `created`
 * processed), re-polled with a 24h overlap. Safe because balance transactions
 * are immutable and carry stable txn_... ids: a re-seen transaction collides
 * on (company_id, external_id) and is skipped. First run backfills 90 days,
 * floored at the day after the company lock date: rows behind the lock can
 * never be booked and would only be permanent inbox noise.
 */

/** BAS ledger account for the Stripe balance cash account. */
export const STRIPE_LEDGER_ACCOUNT = '1686'
/** BAS 2026 name for 1686; used when creating the chart account. */
const STRIPE_LEDGER_ACCOUNT_NAME = 'Fordringar för kontokort och kuponger'
/** transactions.import_source for Stripe feed rows. */
export const STRIPE_IMPORT_SOURCE = 'stripe'
/** First-run backfill window (matches the Enable Banking convention). */
export const BACKFILL_DAYS = 90
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
  /** Rows pre-linked to journal entries the deterministic flows already booked. */
  linked: number
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
      // Mirrors the payout journal entry description ("Stripe-utbetalning
      // po_...") so the linked pair reads as one event.
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

/**
 * Link a booked payout's feed rows to the payout journal entry: the payout
 * row itself plus every fee row among the payout's balance transactions (the
 * payout entry books those fees in aggregate: 6570 + reverse charge). Called
 * from processPayoutPaidEvent at booking time AND from the sync when it
 * imports rows for an already-booked payout; idempotent either way (only
 * unlinked rows are claimed) and a no-op for companies without the feed.
 */
export async function linkPayoutFeedRows(
  supabase: SupabaseClient,
  companyId: string,
  stripeAccountId: string,
  journalEntryId: string,
  txns: Array<Pick<BalanceTxnLike, 'id' | 'type' | 'fee'>>,
  log: Logger = defaultLog,
): Promise<number> {
  const externalIds: string[] = []
  for (const txn of txns) {
    if (txn.type === 'payout') externalIds.push(stripeExternalId(stripeAccountId, txn.id))
    if (txn.fee) externalIds.push(stripeFeeExternalId(stripeAccountId, txn.id))
  }
  if (externalIds.length === 0) return 0

  const { data, error } = await supabase
    .from('transactions')
    .update({ journal_entry_id: journalEntryId })
    .eq('company_id', companyId)
    .in('external_id', externalIds)
    .is('journal_entry_id', null)
    .select('id')

  if (error) {
    // Non-fatal by contract: the payout booking itself must never unwind
    // because feed-row linking failed. The sync's next run retries.
    log.warn('failed to link payout feed rows', {
      companyId,
      journalEntryId,
      error: error.message,
    })
    return 0
  }
  return data?.length ?? 0
}

/**
 * Window start (epoch seconds) for the balance-transaction list call. With a
 * cursor: cursor minus the 24h overlap. First run: BACKFILL_DAYS back,
 * floored at the day AFTER the company lock date (rows on/before it are
 * unbookable by the enforce_company_lock_date trigger).
 */
async function resolveWindowStartSeconds(
  supabase: SupabaseClient,
  connection: StripeConnection,
): Promise<number> {
  if (connection.last_balance_txn_synced_at) {
    const cursorSec = Math.floor(Date.parse(connection.last_balance_txn_synced_at) / 1000)
    return Math.max(0, cursorSec - CURSOR_OVERLAP_SECONDS)
  }

  let startMs = Date.now() - BACKFILL_DAYS * 86_400_000
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

/** Gross rows of charges the checkout flow already settled → settlement entry. */
async function linkSettledCharges(
  supabase: SupabaseClient,
  connection: StripeConnection,
  txns: BalanceTxnLike[],
  log: Logger,
): Promise<number> {
  const grossIdByPaymentIntent = new Map<string, string>()
  for (const txn of txns) {
    if (txn.type !== 'charge' && txn.type !== 'payment') continue
    const charge = chargeOf(txn)
    const pi =
      typeof charge?.payment_intent === 'string'
        ? charge.payment_intent
        : charge?.payment_intent?.id
    if (!pi) continue
    grossIdByPaymentIntent.set(pi, stripeExternalId(connection.stripe_account_id!, txn.id))
  }
  if (grossIdByPaymentIntent.size === 0) return 0

  const { data: events, error } = await supabase
    .from('stripe_payment_events')
    .select('payment_intent_id, journal_entry_id')
    .eq('connection_id', connection.id)
    .eq('status', 'matched_booked')
    .not('journal_entry_id', 'is', null)
    .in('payment_intent_id', [...grossIdByPaymentIntent.keys()])
  if (error) {
    log.warn('settled-charge lookup failed; rows stay unlinked this run', {
      connectionId: connection.id,
      error: error.message,
    })
    return 0
  }
  if (!events || events.length === 0) return 0

  const externalIdsByEntry = new Map<string, string[]>()
  for (const event of events as Array<{
    payment_intent_id: string | null
    journal_entry_id: string | null
  }>) {
    if (!event.payment_intent_id || !event.journal_entry_id) continue
    const externalId = grossIdByPaymentIntent.get(event.payment_intent_id)
    if (!externalId) continue
    const ids = externalIdsByEntry.get(event.journal_entry_id)
    if (ids) ids.push(externalId)
    else externalIdsByEntry.set(event.journal_entry_id, [externalId])
  }

  let linked = 0
  for (const [journalEntryId, externalIds] of externalIdsByEntry) {
    const { data, error: linkError } = await supabase
      .from('transactions')
      .update({ journal_entry_id: journalEntryId })
      .eq('company_id', connection.company_id)
      .in('external_id', externalIds)
      .is('journal_entry_id', null)
      .select('id')
    if (linkError) {
      log.warn('settled-charge link failed', {
        connectionId: connection.id,
        journalEntryId,
        error: linkError.message,
      })
      continue
    }
    linked += data?.length ?? 0
  }
  return linked
}

/**
 * Payout rows in this chunk whose payout the payout flow already booked:
 * link the payout row + the payout's fee rows to the payout entry. One extra
 * Stripe list call per booked payout (bounded by payouts in the window; the
 * balance transaction itself does not reference its payout).
 */
async function linkBookedPayouts(
  supabase: SupabaseClient,
  connection: StripeConnection,
  txns: BalanceTxnLike[],
  stripe: Stripe,
  requestOptions: Stripe.RequestOptions,
  log: Logger,
): Promise<number> {
  const payoutIds: string[] = []
  for (const txn of txns) {
    if (txn.type !== 'payout') continue
    const id = sourceId(txn.source)
    if (id) payoutIds.push(id)
  }
  if (payoutIds.length === 0) return 0

  const { data: payouts, error } = await supabase
    .from('stripe_payouts')
    .select('payout_id, journal_entry_id')
    .eq('connection_id', connection.id)
    .eq('status', 'booked')
    .not('journal_entry_id', 'is', null)
    .in('payout_id', payoutIds)
  if (error) {
    log.warn('booked-payout lookup failed; rows stay unlinked this run', {
      connectionId: connection.id,
      error: error.message,
    })
    return 0
  }

  let linked = 0
  for (const payout of (payouts ?? []) as Array<{
    payout_id: string
    journal_entry_id: string
  }>) {
    const payoutTxns = await stripe.balanceTransactions
      .list({ payout: payout.payout_id, limit: 100 }, requestOptions)
      .autoPagingToArray({ limit: 1000 })
    linked += await linkPayoutFeedRows(
      supabase,
      connection.company_id,
      connection.stripe_account_id!,
      payout.journal_entry_id,
      payoutTxns,
      log,
    )
  }
  return linked
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
    linked: 0,
    errors: 0,
  }
  if (!connection.stripe_account_id || connection.status !== 'active') return summary

  const stripe = getStripe()
  const requestOptions = connectedAccountOptions(connection.stripe_account_id)
  const firstRun = !connection.last_balance_txn_synced_at
  const gte = await resolveWindowStartSeconds(supabase, connection)

  let txns: BalanceTxnLike[]
  try {
    txns = await stripe.balanceTransactions
      .list({ created: { gte }, limit: 100, expand: ['data.source'] }, requestOptions)
      .autoPagingToArray({ limit: MAX_TXNS_PER_RUN })
  } catch (err) {
    if (isRevokedConnectionError(err)) {
      // The event sync polls every 15 minutes and owns the revoked-status
      // transition + audit event; this nightly pass just reports and stops.
      summary.revoked = true
      return summary
    }
    throw err
  }

  summary.fetched = txns.length
  if (txns.length === 0) return summary

  // Oldest first: cursor advancement stays chronological, and a payout's
  // charges are always ingested before (or with) the payout row their fee
  // linking depends on.
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
    // Auto-categorization is skipped on purpose: for Stripe money the
    // deterministic settle/payout flows own booking; everything else is a
    // human decision in the inbox. Invoice matching still runs (suggestions
    // only), and FX enrichment covers non-SEK rows.
    const result = await ingestTransactions(
      supabase,
      connection.company_id,
      connection.user_id,
      rows,
      { settlementAccount: STRIPE_LEDGER_ACCOUNT, skipAutoCategorization: true },
    )
    summary.imported += result.imported
    summary.duplicates += result.duplicates
    summary.errors += result.errors

    summary.linked += await linkSettledCharges(supabase, connection, chunk, log)
    summary.linked += await linkBookedPayouts(
      supabase,
      connection,
      chunk,
      stripe,
      requestOptions,
      log,
    )

    // Persist the cursor after each chunk so a crash or deadline stop resumes
    // from the last fully-processed chunk (the 24h overlap absorbs the rest).
    const maxCreated = chunk[chunk.length - 1].created
    await supabase
      .from('stripe_connections')
      .update({ last_balance_txn_synced_at: new Date(maxCreated * 1000).toISOString() })
      .eq('id', connection.id)
    connection.last_balance_txn_synced_at = new Date(maxCreated * 1000).toISOString()
  }

  log.info('stripe balance-transaction sync done', {
    connectionId: connection.id,
    ...summary,
  })
  return summary
}
