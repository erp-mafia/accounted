import type { SupabaseClient } from '@supabase/supabase-js'
import { ingestTransactions } from '@/lib/transactions/ingest'
import { ensureManualCashAccount } from '@/lib/cash-accounts/service'
import { syncMappedAccounts } from '@/lib/import/account-sync'
import { createLogger, type Logger } from '@/lib/logger'
import { roundOre } from '@/lib/money'
import type { RawTransaction } from '@/types'
import {
  createShopifySession,
  isRevokedCredentialsError,
  listOrdersPage,
} from './api-client'
import { credentialsOf } from './credentials'
import type { ShopifyConnection, ShopifyOrder, ShopifyRefund } from '../types'

const defaultLog = createLogger('shopify/order-sync')

/**
 * Shopify order sync: the store's paid orders and refunds treated as a
 * bank-style feed.
 *
 * The store becomes a cash account on ledger 1584 (Fordringar Shopify
 * Payments in the 158x sub-account convention: money the payment gateways owe
 * the merchant), and orders land in the transactions inbox exactly like PSD2
 * bank rows: deduped on external_id, bound to the cash account so booking
 * settles against 1584, and categorized/booked by the user through the normal
 * flows. Nothing here auto-books (feed-only doctrine, same as the Stripe and
 * WooCommerce feeds). 1680 and 1686 are owned by those feeds, and
 * cash_accounts enforces one account per ledger per company.
 *
 * Row model: a paid order produces one positive row for its gross total; each
 * refund produces one negative row. Payment-processor fees never appear in
 * this feed: order-level fee data only exists for Shopify Payments and payout
 * reconciliation is a separate concern (phase 2); external gateways (Klarna,
 * Stripe) report no fees through Shopify at all. The gateway names ride along
 * as the row reference for later gateway-side reconciliation.
 *
 * Pagination: one fixed updated_at window per run, walked with Relay cursors
 * (sortKey UPDATED_AT ascending). Cursors are stable across same-second ties,
 * so there is no offset fallback (unlike the WooCommerce sync). The persisted
 * cursor is shopify_connections.last_order_synced_at: per page the max
 * updatedAt processed, and after a fully-listed window the run's start time
 * (a scanned-through watermark, so quiet and empty-first-run stores still
 * rotate to the back of the cron's oldest-first selection). Re-polled with a
 * 24h overlap; (company_id, external_id) dedup makes overlaps no-ops. It
 * never advances past failed work: a page with ingest errors caps the
 * persisted cursor just below the page's first updatedAt, so the next run
 * re-lists exactly the orders whose rows are incomplete. First run fetches
 * BACKFILL_DAYS back.
 *
 * Lock-date guard: the window selects on updatedAt, but rows are dated by
 * processedAt / refund createdAt, which can be arbitrarily older (a refund
 * bumps updatedAt long after payment). Rows dated on or before
 * company_settings.bookkeeping_locked_through are therefore dropped at map
 * time on EVERY run: the enforce_company_lock_date trigger makes them
 * permanently unbookable, and feed rows are undeletable by design, so
 * importing them would create permanent inbox noise. Dropped rows are counted
 * in skippedLocked and logged.
 */

/** BAS ledger account for the Shopify store cash account. */
export const SHOPIFY_LEDGER_ACCOUNT = '1584'
/** 158x sub-account name (e-handel convention); used for the chart account. */
const SHOPIFY_LEDGER_ACCOUNT_NAME = 'Fordringar Shopify Payments'
/** transactions.import_source for Shopify feed rows. */
export const SHOPIFY_IMPORT_SOURCE = 'shopify'
/** First-run backfill window (matches the WooCommerce/Enable Banking convention). */
export const BACKFILL_DAYS = 90
/** Cursor re-poll overlap; external_id dedup makes duplicates no-ops. */
const CURSOR_OVERLAP_MS = 24 * 60 * 60 * 1000
/**
 * Safety cap on orders per run (matches the Stripe/WooCommerce feeds). The
 * real bound is the caller's deadline; hitting this cap is logged loudly
 * because a silent cap reads as "covered everything" when it did not. The
 * cursor resumes where a truncated run stopped.
 */
const MAX_ORDERS_PER_RUN = 10_000

/**
 * ⚠️ STORED-KEY FORMATS. These are persisted to transactions.external_id and
 * dedup compares stored ids byte-for-byte, exactly like the Stripe, Enable
 * Banking and WooCommerce schemes. Changing a template silently orphans every
 * prior row and re-imports the whole feed on the next sync. Locked by the
 * frozen-format test in order-sync.test.ts; any change MUST ship a
 * coordinated backfill.
 *
 * The scope is the store's normalized myshopify.com domain, NOT the
 * connection id, so a disconnect/reconnect of the same store keeps every
 * previously imported row deduped. The ids are Shopify's numeric
 * legacyResourceIds, matching the shopify_order_{id} convention the MCP
 * agent path already uses (different prefix, so the two paths never collide
 * on the same rows by accident).
 */
