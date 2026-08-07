import type { SupabaseClient } from '@supabase/supabase-js'
import { ingestTransactions } from '@/lib/transactions/ingest'
import { ensureManualCashAccount } from '@/lib/cash-accounts/service'
import { syncMappedAccounts } from '@/lib/import/account-sync'
import { createLogger, type Logger } from '@/lib/logger'
import type { RawTransaction } from '@/types'
import {
  listOrdersPage,
  listOrderRefunds,
  isRevokedCredentialsError,
  WC_PAGE_SIZE,
  type WooCredentials,
} from './api-client'
import { credentialsOf } from './connect'
import type { WooCommerceConnection, WooOrder, WooRefund } from '../types'

const defaultLog = createLogger('woocommerce/order-sync')

/**
 * WooCommerce order sync: the store's paid orders and refunds treated as a
 * bank-style feed.
 *
 * The store becomes a cash account on ledger 1680 (Andra kortfristiga
 * fordringar: money the payment gateways owe the merchant), and orders land
 * in the transactions inbox exactly like PSD2 bank rows: deduped on
 * external_id, bound to the cash account so booking settles against 1680, and
 * categorized/booked by the user through the normal flows. Nothing here
 * auto-books. 1686 (Fordringar för kontokort och kuponger) would be the
 * closest BAS account but is owned by the Stripe feed, and cash_accounts
 * enforces one account per ledger per company.
 *
 * Row model: a paid order produces one positive row for its gross total; each
 * refund produces one negative row. Payment-processor fees never appear:
 * core wc/v3 does not expose them (they belong to the gateway, e.g. the
 * Stripe feed for Stripe-gateway stores). order.transaction_id rides along as
 * the row reference for later gateway-side reconciliation.
 *
 * Pagination is CURSOR-based, not offset-based: each request asks for the
 * oldest orders with date_modified strictly after the current cursor
 * (orderby=modified asc, page=1), and the cursor advances to the last row of
 * each processed page. Offset pages over a fixed window would silently skip
 * rows whenever an already-fetched order is modified mid-run (it re-sorts to
 * the end and shifts every later row one index down); with a moving cursor a
 * mid-run modification simply re-surfaces the order later in the same run.
 * The one case that still needs offsets is a run of >WC_PAGE_SIZE orders
 * sharing the same date_modified second (bulk edits, migrations): those are
 * paged through with an increasing page number at a FIXED cursor, because
 * modified_after is strictly exclusive and advancing it would skip the rest
 * of the tie. Ties that span a page boundary after cursor advancement are
 * picked up by the next run's overlap re-poll.
 *
 * Cursor: woocommerce_connections.last_order_synced_at, re-polled with a 24h
 * overlap. It never advances past failed work: a page with refund-fetch
 * failures, ingest errors, or deadline-skipped refunds caps the persisted
 * cursor just below the earliest affected order's date_modified, so the next
 * run re-lists exactly the orders whose rows are incomplete (re-seen complete
 * rows collide on (company_id, external_id) and are skipped). First run
 * fetches BACKFILL_DAYS back.
 *
 * Lock-date guard: modified_after selects on date_modified, but rows are
 * dated by date_paid / refund date_created, which can be arbitrarily older
 * (a refund or edit bumps date_modified long after payment). Rows dated on or
 * before company_settings.bookkeeping_locked_through are therefore dropped at
 * map time on EVERY run: the enforce_company_lock_date trigger makes them
 * permanently unbookable, and feed rows are undeletable by design, so
 * importing them would create permanent inbox noise. Dropped rows are counted
 * in skipped_locked and logged.
 */

/** BAS ledger account for the WooCommerce store cash account. */
export const WOOCOMMERCE_LEDGER_ACCOUNT = '1680'
/** BAS 2026 name for 1680; used when creating the chart account. */
const WOOCOMMERCE_LEDGER_ACCOUNT_NAME = 'Andra kortfristiga fordringar'
/** transactions.import_source for WooCommerce feed rows. */
export const WOOCOMMERCE_IMPORT_SOURCE = 'woocommerce'
/** First-run backfill window (matches the Enable Banking convention). */
export const BACKFILL_DAYS = 90
/** Cursor re-poll overlap; external_id dedup makes duplicates no-ops. */
const CURSOR_OVERLAP_MS = 24 * 60 * 60 * 1000
/**
 * Safety cap on orders per run (matches the Stripe feed's MAX_TXNS_PER_RUN).
 * The real bound is the caller's deadline; hitting this cap is logged loudly
 * because a silent cap reads as "covered everything" when it did not. The
 * cursor resumes where a truncated run stopped.
 */
