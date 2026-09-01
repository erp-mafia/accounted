import type { SupabaseClient } from '@supabase/supabase-js'
import { removeWebshopOrders, upsertWebshopOrders } from '@/lib/webshop-orders/ingest'
import type { WebshopOrderUpsert } from '@/lib/webshop-orders/types'
import { createLogger, type Logger } from '@/lib/logger'
import { roundOre as round } from '@/lib/money'
import type { WebshopOrderLineItem, WebshopVatBreakdownLine } from '@/types'
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
 * WooCommerce order sync: the store's orders and refunds as rich rows in
 * public.webshop_orders (the Orders page), replacing the earlier
 * transactions-inbox feed.
 *
 * Every order imports except trash and failed (including unpaid ones: the
 * Orders page shows order state and the invoice flow needs pre-payment
 * orders), carrying the
 * full booking underlag the wc/v3 payload already contains: customer billing
 * snapshot, payment method, per-rate VAT breakdown and line items. Refunds
 * are separate negative rows parented to their order. Nothing here books
 * anything: booking is a manual per-order act on the Orders page (feed-only
 * doctrine, same as before, one table over).
 *
 * The write path is upsertWebshopOrders() (lib/webshop-orders/ingest), which
 * owns FX enrichment, the frozen-row rules for booked orders and the
 * cross-mark against rows the retired transactions feed already imported.
 * Rows already imported as transactions stay bookable there; the external_id
 * scheme below is shared with that feed precisely so the overlap is a string
 * join.
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
 * overlap. Overlap re-polls are how status changes, late date_paid and new
 * refunds land: they are real upserts now, not dedup no-ops. The cursor
 * never advances past failed work: a page with refund-fetch failures, upsert
 * errors, or deadline-skipped refunds caps the persisted cursor just below
 * the earliest affected order's date_modified, so the next run re-lists
 * exactly the orders whose rows are incomplete. First run fetches
 * BACKFILL_DAYS back.
 *
 * Rows behind company_settings.bookkeeping_locked_through import too (the
 * page is an order overview, not just a booking queue); the booking route
 * and the period-lock triggers refuse to BOOK them, and the UI explains why.
 */

/** transactions.import_source the retired feed used; kept for reference. */
export const WOOCOMMERCE_IMPORT_SOURCE = 'woocommerce'
/** First-run backfill window (matches the Enable Banking convention). */
export const BACKFILL_DAYS = 90
/** Cursor re-poll overlap; upsert-on-external_id makes overlaps idempotent. */
const CURSOR_OVERLAP_MS = 24 * 60 * 60 * 1000
/**
 * Safety cap on orders per run (matches the Stripe feed's MAX_TXNS_PER_RUN).
 * The real bound is the caller's deadline; hitting this cap is logged loudly
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
  /** New webshop_orders rows inserted. */
  inserted: number
  /** Existing rows refreshed (status, refunds, billing, FX). */
  updated: number
  /** Re-polled rows with nothing new. */
  unchanged: number
  /** Rows deleted because the store now reports the order as failed. */
  removed: number
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
 * Money fields arrive as strings; unparseable input returns null so callers
 * can tell a corrupt total (counted + logged) from a legitimate zero.
 */
function parseAmount(value: string): number | null {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? round(parsed) : null
}

/** Whether an order's total cannot be read as money. */
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

/** Whether the order has been paid (drives is_paid and refund fetching). */
export function orderIsPaid(order: Pick<WooOrder, 'date_paid_gmt'>): boolean {
  return Boolean(order.date_paid_gmt)
}

/**
 * Which orders exist in the feed. Trash is the store's recycle bin; failed
 * is a checkout whose payment never went through, so it carries no money
 * event (user report: failed attempts flooded the Orders page as permanently
 * unbookable "Ej betald" rows).
 */
export function orderImports(order: Pick<WooOrder, 'status'>): boolean {
  return order.status !== 'trash' && order.status !== 'failed'
}

/**
 * Orders whose already-imported rows should be REMOVED on re-poll: a pending
 * order that transitions to failed would otherwise sit stale forever. A
 * failed order that has a date_paid is NOT removed (skeptic finding): money
 * moved at some point (gateway void, admin bulk-edit mistake), and deleting
 * the row would hide a possibly real money event, the same reason trash
 * keeps its long-standing skip-only semantics.
 */
