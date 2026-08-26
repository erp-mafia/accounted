import type { SupabaseClient } from '@supabase/supabase-js'
import { upsertWebshopOrders } from '@/lib/webshop-orders/ingest'
import type { WebshopOrderUpsert } from '@/lib/webshop-orders/types'
import { createLogger, type Logger } from '@/lib/logger'
import { roundOre as round } from '@/lib/money'
import type { WebshopOrderLineItem, WebshopVatBreakdownLine } from '@/types'
import {
  createShopifySession,
  isRevokedCredentialsError,
  listOrdersPage,
} from './api-client'
import { credentialsOf } from './credentials'
import type {
  ShopifyConnection,
  ShopifyOrder,
  ShopifyRefund,
  ShopifyTaxLine,
} from '../types'

const defaultLog = createLogger('shopify/order-sync')

/**
 * Shopify order sync: the store's paid orders and refunds as rich rows in
 * public.webshop_orders (the Orders page), replacing the earlier
 * transactions-inbox feed (which shipped but was never enabled for real
 * stores: prod holds zero Shopify feed rows, so no legacy cross-marking is
 * ever expected here).
 *
 * Row model: only PAID orders import (PAID / PARTIALLY_REFUNDED / REFUNDED;
 * a deliberate difference from the WooCommerce sync, which also imports
 * unpaid orders for the invoice flow). AUTHORIZED/PENDING orders re-surface
 * via updatedAt once payment captures. Each refund of a paid order is a
 * separate negative row parented to its order. Rows carry the booking
 * underlag the Admin API exposes without touching Shopify's protected
 * customer data program: per-rate VAT, a line-item snapshot, gateway names.
 * Customer fields stay null (deliberate v1 decision): booking works, and
 * "Skapa faktura" starts without a prefilled customer. Nothing here books
 * anything (feed-only doctrine, same as the WooCommerce and Stripe feeds).
 *
 * The write path is upsertWebshopOrders() (lib/webshop-orders/ingest), which
 * owns FX enrichment, the frozen-row rules for booked orders and the
 * cross-mark against the retired transactions feed. Overlap re-polls are
 * real upserts now (growing refund totals, status flips), not dedup no-ops.
 *
 * Rows behind company_settings.bookkeeping_locked_through import too (the
 * page is an order overview, not just a booking queue; unlike the retired
 * inbox feed, an unbookable webshop_orders row is not permanent noise). The
 * booking route and the period-lock triggers refuse to BOOK them.
 *
 * Pagination: one fixed updated_at window per run, walked with Relay cursors
 * (sortKey UPDATED_AT ascending). Cursors are stable across same-second ties,
 * so there is no offset fallback (unlike the WooCommerce sync). The persisted
 * cursor is shopify_connections.last_order_synced_at: per page the max
 * updatedAt processed, and after a fully-listed window the run's start time
 * (a scanned-through watermark, so quiet and empty-first-run stores still
 * rotate to the back of the cron's oldest-first selection). Re-polled with a
 * 24h overlap; upsert-on-(company_id, external_id) makes overlaps idempotent.
 * It never advances past failed work: a page with upsert errors caps the
 * persisted cursor just below the page's first updatedAt, so the next run
 * re-lists exactly the orders whose rows are incomplete. First run fetches
 * BACKFILL_DAYS back.
 */

/** transactions.import_source the retired feed used; kept for reference. */
export const SHOPIFY_IMPORT_SOURCE = 'shopify'
/** First-run backfill window (matches the WooCommerce/Enable Banking convention). */
export const BACKFILL_DAYS = 90
/** Cursor re-poll overlap; upsert-on-external_id makes overlaps idempotent. */
const CURSOR_OVERLAP_MS = 24 * 60 * 60 * 1000
/**
 * Safety cap on orders per run (matches the Stripe/WooCommerce feeds). The
 * real bound is the caller's deadline; hitting this cap is logged loudly
 * because a silent cap reads as "covered everything" when it did not. The
 * cursor resumes where a truncated run stopped.
 */