export function shopifyShopScope(shopDomain: string): string {
  return shopDomain
}

export function shopifyOrderExternalId(shopScope: string, orderId: string): string {
  return `shopify_${shopScope}_order_${orderId}`
}

export function shopifyRefundExternalId(shopScope: string, refundId: string): string {
  return `shopify_${shopScope}_refund_${refundId}`
}

export interface ShopifySyncSummary {
  /** Orders listed from the store (all statuses in the window). */
  fetched: number
  /** Refund objects seen on qualifying orders in the window. */
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

/**
 * Money fields arrive as decimal strings in major units for every currency
 * (GraphQL MoneyV2; zero-decimal currencies like JPY included, so never
 * divide by 100). Unparseable input returns null so callers can tell a
 * corrupt total (counted + logged) from a legitimate zero (silently skipped).
 */
function parseAmount(value: string): number | null {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? roundOre(parsed) : null
}

/** Whether a qualifying order's total cannot be read as money. */
export function orderAmountUnparseable(order: Pick<ShopifyOrder, 'totalPriceSet'>): boolean {
  return parseAmount(order.totalPriceSet.shopMoney.amount) === null
}

/** Date part of an ISO timestamp. */
function isoDateOf(timestamp: string): string {
  return timestamp.split('T')[0]
}

/**
 * Financial statuses that mean the order has been paid (possibly later
 * refunded). AUTHORIZED/PENDING/PARTIALLY_PAID orders carry no settled
 * revenue yet and EXPIRED/VOIDED never will; they re-surface via updatedAt
 * once payment captures. REFUNDED stays IN: a fully refunded order was still
 * paid, and its refunds land as separate negative rows so the pair nets to
 * zero instead of the gross silently disappearing.
 */
const PAID_STATUSES = new Set(['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'])

/**
 * Whether an order belongs in the feed: it must have been paid and not be a
 * test-gateway order (dev stores, Bogus Gateway: never real revenue).
 */
export function orderQualifies(
  order: Pick<ShopifyOrder, 'test' | 'displayFinancialStatus'>,
): boolean {
  return !order.test && PAID_STATUSES.has(order.displayFinancialStatus ?? '')
}

/**
 * Map a paid order to its gross feed row. Dates use processedAt (when the
 * money event happened), not createdAt: booked entries, invoice matching, and
 * month boundaries all want the payment date. Descriptions are deterministic
 * from immutable data (order names never change) because the content-dedup
 * bridge keys off them.
 */
export function mapOrder(shopScope: string, order: ShopifyOrder): RawTransaction[] {
  if (!orderQualifies(order)) return []
  const amount = parseAmount(order.totalPriceSet.shopMoney.amount)
  if (amount === null || amount === 0) return []
  return [
    {
      date: isoDateOf(order.processedAt),
      description: `Shopify-order ${order.name}`,
      amount,
      currency: order.totalPriceSet.shopMoney.currencyCode.toUpperCase(),
      external_id: shopifyOrderExternalId(shopScope, order.legacyResourceId),
      import_source: SHOPIFY_IMPORT_SOURCE,
      reference: order.paymentGatewayNames.join(', ') || null,
    },
  ]
}

/** Map one refund of a paid order to its negative feed row. */
export function mapRefund(
  shopScope: string,
  order: Pick<ShopifyOrder, 'name'>,
  refund: ShopifyRefund,
): RawTransaction[] {
  const amount = parseAmount(refund.totalRefundedSet.shopMoney.amount)
  if (amount === null || amount === 0) return []
  return [
    {
      date: isoDateOf(refund.createdAt),
      description: `Shopify-återbetalning order ${order.name}`,
      amount: -amount,
      currency: refund.totalRefundedSet.shopMoney.currencyCode.toUpperCase(),
      external_id: shopifyRefundExternalId(shopScope, refund.legacyResourceId),
      import_source: SHOPIFY_IMPORT_SOURCE,
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
 * Window start (ISO, UTC) for the updated_at filter. With a cursor: cursor
 * minus the 24h overlap. First run: BACKFILL_DAYS back. (The lock date does
 * not floor the window: it selects on updatedAt while rows are dated by
 * processedAt, so the real guard is rowBehindLock at map time, every run.)
 */
function resolveWindowStartIso(connection: ShopifyConnection): string {
  if (connection.last_order_synced_at) {
    const cursorMs = Date.parse(connection.last_order_synced_at)
    return new Date(Math.max(0, cursorMs - CURSOR_OVERLAP_MS)).toISOString()
  }
  return new Date(Date.now() - BACKFILL_DAYS * 86_400_000).toISOString()
}

/**
 * Make sure the store cash account exists (ledger 1584, source manual so a
 * later remap/promotion follows the normal cash-account rules) and, on the
 * first run, that 1584 exists in the chart of accounts: the booking dialog
 * and AccountPicker only list chart accounts.
 *
 * Currency comes from the shop settings read at connect time, falling back to
 * the first fetched order's real currency (guessing SEK for an EUR store
 * would poison the account). A conflict with an existing 1584 cash account
 * throws; the caller surfaces that on the connection so the panel shows why
 * nothing syncs.
 */
async function ensureStoreAccount(
  supabase: SupabaseClient,
  connection: ShopifyConnection,
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
      SHOPIFY_LEDGER_ACCOUNT,
      currency,
      'Shopify-saldo',
    )
  } catch (accountError) {
    // Typically a currency conflict with an existing 1584 cash account. Made
    // visible on the connection: without this the panel shows a healthy
    // "Ansluten" store that silently never syncs.
    await supabase
      .from('shopify_connections')
      .update({
        error_message:
          'Kassakontot för butiken (1584) kunde inte skapas. Kontrollera att befintligt konto 1584 har samma valuta som butiken.',
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
          sourceAccount: SHOPIFY_LEDGER_ACCOUNT,
          sourceName: SHOPIFY_LEDGER_ACCOUNT_NAME,
          targetAccount: SHOPIFY_LEDGER_ACCOUNT,
          targetName: SHOPIFY_LEDGER_ACCOUNT_NAME,
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
      log.warn('chart sync for 1584 failed', {
        companyId: connection.company_id,
        error: sync.error,
      })
    }
  }
}

/** Rows for one page of orders: gross rows plus inline refund rows. */
function buildPageRows(
  shopScope: string,
  orders: ShopifyOrder[],
  lockThrough: string | null,
  summary: ShopifySyncSummary,
  log: Logger,
): RawTransaction[] {
  const rows: RawTransaction[] = []

  const push = (mapped: RawTransaction[]) => {
    for (const row of mapped) {
      if (rowBehindLock(row.date, lockThrough)) {
        summary.skippedLocked += 1
        continue
      }
      rows.push(row)
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
        orderId: order.legacyResourceId,
        total: order.totalPriceSet.shopMoney.amount,
      })
    }
    push(mapOrder(shopScope, order))
    // Refunds only exist in the feed for qualifying (paid) orders: a refund
    // row without its gross counterpart would be an unexplainable negative in
    // the inbox. They come inline on the order (no follow-up request).
    if (!orderQualifies(order)) continue
    for (const refund of order.refunds) {
      summary.refundsFetched += 1
      if (parseAmount(refund.totalRefundedSet.shopMoney.amount) === null) {
        summary.errors += 1
        log.warn('unparseable refund amount; row skipped', {
          orderId: order.legacyResourceId,
          refundId: refund.legacyResourceId,
          amount: refund.totalRefundedSet.shopMoney.amount,
        })
      }
      push(mapRefund(shopScope, order, refund))
    }
  }
  return rows
}

export async function syncShopifyOrders(
  supabase: SupabaseClient,
  connection: ShopifyConnection,
  log: Logger = defaultLog,
  /**
   * Absolute deadline (epoch ms) from the caller's time budget. Enforced
   * between pages: the cursor advances only over fully-processed pages, so
   * the next run resumes exactly where this one stopped.
   */
  deadlineMs?: number,
): Promise<ShopifySyncSummary> {
  const summary: ShopifySyncSummary = {
    fetched: 0,
    refundsFetched: 0,
    imported: 0,
    duplicates: 0,
    skippedLocked: 0,
    errors: 0,
  }
  if (
    connection.status !== 'active' ||
    !connection.client_id_encrypted ||
    !connection.client_secret_encrypted
  ) {
    return summary
  }

  const shopScope = shopifyShopScope(connection.shop_domain)
  const firstRun = !connection.last_order_synced_at
  const lockThrough = await fetchLockThrough(supabase, connection.company_id)

  const runStartMs = Date.now()
  const updatedAtMin = resolveWindowStartIso(connection)
  let after: string | null = null
  let prevCursorMs = connection.last_order_synced_at
    ? Date.parse(connection.last_order_synced_at)
    : 0
  // Earliest incomplete work this run; the persisted cursor never passes it.
  let failureFloorMs = Number.POSITIVE_INFINITY
  // True once the whole window was listed to its end (empty page or last page).
  let windowExhausted = false
  let accountEnsured = false

  try {
    // Token exchange happens up front (the token lives ~24h, far longer than
    // any run); a dead client secret surfaces here as a revoked-classified
    // error before any paging starts.
    const session = await createShopifySession(credentialsOf(connection))

    for (;;) {
      if (deadlineMs !== undefined && Date.now() >= deadlineMs) {
        summary.deadlineReached = true
        log.info('time budget exhausted; stopping order sync', {
          connectionId: connection.id,
          processed: summary.imported + summary.duplicates,
        })
        break
      }

      const page = await listOrdersPage(session, { updatedAtMin, after })
      if (page.orders.length === 0) {
        windowExhausted = true
        break
      }
      summary.fetched += page.orders.length

      // Deferred until the window is known non-empty so a quiet store costs
      // one API call and zero DB writes; also gives us a real order currency
      // as the fallback when the shop currency was unreadable at connect.
      if (!accountEnsured) {
        await ensureStoreAccount(
          supabase,
          connection,
          page.orders[0].totalPriceSet.shopMoney.currencyCode,
          firstRun,
          log,
        )
        accountEnsured = true
      }

      const rows = buildPageRows(shopScope, page.orders, lockThrough, summary, log)

      const firstMs = Date.parse(page.orders[0].updatedAt)
      const lastMs = Date.parse(page.orders[page.orders.length - 1].updatedAt)

      if (rows.length > 0) {
        // Auto-categorization is skipped on purpose: booking Shopify money is
        // a human decision in the inbox (feed-only doctrine, same as the
        // Stripe and WooCommerce feeds). Invoice matching still runs
        // (suggestions only), and FX enrichment covers non-SEK stores.
        const result = await ingestTransactions(
          supabase,
          connection.company_id,
          connection.user_id,
          rows,
          { settlementAccount: SHOPIFY_LEDGER_ACCOUNT, skipAutoCategorization: true },
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

      // Persist the cursor after each page: monotonic (never regresses below
      // the pre-run cursor) and capped by the failure floor. error_message is
      // cleared on progress so a resolved incident stops showing in the panel.
      const candidateMs = Math.min(lastMs, failureFloorMs)
      if (candidateMs > prevCursorMs) {
        const cursorIso = new Date(candidateMs).toISOString()
        await supabase
          .from('shopify_connections')
          .update({ last_order_synced_at: cursorIso, error_message: null })
          .eq('id', connection.id)
        connection.last_order_synced_at = cursorIso
        prevCursorMs = candidateMs
      }

      if (!page.hasNextPage) {
        windowExhausted = true
        break
      }
      after = page.endCursor

      if (summary.fetched >= MAX_ORDERS_PER_RUN) {
        log.warn('order cap reached; remaining orders resume next run', {
          connectionId: connection.id,
          cap: MAX_ORDERS_PER_RUN,
        })
        break
      }
    }

    // Watermark advance: a fully-listed window means "scanned through run
    // start", even when it produced no rows. Without this, an empty first run
    // keeps a NULL cursor forever, and the cron's oldest-first selection
    // (nullsFirst, limit 50) lets quiet stores permanently occupy the batch
    // and starve other connections. Capped by the failure floor like every
    // other cursor write; the 24h overlap re-poll still covers updates that
    // landed while the run was in flight.
    if (windowExhausted) {
      const watermarkMs = Math.min(runStartMs, failureFloorMs)
      if (watermarkMs > prevCursorMs) {
        const cursorIso = new Date(watermarkMs).toISOString()
        await supabase
          .from('shopify_connections')
          .update({ last_order_synced_at: cursorIso, error_message: null })
          .eq('id', connection.id)
        connection.last_order_synced_at = cursorIso
        prevCursorMs = watermarkMs
      }
    }
  } catch (err) {
    if (isRevokedCredentialsError(err)) {
      // The app was deleted or its secret rotated in the Dev Dashboard: flip
      // the connection so the UI offers a reconnect instead of the cron
      // retrying forever.
      summary.revoked = true
      await supabase
        .from('shopify_connections')
        .update({
          status: 'revoked',
          error_message: 'Butiken avvisade appens uppgifter. Anslut butiken igen.',
          // The store already rejected these; keeping decryptable dead
          // credentials would be pure data retention (same as /disconnect).
          client_id_encrypted: null,
          client_secret_encrypted: null,
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
  log.info('shopify order sync done', {
    connectionId: connection.id,
    ...summary,
  })
  return summary
}