export function orderRemoves(order: Pick<WooOrder, 'status' | 'date_paid_gmt'>): boolean {
  return order.status === 'failed' && !orderIsPaid(order)
}

/**
 * Best-effort Swedish orgnr from the billing company field or B2B-plugin
 * meta. NEVER trusted for legal invoice fields without user confirmation:
 * plugins vary and customers typo.
 */
export function extractOrgnr(order: Pick<WooOrder, 'billing' | 'meta_data'>): string | null {
  const ORGNR = /(\d{6})[-\s]?(\d{4})/
  const fromCompany = order.billing?.company?.match(ORGNR)
  if (fromCompany) return `${fromCompany[1]}-${fromCompany[2]}`
  for (const meta of order.meta_data ?? []) {
    if (typeof meta.value !== 'string') continue
    if (!/org(anisations)?[._\s-]*n(umme)?r/i.test(meta.key)) continue
    const match = meta.value.match(ORGNR)
    if (match) return `${match[1]}-${match[2]}`
  }
  return null
}

/** A money-bearing part of an order: product line, shipping or fee. */
interface WooTaxablePart {
  total: string
  total_tax: string
  taxes?: Array<{ id: number; total: string }>
}

function rateMapOf(order: Pick<WooOrder, 'tax_lines'>): Map<number, number> {
  const rateByTaxId = new Map<number, number>()
  for (const taxLine of order.tax_lines ?? []) {
    if (typeof taxLine.rate_percent === 'number') {
      rateByTaxId.set(taxLine.rate_id, taxLine.rate_percent)
    }
  }
  return rateByTaxId
}

/** Resolve one part's VAT rate: tax_lines join first, own ratio second. */
function rateOfPart(part: WooTaxablePart, rateByTaxId: Map<number, number>): number {
  const net = parseAmount(part.total) ?? 0
  const tax = parseAmount(part.total_tax) ?? 0
  const taxId = part.taxes?.find((t) => parseAmount(t.total) !== null)?.id
  const joined = taxId !== undefined ? rateByTaxId.get(taxId) : undefined
  if (joined !== undefined) return joined
  // Signed ratio: a negative discount line at 25% has tax/net > 0 too.
  return tax !== 0 && net !== 0
    ? ([25, 12, 6].find((r) => Math.abs(tax / net - r / 100) < 0.01) ?? 25)
    : 0
}

/**
 * Group the order's line, shipping and fee taxes into per-rate buckets.
 * Buckets carry SIGNED amounts: a discount/gift-card line contributes a
 * negative net so the booking split books it as a revenue reduction, not
 * flipped revenue. When the payload carries no usable tax data at all but
 * the order total says tax was charged (hardened stores stripping tax
 * detail), returns [] and the booking dialog falls back to ratio inference.
 */
export function buildVatBreakdown(order: WooOrder): WebshopVatBreakdownLine[] {
  const rateByTaxId = rateMapOf(order)

  const buckets = new Map<number, { net: number; tax: number }>()
  const add = (rate: number, net: number, tax: number) => {
    const bucket = buckets.get(rate) ?? { net: 0, tax: 0 }
    bucket.net = round(bucket.net + net)
    bucket.tax = round(bucket.tax + tax)
    buckets.set(rate, bucket)
  }

  const parts: WooTaxablePart[] = [
    ...(order.line_items ?? []),
    ...(order.shipping_lines ?? []),
    ...(order.fee_lines ?? []),
  ]
  if (parts.length === 0) return []

  // "Tax data" means an actual per-line tax allocation. wc/v3 serializes
  // `taxes: []` on every line even when the store hides tax detail, so an
  // empty array proves nothing; a non-empty taxes array or a non-zero
  // total_tax does.
  let sawTaxData = false
  for (const part of parts) {
    const net = parseAmount(part.total) ?? 0
    const tax = parseAmount(part.total_tax) ?? 0
    if ((part.taxes && part.taxes.length > 0) || tax !== 0) sawTaxData = true
    add(rateOfPart(part, rateByTaxId), net, tax)
  }

  const orderTax = parseAmount(order.total_tax) ?? 0
  if (!sawTaxData && orderTax > 0) return []

  return Array.from(buckets.entries())
    .filter(([, { net, tax }]) => net !== 0 || tax !== 0)
    .map(([rate, { net, tax }]) => ({ rate, net, tax }))
    .sort((a, b) => b.rate - a.rate)
}