const MAX_ORDERS_PER_RUN = 10_000

/**
 * ⚠️ STORED-KEY FORMATS. These are persisted to webshop_orders.external_id
 * (and historically to transactions.external_id by the retired feed; the
 * cross-mark join depends on the schemes staying byte-identical). Changing a
 * template silently orphans every prior row and re-imports the whole feed on
 * the next sync. Locked by the frozen-format test in order-sync.test.ts; any
 * change MUST ship a coordinated backfill.
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
  /** New webshop_orders rows inserted. */
  inserted: number
  /** Existing rows refreshed (status, refunds, FX). */
  updated: number
  /** Re-polled rows with nothing new. */
  unchanged: number
  /** Booked rows whose financials drifted remotely (flagged, not touched). */
  frozenFlagged: number
  /** Rows linked to a row the retired transactions feed already imported. */
  crossMarked: number
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
  return Number.isFinite(parsed) ? round(parsed) : null
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
 * Tolerance (in the order's currency) for reconstruction drift. Derived nets
 * (tax / rate) can be a few öre off per rate; anything inside the tolerance
 * is left for the booking's 3740 residual line instead of fabricating a
 * 0%-sale, and a larger gap means the data is telling us something real.
 */
const VAT_REMAINDER_TOLERANCE = 0.5

/**
 * Per-rate VAT buckets reconstructed from the ORDER-LEVEL taxLines. Shopify
 * reports the tax charged per rate but no per-rate net, so the net is derived
 * arithmetically: net = tax / rate. The derivation is exact to within öre
 * rounding (Shopify computes each tax from its taxable net) and, unlike
 * summing line items, immune to cart-level discount allocations, line-item
 * pagination truncation and the taxesIncluded mode. Whatever the buckets do
 * not cover (zero-rated goods, tips) becomes a 0%-bucket via the remainder
 * against the charged total. Returns [] when the tax data is unusable (a
 * charged tax without a reported rate, or buckets exceeding the total): the
 * booking dialog then falls back to ratio inference, same as the WooCommerce
 * hardened-store case.
 */
export function buildVatBreakdown(
  order: Pick<ShopifyOrder, 'totalPriceSet' | 'taxLines'>,
): WebshopVatBreakdownLine[] {
  const total = parseAmount(order.totalPriceSet.shopMoney.amount)
  if (total === null || total === 0) return []

  const buckets = new Map<number, { net: number; tax: number }>()
  for (const taxLine of order.taxLines ?? []) {
    const tax = parseAmount(taxLine.priceSet.shopMoney.amount)
    if (tax === null || tax === 0) continue
    // A charged tax whose rate Shopify does not report cannot be bucketed;
    // a partial breakdown would book too little moms, so refuse the whole
    // breakdown instead.
    if (typeof taxLine.ratePercentage !== 'number' || taxLine.ratePercentage <= 0) {
      return []
    }
    const rate = taxLine.ratePercentage
    const bucket = buckets.get(rate) ?? { net: 0, tax: 0 }
    bucket.net = round(bucket.net + tax / (rate / 100))
    bucket.tax = round(bucket.tax + tax)
    buckets.set(rate, bucket)
  }

  const breakdown = Array.from(buckets.entries())
    .map(([rate, { net, tax }]) => ({ rate, net, tax }))
    .sort((a, b) => b.rate - a.rate)
  const covered = round(breakdown.reduce((sum, b) => sum + b.net + b.tax, 0))
  const remainder = round(total - covered)
  if (remainder < -VAT_REMAINDER_TOLERANCE) return []
  if (remainder > VAT_REMAINDER_TOLERANCE) {
    breakdown.push({ rate: 0, net: remainder, tax: 0 })
  }
  return breakdown
}

/**
 * VAT buckets for one refund: the PARENT order's breakdown prorated by
 * refund/order ratio, so the VAT reversal follows the sale's actual mix and
 * a refund never books without a moms reversal (the WooCommerce skeptic
 * finding). Shopify's Refund object reports no per-rate tax without paging a
 * refundLineItems connection per refund, so proration is the whole strategy
 * here, not just the amount-only fallback it is for WooCommerce. Magnitudes
 * are returned positive; row_type 'refund' carries the direction.
 *
 * When per-rate bucketing is refused (parent breakdown []), the parent's
 * TOTAL tax is still prorated into totalTax: the refund row then carries the
 * moms reversal through the booking dialog's ratio-inference fallback as an
 * editable bucket, instead of silently prefilling a 0%-refund whose reversal
 * never reaches 2611 (review finding, PR #1676).
 */
export function buildRefundVatBreakdown(
  order: Pick<ShopifyOrder, 'totalPriceSet' | 'taxLines'>,
  refund: ShopifyRefund,
): { breakdown: WebshopVatBreakdownLine[]; totalTax: number } {
  const orderBreakdown = buildVatBreakdown(order)
  const orderTotal = Math.abs(parseAmount(order.totalPriceSet.shopMoney.amount) ?? 0)
  const refundAmount = Math.abs(parseAmount(refund.totalRefundedSet.shopMoney.amount) ?? 0)
  if (orderTotal === 0 || refundAmount === 0) {
    return { breakdown: [], totalTax: 0 }
  }
  if (orderBreakdown.length === 0) {
    const parentTax = partTax(order.taxLines ?? [])
    const ratio = refundAmount / orderTotal
    return { breakdown: [], totalTax: parentTax > 0 ? round(parentTax * ratio) : 0 }
  }
  // Per-bucket rounding drift lands on the booking's 3740 residual line.
  const ratio = refundAmount / orderTotal
  const breakdown = orderBreakdown
    .map(({ rate, net, tax }) => ({
      rate,
      net: round(net * ratio),
      tax: round(tax * ratio),
    }))
    .filter(({ net, tax }) => net !== 0 || tax !== 0)
  const totalTax = round(breakdown.reduce((sum, b) => sum + b.tax, 0))
  return { breakdown, totalTax }
}

/** Sum of one part's tax lines. */
function partTax(taxLines: ShopifyTaxLine[]): number {
  return round(
    taxLines.reduce((sum, t) => sum + (parseAmount(t.priceSet.shopMoney.amount) ?? 0), 0),
  )
}

/** The part's single VAT rate, 0 when untaxed, null when mixed/unreported. */
function partRate(taxLines: ShopifyTaxLine[]): number | null {
  const rates = new Set<number>()
  for (const line of taxLines) {
    if ((parseAmount(line.priceSet.shopMoney.amount) ?? 0) === 0) continue
    if (typeof line.ratePercentage !== 'number') return null
    rates.add(line.ratePercentage)
  }
  if (rates.size === 0) return 0
  return rates.size === 1 ? Array.from(rates)[0] : null
}

/**
 * The stored line snapshot covers EVERYTHING inside order.total (product
 * lines + shipping) or nothing. The invoice conversion builds its rows from
 * this snapshot, so a diverging one would silently bill the customer the
 * wrong amount (the WooCommerce skeptic finding, one platform over). Two
 * things make Shopify's parts diverge: truncated line-item pages, and
 * cart-level discounts (discountedTotalSet only subtracts line-level
 * discounts). Both are caught by the öre-exact sum check below; a dropped
 * snapshot falls back to one aggregate order line at conversion time, which
 * is always total-correct. Line totals are stored NET (the invoice
 * conversion applies vat_rate on top), decomposed per the shop's
 * taxesIncluded mode.
 */
export function mapLineItems(order: ShopifyOrder): WebshopOrderLineItem[] {
  if (order.lineItems.pageInfo.hasNextPage || order.shippingLines.pageInfo.hasNextPage) {
    return []
  }

  const items: WebshopOrderLineItem[] = []
  for (const item of order.lineItems.nodes) {
    const base = parseAmount(item.discountedTotalSet.shopMoney.amount)
    if (base === null) return []
    const tax = partTax(item.taxLines)
    items.push({
      name: item.name,
      quantity: item.quantity,
      total: order.taxesIncluded ? round(base - tax) : base,
      total_tax: tax,
      vat_rate: partRate(item.taxLines),
    })
  }
  for (const line of order.shippingLines.nodes) {
    const base = parseAmount(line.discountedPriceSet.shopMoney.amount)
    if (base === null) return []
    const tax = partTax(line.taxLines)
    if (base === 0 && tax === 0) continue
    items.push({
      name: line.title || 'Frakt',
      quantity: 1,
      total: order.taxesIncluded ? round(base - tax) : base,
      total_tax: tax,
      vat_rate: partRate(line.taxLines),
    })
  }

  const total = parseAmount(order.totalPriceSet.shopMoney.amount) ?? 0
  const covered = round(items.reduce((sum, i) => sum + i.total + i.total_tax, 0))
  if (Math.abs(covered - total) > 0.005) return []
  return items
}

/** Sum of refund totals (positive) reported inline on the order. */
function refundedTotal(order: ShopifyOrder): number {
  let sum = 0
  for (const refund of order.refunds ?? []) {
    const amount = parseAmount(refund.totalRefundedSet.shopMoney.amount)
    if (amount !== null) sum = round(sum + Math.abs(amount))
  }
  return sum
}

/** Row status: the financial status lowercased (paid, partially_refunded, …). */
function orderStatus(order: ShopifyOrder): string {
  return (order.displayFinancialStatus ?? 'paid').toLowerCase()
}

/** Map one paid order to its webshop_orders upsert row. */
export function mapOrderToWebshopRow(
  connection: Pick<ShopifyConnection, 'id' | 'shop_name'>,
  shopScope: string,
  order: ShopifyOrder,
): WebshopOrderUpsert[] {
  if (!orderQualifies(order)) return []
  const total = parseAmount(order.totalPriceSet.shopMoney.amount)
  // Zero-total orders (100% discount) carry no bookable money event;
  // importing them would strand an unbookable "Att bokföra" row (the engine
  // refuses zero-sum entries).
  if (total === null || total === 0) return []
  return [
    {
      platform: 'shopify',
      store_scope: shopScope,
      store_label: connection.shop_name,
      connection_id: connection.id,
      row_type: 'order',
      parent_external_id: null,
      external_id: shopifyOrderExternalId(shopScope, order.legacyResourceId),
      platform_order_id: order.legacyResourceId,
      order_number: order.name,
      status: orderStatus(order),
      is_paid: true,
      order_date: isoDateOf(order.createdAt),
      paid_date: isoDateOf(order.processedAt),
      currency: order.totalPriceSet.shopMoney.currencyCode.toUpperCase(),
      total,
      total_tax: partTax(order.taxLines),
      vat_breakdown: buildVatBreakdown(order),
      line_items: mapLineItems(order),
      // Deliberately null (v1): customer fields sit behind Shopify's
      // protected customer data program. The Orders page shows "–" and
      // "Skapa faktura" starts without a prefilled customer.
      customer_name: null,
      customer_company: null,
      customer_email: null,
      customer_orgnr: null,
      customer_country: null,
      payment_method: order.paymentGatewayNames[0] ?? null,
      payment_method_title: order.paymentGatewayNames.join(', ') || null,
      gateway_reference: null,
      refunded_total: refundedTotal(order),
    },
  ]
}

/** Map one refund of a paid order to its negative upsert row. */
export function mapRefundToWebshopRow(
  connection: Pick<ShopifyConnection, 'id' | 'shop_name'>,
  shopScope: string,
  order: ShopifyOrder,
  refund: ShopifyRefund,
): WebshopOrderUpsert[] {
  const amount = parseAmount(refund.totalRefundedSet.shopMoney.amount)
  if (amount === null || amount === 0) return []
  const { breakdown, totalTax } = buildRefundVatBreakdown(order, refund)
  return [
    {
      platform: 'shopify',
      store_scope: shopScope,
      store_label: connection.shop_name,
      connection_id: connection.id,
      row_type: 'refund',
      parent_external_id: shopifyOrderExternalId(shopScope, order.legacyResourceId),
      external_id: shopifyRefundExternalId(shopScope, refund.legacyResourceId),
      platform_order_id: refund.legacyResourceId,
      order_number: order.name,
      status: 'refund',
      is_paid: true,
      order_date: isoDateOf(refund.createdAt),
      paid_date: isoDateOf(refund.createdAt),
      currency: refund.totalRefundedSet.shopMoney.currencyCode.toUpperCase(),
      total: -Math.abs(amount),
      total_tax: -totalTax,
      vat_breakdown: breakdown,
      line_items: [],
      customer_name: null,
      customer_company: null,
      customer_email: null,
      customer_orgnr: null,
      customer_country: null,
      payment_method: order.paymentGatewayNames[0] ?? null,
      payment_method_title: order.paymentGatewayNames.join(', ') || null,
      gateway_reference: null,
      refunded_total: 0,
    },
  ]
}

/** Upsert rows for one page of orders: order rows plus inline refund rows. */
function buildPageRows(
  connection: ShopifyConnection,
  shopScope: string,
  orders: ShopifyOrder[],
  summary: ShopifySyncSummary,
  log: Logger,
): WebshopOrderUpsert[] {
  const rows: WebshopOrderUpsert[] = []

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
    rows.push(...mapOrderToWebshopRow(connection, shopScope, order))
    // Refunds only exist in the feed for qualifying (paid) orders: a refund
    // row without its parent would be an unexplainable negative. They come
    // inline on the order (no follow-up request).
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
      rows.push(...mapRefundToWebshopRow(connection, shopScope, order, refund))
    }
  }
  return rows
}