const MAX_ORDERS_PER_RUN = 10_000

/**
 * ⚠️ STORED-KEY FORMATS. These are persisted to transactions.external_id and
 * dedup compares stored ids byte-for-byte, exactly like the Stripe and Enable
 * Banking schemes. Changing a template silently orphans every prior row and
 * re-imports the whole feed on the next sync. Locked by the frozen-format
 * test in order-sync.test.ts; any change MUST ship a coordinated backfill.
 *
 * The scope is the store's normalized host(+path), NOT the connection id, so
 * a disconnect/reconnect of the same store keeps every previously imported
 * row deduped.
 */
export function wooStoreScope(storeUrl: string): string {
  return storeUrl.replace(/^https:\/\//, '')
}

export function wooOrderExternalId(storeScope: string, orderId: number): string {
  return `woo_${storeScope}_order_${orderId}`
}

export function wooRefundExternalId(storeScope: string, refundId: number): string {
  return `woo_${storeScope}_refund_${refundId}`
}

export interface WooCommerceSyncSummary {
  /** Orders listed from the store (all statuses in the window). */
  fetched: number
  /** Refund objects fetched for refunded orders in the window. */
  refundsFetched: number
  /** New inbox rows inserted. */
  imported: number
  /** Rows skipped by external_id / content dedup. */
  duplicates: number
  /** Rows dropped because they are dated on/before the bookkeeping lock. */
  skippedLocked: number
  errors: number
  /** Set when the caller's time budget ran out before all pages processed. */
  deadlineReached?: boolean
  /** Set when the store reported the credentials revoked (401/403). */
  revoked?: boolean
}

const round = (n: number) => Math.round(n * 100) / 100

/**
 * Money fields arrive as strings; unparseable input returns null so callers
 * can tell a corrupt total (counted + logged in buildPageRows) from a
 * legitimate zero (silently skipped).
 */
function parseAmount(value: string): number | null {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? round(parsed) : null
}

/** Whether a qualifying order's total cannot be read as money. */
export function orderAmountUnparseable(order: Pick<WooOrder, 'total'>): boolean {
  return parseAmount(order.total) === null
}

/** Date part of a wc/v3 _gmt timestamp ("2026-08-01T12:34:56", no zone suffix). */
function isoDateOfGmt(timestamp: string): string {
  return timestamp.split('T')[0]
}

/** wc/v3 _gmt timestamps lack a zone suffix; brand them UTC for timestamptz. */
function gmtToIso(timestamp: string): string {
  return timestamp.endsWith('Z') ? timestamp : `${timestamp}Z`
}

function gmtToMs(timestamp: string): number {
  return Date.parse(gmtToIso(timestamp))
}

/**
 * Whether an order belongs in the feed: it must have been paid (date_paid is
 * the revenue signal; pending/failed/cancelled-before-payment orders never
 * carry one) and not be trashed. Status 'refunded' stays IN: a fully refunded
 * order was still paid, and its refunds land as separate negative rows so the
 * pair nets to zero instead of the gross silently disappearing.
 */
export function orderQualifies(order: Pick<WooOrder, 'status' | 'date_paid_gmt'>): boolean {
  return Boolean(order.date_paid_gmt) && order.status !== 'trash'
}

/**
 * Map a paid order to its gross feed row. Dates use date_paid (when the money
 * event happened), not date_created: booked entries, invoice matching, and
 * month boundaries all want the payment date. Descriptions are deterministic
 * from immutable data (order numbers never change) because the content-dedup
 * bridge keys off them.
 */
export function mapOrder(storeScope: string, order: WooOrder): RawTransaction[] {
  if (!orderQualifies(order)) return []
  const amount = parseAmount(order.total)
  if (amount === null || amount === 0) return []
  return [
    {
      date: isoDateOfGmt(order.date_paid_gmt!),
      description: `WooCommerce-order #${order.number}`,
      amount,
      currency: order.currency.toUpperCase(),
      external_id: wooOrderExternalId(storeScope, order.id),
      import_source: WOOCOMMERCE_IMPORT_SOURCE,
      reference: order.transaction_id || null,
    },
  ]
}

/** Map one refund of a paid order to its negative feed row. */
export function mapRefund(
  storeScope: string,
  order: Pick<WooOrder, 'number' | 'currency'>,
  refund: WooRefund,
): RawTransaction[] {
  const amount = parseAmount(refund.amount)
  if (amount === null || amount === 0) return []
  return [
    {
      date: isoDateOfGmt(refund.date_created_gmt),
      description: `WooCommerce-återbetalning order #${order.number}`,
      amount: -amount,
      currency: order.currency.toUpperCase(),
      external_id: wooRefundExternalId(storeScope, refund.id),
      import_source: WOOCOMMERCE_IMPORT_SOURCE,
      reference: null,
    },
  ]
}

/** Company lock date (YYYY-MM-DD) or null; read once per run. */
async function fetchLockThrough(
  supabase: SupabaseClient,
  companyId: string,
): Promise<string | null> {
  const { data: settings } = await supabase
    .from('company_settings')
    .select('bookkeeping_locked_through')
    .eq('company_id', companyId)
    .maybeSingle()
  return (
    (settings as { bookkeeping_locked_through?: string | null } | null)
      ?.bookkeeping_locked_through ?? null
  )
}

/** Whether a feed-row date is on/before the lock date (=> never bookable). */
export function rowBehindLock(rowDate: string, lockThrough: string | null): boolean {
  return lockThrough !== null && rowDate <= lockThrough
}

/**
 * Window start (ISO, UTC) for the first modified_after list call. With a
 * cursor: cursor minus the 24h overlap. First run: BACKFILL_DAYS back. (The
 * lock date no longer floors the window: it selects on date_modified while
 * rows are dated by date_paid, so the real guard is rowBehindLock at map
 * time, applied on every run.)
 */
function resolveWindowStartIso(connection: WooCommerceConnection): string {
  if (connection.last_order_synced_at) {
    const cursorMs = Date.parse(connection.last_order_synced_at)
    return new Date(Math.max(0, cursorMs - CURSOR_OVERLAP_MS)).toISOString()
  }
  return new Date(Date.now() - BACKFILL_DAYS * 86_400_000).toISOString()
}

/**
 * Make sure the store cash account exists (ledger 1680, source manual so a
 * later remap/promotion follows the normal cash-account rules) and, on the
 * first run, that 1680 exists in the chart of accounts: the booking dialog
 * and AccountPicker only list chart accounts.
 *
 * Currency comes from the store settings read at connect time, falling back
 * to the first fetched order's real currency (settings/general is blocked on
 * some hardened stores, and guessing SEK for an EUR store would poison the
 * account). A conflict with an existing 1680 cash account throws; the caller
 * surfaces that on the connection so the panel shows why nothing syncs.
 */
async function ensureStoreAccount(
  supabase: SupabaseClient,
  connection: WooCommerceConnection,
  fallbackCurrency: string | undefined,
  firstRun: boolean,
  log: Logger,
): Promise<void> {
  const currency =
    connection.currency?.toUpperCase() || fallbackCurrency?.toUpperCase() || 'SEK'
  try {
    await ensureManualCashAccount(
      supabase,
      connection.company_id,
      WOOCOMMERCE_LEDGER_ACCOUNT,
      currency,
      'WooCommerce-saldo',
    )
  } catch (accountError) {
    // Typically a currency conflict with an existing 1680 cash account. Made
    // visible on the connection: without this the panel shows a healthy
    // "Ansluten" store that silently never syncs.
    await supabase
      .from('woocommerce_connections')
      .update({
        error_message:
          'Kassakontot för butiken (1680) kunde inte skapas. Kontrollera att befintligt konto 1680 har samma valuta som butiken.',
      })
      .eq('id', connection.id)
    throw accountError
  }
  if (firstRun) {
    const sync = await syncMappedAccounts(
      supabase,
      connection.company_id,
      connection.user_id,
      [
        {
          sourceAccount: WOOCOMMERCE_LEDGER_ACCOUNT,
          sourceName: WOOCOMMERCE_LEDGER_ACCOUNT_NAME,
          targetAccount: WOOCOMMERCE_LEDGER_ACCOUNT,
          targetName: WOOCOMMERCE_LEDGER_ACCOUNT_NAME,
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
      log.warn('chart sync for 1680 failed', {
        companyId: connection.company_id,
        error: sync.error,
      })
    }
  }
}

interface PageRowsOutcome {
  rows: RawTransaction[]
  /**
   * date_modified (ms) of every order whose refund rows are incomplete this
   * run (fetch failed or skipped on deadline). The cursor must not advance
   * past these: the next run has to re-list them.
   */
  incompleteModifiedMs: number[]
  hitDeadline: boolean
}

/** Rows for one page of orders: gross rows plus refund rows where present. */
async function buildPageRows(
  creds: WooCredentials,
  storeScope: string,
  orders: WooOrder[],
  lockThrough: string | null,
  summary: WooCommerceSyncSummary,
  log: Logger,
  deadlineMs?: number,
): Promise<PageRowsOutcome> {
  const outcome: PageRowsOutcome = { rows: [], incompleteModifiedMs: [], hitDeadline: false }

  const push = (mapped: RawTransaction[]) => {
    for (const row of mapped) {
      if (rowBehindLock(row.date, lockThrough)) {
        summary.skippedLocked += 1
        continue
      }
      outcome.rows.push(row)
    }
  }

  for (const order of orders) {
    // A corrupt total is counted and logged, never silently identical to a
    // zero-total order. Deliberately NOT held via the cursor: a permanently
    // corrupt total would stall the whole feed forever, where a skipped row
    // plus a loud error can be followed up.
    if (orderQualifies(order) && orderAmountUnparseable(order)) {
      summary.errors += 1
      log.warn('unparseable order total; row skipped', {
        orderId: order.id,
        total: order.total,
      })
    }
    push(mapOrder(storeScope, order))
    // Refunds only exist for qualifying (paid) orders: a refund row without
    // its gross counterpart would be an unexplainable negative in the inbox.
    if (!orderQualifies(order) || order.refunds.length === 0) continue

    // Refund fetches are one request per refunded order against a slow host;
    // without this check a single mass-refund page could blow through the
    // function's maxDuration and the cursor would never persist.
    if (outcome.hitDeadline || (deadlineMs !== undefined && Date.now() >= deadlineMs)) {
      outcome.hitDeadline = true
      outcome.incompleteModifiedMs.push(gmtToMs(order.date_modified_gmt))
      continue
    }

    try {
      const refunds = await listOrderRefunds(creds, order.id)
      summary.refundsFetched += refunds.length
      for (const refund of refunds) {
        if (parseAmount(refund.amount) === null) {
          summary.errors += 1
          log.warn('unparseable refund amount; row skipped', {
            orderId: order.id,
            refundId: refund.id,
            amount: refund.amount,
          })
        }
        push(mapRefund(storeScope, order, refund))
      }
    } catch (refundError) {
      // The order row still imports; the cursor is capped below this order's
      // date_modified so the next run re-lists it and retries the refunds.
      summary.errors += 1
      outcome.incompleteModifiedMs.push(gmtToMs(order.date_modified_gmt))
      log.warn('refund fetch failed; order held for retry next run', {
        orderId: order.id,
        message: refundError instanceof Error ? refundError.message : String(refundError),
      })
    }
  }
  return outcome
}

export async function syncWooCommerceOrders(
  supabase: SupabaseClient,
  connection: WooCommerceConnection,
  log: Logger = defaultLog,
  /**
   * Absolute deadline (epoch ms) from the caller's time budget. Enforced
   * between pages AND between refund fetches inside a page: the cursor
   * advances only over fully-processed work, so the next run resumes exactly
   * where this one stopped.
   */
  deadlineMs?: number,
): Promise<WooCommerceSyncSummary> {
  const summary: WooCommerceSyncSummary = {
    fetched: 0,
    refundsFetched: 0,
    imported: 0,
    duplicates: 0,
    skippedLocked: 0,
    errors: 0,
  }
  if (
    connection.status !== 'active' ||
    !connection.consumer_key_encrypted ||
    !connection.consumer_secret_encrypted
  ) {
    return summary
  }

  const creds = credentialsOf(connection)
  const storeScope = wooStoreScope(connection.store_url)
  const firstRun = !connection.last_order_synced_at
  const lockThrough = await fetchLockThrough(supabase, connection.company_id)

  let modifiedAfter = resolveWindowStartIso(connection)
  // Offset page within a same-timestamp tie only; 1 whenever the cursor moves.
  let tiePage = 1
  let prevCursorMs = connection.last_order_synced_at
    ? Date.parse(connection.last_order_synced_at)
    : 0
  // Earliest incomplete work this run; the persisted cursor never passes it.
  let failureFloorMs = Number.POSITIVE_INFINITY
  let accountEnsured = false

  try {
    for (;;) {
      if (deadlineMs !== undefined && Date.now() >= deadlineMs) {
        summary.deadlineReached = true
        log.info('time budget exhausted; stopping order sync', {
          connectionId: connection.id,
          processed: summary.imported + summary.duplicates,
        })
        break
      }

      const orders = await listOrdersPage(creds, { modifiedAfter, page: tiePage })
      // Termination is an EMPTY page, not a short one: hosts and security
      // plugins may cap per_page below our request, and treating a short page
      // as the end would strand the cursor at the first page forever.
      if (orders.length === 0) break
      summary.fetched += orders.length

      // Deferred until the window is known non-empty so a quiet store costs
      // one API call and zero DB writes; also gives us a real order currency
      // as the fallback for stores whose settings are unreadable.
      if (!accountEnsured) {
        await ensureStoreAccount(supabase, connection, orders[0].currency, firstRun, log)
        accountEnsured = true
      }

      const page = await buildPageRows(
        creds,
        storeScope,
        orders,
        lockThrough,
        summary,
        log,
        deadlineMs,
      )
      if (page.hitDeadline) summary.deadlineReached = true

      const firstMs = gmtToMs(orders[0].date_modified_gmt)
      const lastMs = gmtToMs(orders[orders.length - 1].date_modified_gmt)

      if (page.rows.length > 0) {
        // Auto-categorization is skipped on purpose: booking WooCommerce
        // money is a human decision in the inbox (feed-only doctrine, same
        // as the Stripe feed). Invoice matching still runs (suggestions
        // only), and FX enrichment covers non-SEK stores.
        const result = await ingestTransactions(
          supabase,
          connection.company_id,
          connection.user_id,
          page.rows,
          { settlementAccount: WOOCOMMERCE_LEDGER_ACCOUNT, skipAutoCategorization: true },
        )
        summary.imported += result.imported
        summary.duplicates += result.duplicates
        summary.errors += result.errors
        if (result.errors > 0) {
          // Failed inserts are dropped inside ingest; hold the cursor below
          // this page so the next run re-lists and retries it rather than
          // turning a transient DB error into permanently missing rows.
          failureFloorMs = Math.min(failureFloorMs, firstMs - 1000)
        }
      }
      for (const ms of page.incompleteModifiedMs) {
        failureFloorMs = Math.min(failureFloorMs, ms - 1000)
      }

      // Persist the cursor after each page: monotonic (never regresses below
      // the pre-run cursor) and capped by the failure floor. error_message is
      // cleared on progress so a resolved incident stops showing in the panel.
      const candidateMs = Math.min(lastMs, failureFloorMs)
      if (candidateMs > prevCursorMs) {
        const cursorIso = new Date(candidateMs).toISOString()
        await supabase
          .from('woocommerce_connections')
          .update({ last_order_synced_at: cursorIso, error_message: null })
          .eq('id', connection.id)
        connection.last_order_synced_at = cursorIso
        prevCursorMs = candidateMs
      }

      if (summary.deadlineReached) break

      // Advance. A full page entirely inside one date_modified second cannot
      // move the cursor (modified_after is strictly exclusive): page through
      // the tie by offset. Otherwise move the cursor to the page's last row;
      // tie rows cut off at the boundary are recovered by the next run's
      // overlap re-poll.
      if (orders.length >= WC_PAGE_SIZE && lastMs === firstMs) {
        tiePage += 1
      } else {
        modifiedAfter = new Date(lastMs).toISOString()
        tiePage = 1
      }

      if (summary.fetched >= MAX_ORDERS_PER_RUN) {
        log.warn('order cap reached; remaining orders resume next run', {
          connectionId: connection.id,
          cap: MAX_ORDERS_PER_RUN,
        })
        break
      }
    }
  } catch (err) {
    if (isRevokedCredentialsError(err)) {
      // The key was deleted or demoted in wp-admin: flip the connection so
      // the UI offers a reconnect instead of the cron retrying forever.
      summary.revoked = true
      await supabase
        .from('woocommerce_connections')
        .update({
          status: 'revoked',
          error_message: 'Butiken avvisade API-nyckeln. Anslut butiken igen.',
          // The store already rejected these; keeping decryptable dead
          // credentials would be pure data retention (same as /disconnect).
          consumer_key_encrypted: null,
          consumer_secret_encrypted: null,
          disconnected_at: new Date().toISOString(),
        })
        .eq('id', connection.id)
        .eq('status', 'active')
      log.warn('credentials revoked upstream; connection flipped to revoked', {
        connectionId: connection.id,
      })
      return summary
    }
    throw err
  }

  if (summary.skippedLocked > 0) {
    log.info('rows behind the bookkeeping lock were skipped', {
      connectionId: connection.id,
      skippedLocked: summary.skippedLocked,
    })
  }
  log.info('woocommerce order sync done', {
    connectionId: connection.id,
    ...summary,
  })
  return summary
}