/**
 * VAT buckets for one refund. Preference order:
 * 1. The refund's own line allocation (line_items with negative totals):
 *    grouped exactly like the order's parts; magnitudes are returned
 *    positive (the refund row's row_type carries the direction).
 * 2. Amount-only refunds: prorate the PARENT order's breakdown by
 *    refund/order ratio, so the VAT reversal follows the sale's actual mix.
 *    Never returns a confident 0%-bucket for a sale that carried VAT: that
 *    would book a refund with no moms reversal (skeptic finding).
 */
export function buildRefundVatBreakdown(
  order: WooOrder,
  refund: WooRefund,
): { breakdown: WebshopVatBreakdownLine[]; totalTax: number } {
  const rateByTaxId = rateMapOf(order)
  const refundParts = (refund.line_items ?? []).filter(
    (part) => (parseAmount(part.total) ?? 0) !== 0 || (parseAmount(part.total_tax) ?? 0) !== 0,
  )

  if (refundParts.length > 0) {
    const buckets = new Map<number, { net: number; tax: number }>()
    for (const part of refundParts) {
      const net = Math.abs(parseAmount(part.total) ?? 0)
      const tax = Math.abs(parseAmount(part.total_tax) ?? 0)
      const rate = rateOfPart(part, rateByTaxId)
      const bucket = buckets.get(rate) ?? { net: 0, tax: 0 }
      bucket.net = round(bucket.net + net)
      bucket.tax = round(bucket.tax + tax)
      buckets.set(rate, bucket)
    }
    const breakdown = Array.from(buckets.entries())
      .map(([rate, { net, tax }]) => ({ rate, net, tax }))
      .sort((a, b) => b.rate - a.rate)
    const totalTax = round(breakdown.reduce((sum, b) => sum + b.tax, 0))
    return { breakdown, totalTax }
  }

  // Amount-only refund: prorate the order's mix. Per-bucket rounding drift
  // lands on the booking's 3740 residual line.
  const orderBreakdown = buildVatBreakdown(order)
  const orderTotal = Math.abs(parseAmount(order.total) ?? 0)
  const refundAmount = Math.abs(parseAmount(refund.amount) ?? 0)
  if (orderBreakdown.length === 0 || orderTotal === 0 || refundAmount === 0) {
    return { breakdown: [], totalTax: 0 }
  }
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

/**
 * The stored line snapshot covers EVERYTHING inside order.total: product
 * lines, shipping and fees. The invoice conversion builds its rows from
 * this snapshot, so an omitted shipping line would silently shrink the
 * customer's invoice (skeptic finding).
 */
function mapLineItems(order: WooOrder): WebshopOrderLineItem[] {
  const rateByTaxId = rateMapOf(order)
  const rateOrNull = (part: WooTaxablePart): number | null => {
    const taxId = part.taxes?.find((t) => parseAmount(t.total) !== null)?.id
    return taxId !== undefined ? (rateByTaxId.get(taxId) ?? null) : null
  }
  const products = (order.line_items ?? []).map((item) => ({
    name: item.name,
    quantity: item.quantity,
    total: parseAmount(item.total) ?? 0,
    total_tax: parseAmount(item.total_tax) ?? 0,
    vat_rate: rateOrNull(item),
  }))
  const shipping = (order.shipping_lines ?? [])
    .filter((line) => (parseAmount(line.total) ?? 0) !== 0)
    .map((line) => ({
      name: line.method_title || 'Frakt',
      quantity: 1,
      total: parseAmount(line.total) ?? 0,
      total_tax: parseAmount(line.total_tax) ?? 0,
      vat_rate: rateOrNull(line),
    }))
  const fees = (order.fee_lines ?? [])
    .filter((line) => (parseAmount(line.total) ?? 0) !== 0)
    .map((line) => ({
      name: line.name || 'Avgift',
      quantity: 1,
      total: parseAmount(line.total) ?? 0,
      total_tax: parseAmount(line.total_tax) ?? 0,
      vat_rate: rateOrNull(line),
    }))
  return [...products, ...shipping, ...fees]
}

function customerName(order: WooOrder): string | null {
  const name = [order.billing?.first_name, order.billing?.last_name]
    .filter(Boolean)
    .join(' ')
    .trim()
  return name || null
}

/** Sum of refund totals (positive) reported inline on the order. */
function refundedTotal(order: WooOrder): number {
  let sum = 0
  for (const refund of order.refunds ?? []) {
    const amount = parseAmount(refund.total)
    if (amount !== null) sum = round(sum + Math.abs(amount))
  }
  return sum
}

/** Map one order to its webshop_orders upsert row. */
export function mapOrderToWebshopRow(
  connection: Pick<WooCommerceConnection, 'id' | 'store_name'>,
  storeScope: string,
  order: WooOrder,
): WebshopOrderUpsert[] {
  if (!orderImports(order)) return []
  const total = parseAmount(order.total)
  // Zero-total orders (100% coupon) carry no bookable money event; importing
  // them would strand an unbookable "Att bokföra" row (the engine refuses
  // zero-sum entries and feed rows are undeletable).
  if (total === null || total === 0) return []
  return [
    {
      platform: 'woocommerce',
      store_scope: storeScope,
      store_label: connection.store_name,
      connection_id: connection.id,
      row_type: 'order',
      parent_external_id: null,
      external_id: wooOrderExternalId(storeScope, order.id),
      platform_order_id: String(order.id),
      order_number: order.number,
      status: order.status,
      is_paid: orderIsPaid(order),
      order_date: isoDateOfGmt(order.date_created_gmt),
      paid_date: order.date_paid_gmt ? isoDateOfGmt(order.date_paid_gmt) : null,
      currency: order.currency.toUpperCase(),
      total,
      total_tax: parseAmount(order.total_tax) ?? 0,
      vat_breakdown: buildVatBreakdown(order),
      line_items: mapLineItems(order),
      customer_name: customerName(order),
      customer_company: order.billing?.company || null,
      customer_email: order.billing?.email || null,
      customer_orgnr: extractOrgnr(order),
      customer_country: order.billing?.country?.toUpperCase() || null,
      payment_method: order.payment_method || null,
      payment_method_title: order.payment_method_title || null,
      gateway_reference: order.transaction_id || null,
      refunded_total: refundedTotal(order),
    },
  ]
}

/** Map one refund of a paid order to its negative upsert row. */
export function mapRefundToWebshopRow(
  connection: Pick<WooCommerceConnection, 'id' | 'store_name'>,
  storeScope: string,
  order: WooOrder,
  refund: WooRefund,
): WebshopOrderUpsert[] {
  const amount = parseAmount(refund.amount)
  if (amount === null || amount === 0) return []
  // The refund's VAT reversal: from its own line allocation, else prorated
  // from the parent order's mix. Without this the refund books with zero
  // moms and ruta 10 stays over-declared (skeptic finding). Buckets hold
  // positive magnitudes; row_type 'refund' carries the direction, and
  // total/total_tax are negative like the money movement.
  const { breakdown, totalTax } = buildRefundVatBreakdown(order, refund)
  return [
    {
      platform: 'woocommerce',
      store_scope: storeScope,
      store_label: connection.store_name,
      connection_id: connection.id,
      row_type: 'refund',
      parent_external_id: wooOrderExternalId(storeScope, order.id),
      external_id: wooRefundExternalId(storeScope, refund.id),
      platform_order_id: String(refund.id),
      order_number: order.number,
      status: 'refund',
      is_paid: true,
      order_date: isoDateOfGmt(refund.date_created_gmt),
      paid_date: isoDateOfGmt(refund.date_created_gmt),
      currency: order.currency.toUpperCase(),
      total: -Math.abs(amount),
      total_tax: -totalTax,
      vat_breakdown: breakdown,
      line_items: [],
      customer_name: customerName(order),
      customer_company: order.billing?.company || null,
      customer_email: order.billing?.email || null,
      customer_orgnr: extractOrgnr(order),
      customer_country: order.billing?.country?.toUpperCase() || null,
      payment_method: order.payment_method || null,
      payment_method_title: order.payment_method_title || null,
      gateway_reference: null,
      refunded_total: 0,
    },
  ]
}

interface PageRowsOutcome {
  rows: WebshopOrderUpsert[]
  /** external_ids of orders whose existing rows should be removed (failed). */
  removalExternalIds: string[]
  /**
   * date_modified (ms) of every order whose refund rows are incomplete this
   * run (fetch failed or skipped on deadline). The cursor must not advance
   * past these: the next run has to re-list them.
   */
  incompleteModifiedMs: number[]
  hitDeadline: boolean
}

/** Upsert rows for one page of orders: order rows plus refund rows. */
async function buildPageRows(
  creds: WooCredentials,
  connection: WooCommerceConnection,
  storeScope: string,
  orders: WooOrder[],
  summary: WooCommerceSyncSummary,
  log: Logger,
  deadlineMs?: number,
): Promise<PageRowsOutcome> {
  const outcome: PageRowsOutcome = {
    rows: [],
    removalExternalIds: [],
    incompleteModifiedMs: [],
    hitDeadline: false,
  }

  for (const order of orders) {
    if (orderRemoves(order)) {
      outcome.removalExternalIds.push(wooOrderExternalId(storeScope, order.id))
    }
    // Non-importing orders contribute nothing else; skipping here also keeps
    // their refunds out of the feed. Unreachable for trash in practice (the
    // list call asks for status=any, which excludes trash), and a failed
    // order's refund would parent to a row being removed: an unexplainable
    // negative either way.
    if (!orderImports(order)) continue
    // A corrupt total is counted and logged, never silently identical to a
    // zero-total order. Deliberately NOT held via the cursor: a permanently
    // corrupt total would stall the whole feed forever, where a skipped row
    // plus a loud error can be followed up.
    if (orderAmountUnparseable(order)) {
      summary.errors += 1
      log.warn('unparseable order total; row skipped', {
        orderId: order.id,
        total: order.total,
      })
    }
    outcome.rows.push(...mapOrderToWebshopRow(connection, storeScope, order))
    // Refunds only exist for paid orders; a refund row without its parent
    // would be an unexplainable negative.
    if (!orderIsPaid(order) || (order.refunds?.length ?? 0) === 0) continue

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
        outcome.rows.push(...mapRefundToWebshopRow(connection, storeScope, order, refund))
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

/**
 * Window start (ISO, UTC) for the first modified_after list call. With a
 * cursor: cursor minus the 24h overlap. First run: BACKFILL_DAYS back.
 */
function resolveWindowStartIso(connection: WooCommerceConnection): string {
  if (connection.last_order_synced_at) {
    const cursorMs = Date.parse(connection.last_order_synced_at)
    return new Date(Math.max(0, cursorMs - CURSOR_OVERLAP_MS)).toISOString()
  }
  return new Date(Date.now() - BACKFILL_DAYS * 86_400_000).toISOString()
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
    inserted: 0,
    updated: 0,
    unchanged: 0,
    removed: 0,
    frozenFlagged: 0,
    crossMarked: 0,
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

  let modifiedAfter = resolveWindowStartIso(connection)
  // Offset page within a same-timestamp tie only; 1 whenever the cursor moves.
  let tiePage = 1
  let prevCursorMs = connection.last_order_synced_at
    ? Date.parse(connection.last_order_synced_at)
    : 0
  // Earliest incomplete work this run; the persisted cursor never passes it.
  let failureFloorMs = Number.POSITIVE_INFINITY

  try {
    for (;;) {
      if (deadlineMs !== undefined && Date.now() >= deadlineMs) {
        summary.deadlineReached = true
        log.info('time budget exhausted; stopping order sync', {
          connectionId: connection.id,
          processed: summary.inserted + summary.updated + summary.unchanged,
        })
        break
      }

      const orders = await listOrdersPage(creds, { modifiedAfter, page: tiePage })
      // Termination is an EMPTY page, not a short one: hosts and security
      // plugins may cap per_page below our request, and treating a short page
      // as the end would strand the cursor at the first page forever.
      if (orders.length === 0) break
      summary.fetched += orders.length

      const page = await buildPageRows(
        creds,
        connection,
        storeScope,
        orders,
        summary,
        log,
        deadlineMs,
      )
      if (page.hitDeadline) summary.deadlineReached = true

      const firstMs = gmtToMs(orders[0].date_modified_gmt)
      const lastMs = gmtToMs(orders[orders.length - 1].date_modified_gmt)

      if (page.rows.length > 0) {
        const result = await upsertWebshopOrders(
          supabase,
          connection.company_id,
          connection.user_id,
          page.rows,
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
      if (page.removalExternalIds.length > 0) {
        const removal = await removeWebshopOrders(
          supabase,
          connection.company_id,
          page.removalExternalIds,
        )
        summary.removed += removal.removed
        summary.errors += removal.errors
        if (removal.errors > 0) {
          // Same retry contract as failed upserts: hold the cursor so the
          // next run re-lists this page and retries the removal.
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

  log.info('woocommerce order sync done', {
    connectionId: connection.id,
    ...summary,
  })
  return summary
}