/**
 * Window start (ISO, UTC) for the updated_at filter. With a cursor: cursor
 * minus the 24h overlap. First run: BACKFILL_DAYS back.
 */
function resolveWindowStartIso(connection: ShopifyConnection): string {
  if (connection.last_order_synced_at) {
    const cursorMs = Date.parse(connection.last_order_synced_at)
    return new Date(Math.max(0, cursorMs - CURSOR_OVERLAP_MS)).toISOString()
  }
  return new Date(Date.now() - BACKFILL_DAYS * 86_400_000).toISOString()
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
    inserted: 0,
    updated: 0,
    unchanged: 0,
    frozenFlagged: 0,
    crossMarked: 0,
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
          processed: summary.inserted + summary.updated + summary.unchanged,
        })
        break
      }

      const page = await listOrdersPage(session, { updatedAtMin, after })
      if (page.orders.length === 0) {
        windowExhausted = true
        break
      }
      summary.fetched += page.orders.length

      const rows = buildPageRows(connection, shopScope, page.orders, summary, log)

      const firstMs = Date.parse(page.orders[0].updatedAt)
      const lastMs = Date.parse(page.orders[page.orders.length - 1].updatedAt)

      if (rows.length > 0) {
        const result = await upsertWebshopOrders(
          supabase,
          connection.company_id,
          connection.user_id,
          rows,
        )
        summary.inserted += result.inserted
        summary.updated += result.updated
        summary.unchanged += result.unchanged
        summary.frozenFlagged += result.frozenFlagged
        summary.crossMarked += result.crossMarked
        summary.errors += result.errors
        if (result.errors > 0) {
          // Failed upserts are dropped inside the service; hold the cursor
          // below this page so the next run re-lists and retries it rather
          // than turning a transient DB error into permanently missing rows.
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

  log.info('shopify order sync done', {
    connectionId: connection.id,
    ...summary,
  })
  return summary
}
