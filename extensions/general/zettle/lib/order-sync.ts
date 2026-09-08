import type { SupabaseClient } from '@supabase/supabase-js'
import { upsertWebshopOrders } from '@/lib/webshop-orders/ingest'
import type { WebshopOrderUpsert } from '@/lib/webshop-orders/types'
import { createLogger, type Logger } from '@/lib/logger'
import { roundOre as round } from '@/lib/money'
import type { WebshopOrderLineItem, WebshopVatBreakdownLine } from '@/types'
import { isRevokedCredentialsError, listPurchasesPage } from './api-client'
import { encryptCredential, refreshTokenOf } from './credentials'
import { isRevokedOAuthError, refreshAccessToken } from './oauth'
import type { ZettleConnection, ZettlePayment, ZettlePurchase } from '../types'

const defaultLog = createLogger('zettle/order-sync')

/**
 * Zettle purchase sync: paid POS/online purchases and refunds as rich rows
 * in public.webshop_orders (the Orders page). Feed-only doctrine: nothing
 * here books anything.
 *
 * Qualification: positive-amount non-refund purchases with at least one
 * non-invoice payment (or no payments array, treated as settled POS sale).
 * Purchases whose only payment type is IZETTLE_INVOICE are skipped (unpaid
 * invoice). Refunds (refund:true) land as separate negative rows.
 *
 * Underlag: per-rate VAT from groupedVatAmounts, line-item snapshot from
 * products (+ serviceCharge). Customer fields stay null (POS rarely has
 * orgnr/email). Currency amounts are minor units from the API.
 */

export const ZETTLE_IMPORT_SOURCE = 'zettle'
export const BACKFILL_DAYS = 90
const CURSOR_OVERLAP_MS = 24 * 60 * 60 * 1000
const MAX_PURCHASES_PER_RUN = 10_000
const VAT_REMAINDER_TOLERANCE = 0.5

/**
 * ⚠️ STORED-KEY FORMAT. Persisted to webshop_orders.external_id. Changing
 * the template silently orphans every prior row. Locked by order-sync tests.
 * Scope is organization_uuid, NOT connection id.
 */
export function zettleStoreScope(organizationUuid: string): string {
  return organizationUuid
}

export function zettlePurchaseExternalId(storeScope: string, purchaseUuid: string): string {
  return `zettle_${storeScope}_purchase_${purchaseUuid}`
}

export interface ZettleSyncSummary {
  fetched: number
  refundsFetched: number
  inserted: number
  updated: number
  unchanged: number
  frozenFlagged: number
  crossMarked: number
  errors: number
  deadlineReached?: boolean
  revoked?: boolean
}

/** Minor units → major currency units. */
export function fromMinor(amount: number): number {
  return round(amount / 100)
}

/** ISO date part from a Zettle timestamp (+0000 or Z). */
export function isoDateOf(timestamp: string): string {
  const normalized = timestamp.replace(/([+-]\d{4})$/, (m) => `${m.slice(0, 3)}:${m.slice(3)}`)
  const ms = Date.parse(normalized)
  if (Number.isFinite(ms)) return new Date(ms).toISOString().split('T')[0]
  return timestamp.split('T')[0]
}

export function purchaseTimestampIso(purchase: ZettlePurchase): string | null {
  const raw = purchase.created || purchase.timestamp
  if (!raw) return null
  const normalized = raw.replace(/([+-]\d{4})$/, (m) => `${m.slice(0, 3)}:${m.slice(3)}`)
  const ms = Date.parse(normalized)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

const INVOICE_ONLY = 'IZETTLE_INVOICE'

/**
 * Paid sale: not a refund, positive gross, and not invoice-only.
 * Empty payments[] is treated as a settled POS sale (common for cash/card
 * payloads that omit details in some historical rows).
 */
export function purchaseQualifiesAsPaidSale(purchase: ZettlePurchase): boolean {
  if (purchase.refund === true) return false
  if (!(purchase.amount > 0)) return false
  const payments = purchase.payments ?? []
  if (payments.length === 0) return true
  return !payments.every((p) => p.type === INVOICE_ONLY)
}

export function purchaseQualifiesAsRefund(purchase: ZettlePurchase): boolean {
  return purchase.refund === true && purchase.amount !== 0
}

const PAYMENT_TITLES: Record<string, string> = {
  IZETTLE_CARD: 'Kort',
  IZETTLE_CARD_ONLINE: 'Kort online',
  IZETTLE_CASH: 'Kontant',
  IZETTLE_INVOICE: 'Faktura',
  SWISH: 'Swish',
  VIPPS: 'Vipps',
  MOBILE_PAY: 'MobilePay',
  PAYPAL: 'PayPal',
  GIFTCARD: 'Presentkort',
  STORE_CREDIT: 'Tillgodohavande',
  KLARNA: 'Klarna',
}

export function paymentMethodOf(payments: ZettlePayment[] | undefined): {
  method: string | null
  title: string | null
} {
  if (!payments || payments.length === 0) return { method: null, title: null }
  const types = payments.map((p) => p.type).filter(Boolean)
  if (types.length === 0) return { method: null, title: null }
  return {
    method: types[0],
    title: types.map((t) => PAYMENT_TITLES[t] ?? t).join(', '),
  }
}

/**
 * Net per VAT rate summed from the product rows (Zettle's own öre rounding,
 * rowTaxableAmount) plus the service charge. Null when any row lacks the
 * fields, so the caller falls back to deriving net from the tax amount.
 */
function netByRateFromProducts(purchase: ZettlePurchase): Map<number, number> | null {
  const netByRate = new Map<number, number>()
  for (const product of purchase.products ?? []) {
    const qty = Number.parseFloat(product.quantity)
    if (!Number.isFinite(qty) || qty === 0) continue
    if (typeof product.rowTaxableAmount !== 'number') return null
    const rate = typeof product.vatPercentage === 'number' ? product.vatPercentage : 0
    netByRate.set(rate, round((netByRate.get(rate) ?? 0) + fromMinor(product.rowTaxableAmount)))
  }
  const charge = purchase.serviceCharge
  if (charge && typeof charge.amount === 'number') {
    const rate = typeof charge.vatPercentage === 'number' ? charge.vatPercentage : 0
    const gross = fromMinor(charge.amount)
    const net = rate > 0 ? round(gross / (1 + rate / 100)) : gross
    netByRate.set(rate, round((netByRate.get(rate) ?? 0) + net))
  }
  return netByRate.size > 0 ? netByRate : null
}

/**
 * Per-rate VAT from groupedVatAmounts (tax in minor units). Net per rate is
 * taken from the product rows when they carry it (matches what Zettle
 * charged to the öre); otherwise derived as tax / rate. Remainder against
 * gross becomes a 0% bucket.
 */
export function buildVatBreakdown(purchase: ZettlePurchase): WebshopVatBreakdownLine[] {
  const total = fromMinor(Math.abs(purchase.amount))
  if (total === 0) return []

  const grouped = purchase.groupedVatAmounts
  if (!grouped || typeof grouped !== 'object') return []

  const netFromRows = netByRateFromProducts(purchase)
  const buckets = new Map<number, { net: number; tax: number }>()
  for (const [rateKey, taxMinor] of Object.entries(grouped)) {
    if (typeof taxMinor !== 'number' || taxMinor === 0) continue
    const rate = Number.parseFloat(rateKey)
    if (!Number.isFinite(rate) || rate <= 0) return []
    const tax = fromMinor(Math.abs(taxMinor))
    const rowNet = netFromRows?.get(rate)
    const net = rowNet !== undefined ? Math.abs(rowNet) : round(tax / (rate / 100))
    const bucket = buckets.get(rate) ?? { net: 0, tax: 0 }
    bucket.net = round(bucket.net + net)
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

/** Line snapshot: products + optional serviceCharge. Dropped if öre sum ≠ |total|. */
export function mapLineItems(purchase: ZettlePurchase): WebshopOrderLineItem[] {
  const items: WebshopOrderLineItem[] = []
  for (const product of purchase.products ?? []) {
    const qty = Number.parseFloat(product.quantity)
    if (!Number.isFinite(qty) || qty === 0) continue
    const netMinor = product.rowTaxableAmount
    if (typeof netMinor !== 'number') return []
    // rowTaxableAmount is the row's net in minor units (signed with refunds).
    const rowNet = fromMinor(netMinor)
    const rate = typeof product.vatPercentage === 'number' ? product.vatPercentage : null
    const tax =
      rate !== null && rate > 0 ? round(rowNet * (rate / 100)) : 0
    const nameParts = [product.name, product.variantName].filter(Boolean)
    items.push({
      name: nameParts.join(' / ') || product.type || 'Artikel',
      quantity: qty,
      total: rowNet,
      total_tax: tax,
      vat_rate: rate,
    })
  }

  if (purchase.serviceCharge && typeof purchase.serviceCharge.amount === 'number') {
    const gross = fromMinor(purchase.serviceCharge.amount)
    const rate =
      typeof purchase.serviceCharge.vatPercentage === 'number'
        ? purchase.serviceCharge.vatPercentage
        : null
    let net = gross
    let tax = 0
    if (rate !== null && rate > 0) {
      net = round(gross / (1 + rate / 100))
      tax = round(gross - net)
    }
    items.push({
      name: purchase.serviceCharge.title || 'Serviceavgift',
      quantity: Number.parseFloat(purchase.serviceCharge.quantity ?? '1') || 1,
      total: net,
      total_tax: tax,
      vat_rate: rate,
    })
  }

  // Each row's tax is re-derived from Zettle's rounded net, so net + tax can
  // sit one öre off the row's charged gross (33.37 kr at 25%: net 26.70,
  // tax 6.68, sum 33.38). Allow that per row; anything larger means the
  // rows do not describe this purchase and the snapshot is dropped.
  const total = fromMinor(Math.abs(purchase.amount))
  const covered = round(
    items.reduce((sum, i) => sum + Math.abs(i.total) + Math.abs(i.total_tax), 0),
  )
  const tolerance = 0.005 + 0.01 * items.length
  if (Math.abs(covered - total) > tolerance) return []
  return items
}

export function mapPurchaseToWebshopRows(
  connection: Pick<ZettleConnection, 'id' | 'organization_name'>,
  storeScope: string,
  purchase: ZettlePurchase,
): WebshopOrderUpsert[] {
  const uuid = purchase.purchaseUUID1
  if (!uuid) return []

  if (purchaseQualifiesAsPaidSale(purchase)) {
    const total = fromMinor(purchase.amount)
    if (total === 0) return []
    const ts = purchaseTimestampIso(purchase)
    const date = ts ? isoDateOf(ts) : isoDateOf(purchase.created || purchase.timestamp || '')
    const payment = paymentMethodOf(purchase.payments)
    const vat = buildVatBreakdown(purchase)
    const totalTax =
      typeof purchase.vatAmount === 'number'
        ? fromMinor(purchase.vatAmount)
        : round(vat.reduce((s, b) => s + b.tax, 0))
    return [
      {
        platform: 'zettle',
        store_scope: storeScope,
        store_label: connection.organization_name,
        connection_id: connection.id,
        row_type: 'order',
        parent_external_id: null,
        external_id: zettlePurchaseExternalId(storeScope, uuid),
        platform_order_id: uuid,
        order_number: String(purchase.globalPurchaseNumber ?? purchase.purchaseNumber ?? uuid),
        status: purchase.refunded ? 'refunded' : 'paid',
        is_paid: true,
        order_date: date,
        paid_date: date,
        currency: purchase.currency.toUpperCase(),
        total,
        total_tax: totalTax,
        vat_breakdown: vat,
        line_items: mapLineItems(purchase),
        customer_name: null,
        customer_company: null,
        customer_email: null,
        customer_orgnr: null,
        customer_country: purchase.country ?? null,
        payment_method: payment.method,
        payment_method_title: payment.title,
        gateway_reference: purchase.payments?.[0]?.uuid ?? null,
        refunded_total: 0,
      },
    ]
  }

  if (purchaseQualifiesAsRefund(purchase)) {
    const amount = fromMinor(purchase.amount) // already negative typically
    const signedTotal = amount > 0 ? -amount : amount
    if (signedTotal === 0) return []
    const ts = purchaseTimestampIso(purchase)
    const date = ts ? isoDateOf(ts) : isoDateOf(purchase.created || purchase.timestamp || '')
    const payment = paymentMethodOf(purchase.payments)
    const parentUuid = purchase.refundsPurchaseUUID1
    const vat = buildVatBreakdown(purchase).map((b) => ({
      rate: b.rate,
      net: -Math.abs(b.net),
      tax: -Math.abs(b.tax),
    }))
    const totalTax =
      typeof purchase.vatAmount === 'number'
        ? -Math.abs(fromMinor(purchase.vatAmount))
        : round(vat.reduce((s, b) => s + b.tax, 0))
    return [
      {
        platform: 'zettle',
        store_scope: storeScope,
        store_label: connection.organization_name,
        connection_id: connection.id,
        row_type: 'refund',
        parent_external_id: parentUuid
          ? zettlePurchaseExternalId(storeScope, parentUuid)
          : null,
        external_id: zettlePurchaseExternalId(storeScope, uuid),
        platform_order_id: uuid,
        order_number: String(purchase.globalPurchaseNumber ?? purchase.purchaseNumber ?? uuid),
        status: 'refund',
        is_paid: true,
        order_date: date,
        paid_date: date,
        currency: purchase.currency.toUpperCase(),
        total: signedTotal,
        total_tax: totalTax,
        vat_breakdown: vat,
        line_items: mapLineItems(purchase),
        customer_name: null,
        customer_company: null,
        customer_email: null,
        customer_orgnr: null,
        customer_country: purchase.country ?? null,
        payment_method: payment.method,
        payment_method_title: payment.title,
        gateway_reference: purchase.payments?.[0]?.uuid ?? null,
        refunded_total: 0,
      },
    ]
  }

  return []
}

function resolveWindowStartIso(connection: ZettleConnection): string {
  if (connection.last_order_synced_at) {
    const cursorMs = Date.parse(connection.last_order_synced_at)
    return new Date(Math.max(0, cursorMs - CURSOR_OVERLAP_MS)).toISOString()
  }
  return new Date(Date.now() - BACKFILL_DAYS * 86_400_000).toISOString()
}

export async function syncZettlePurchases(
  supabase: SupabaseClient,
  connection: ZettleConnection,
  log: Logger = defaultLog,
  deadlineMs?: number,
): Promise<ZettleSyncSummary> {
  const summary: ZettleSyncSummary = {
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
    !connection.refresh_token_encrypted ||
    !connection.organization_uuid
  ) {
    return summary
  }

  const storeScope = zettleStoreScope(connection.organization_uuid)
  const runStartMs = Date.now()
  const startDate = resolveWindowStartIso(connection)
  let lastPurchaseHash: string | null = null
  let prevCursorMs = connection.last_order_synced_at
    ? Date.parse(connection.last_order_synced_at)
    : 0
  let failureFloorMs = Number.POSITIVE_INFINITY
  let windowExhausted = false

  try {
    const tokens = await refreshAccessToken(refreshTokenOf(connection))
    // Rotate the refresh token immediately (Zettle invalidates the old one).
    // The write must succeed before we continue: losing the new token leaves
    // only a dead refresh token for the next run and forces a reconnect.
    const encrypted = encryptCredential(tokens.refresh_token)
    const { error: rotateError } = await supabase
      .from('zettle_connections')
      .update({ refresh_token_encrypted: encrypted, error_message: null })
      .eq('id', connection.id)
    if (rotateError) {
      log.error('failed to persist rotated Zettle refresh token', rotateError, {
        connectionId: connection.id,
        message: rotateError.message,
        code: rotateError.code,
      })
      throw new Error(
        `Failed to persist rotated Zettle refresh token: ${rotateError.message}`,
      )
    }
    connection.refresh_token_encrypted = encrypted

    for (;;) {
      if (deadlineMs !== undefined && Date.now() >= deadlineMs) {
        summary.deadlineReached = true
        log.info('time budget exhausted; stopping purchase sync', {
          connectionId: connection.id,
          processed: summary.inserted + summary.updated + summary.unchanged,
        })
        break
      }

      const page = await listPurchasesPage(tokens.access_token, {
        startDate,
        lastPurchaseHash,
      })
      if (page.purchases.length === 0) {
        windowExhausted = true
        break
      }
      summary.fetched += page.purchases.length

      const rows: WebshopOrderUpsert[] = []
      let pageMaxMs = 0
      let pageMinMs = Number.POSITIVE_INFINITY
      for (const purchase of page.purchases) {
        if (purchaseQualifiesAsRefund(purchase)) summary.refundsFetched += 1
        const ts = purchaseTimestampIso(purchase)
        if (ts) {
          const ms = Date.parse(ts)
          if (ms > pageMaxMs) pageMaxMs = ms
          if (ms < pageMinMs) pageMinMs = ms
        }
        rows.push(...mapPurchaseToWebshopRows(connection, storeScope, purchase))
      }

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
        if (result.errors > 0 && Number.isFinite(pageMinMs)) {
          failureFloorMs = Math.min(failureFloorMs, pageMinMs - 1000)
        }
      }

      if (pageMaxMs > 0) {
        const candidateMs = Math.min(pageMaxMs, failureFloorMs)
        if (candidateMs > prevCursorMs) {
          const cursorIso = new Date(candidateMs).toISOString()
          await supabase
            .from('zettle_connections')
            .update({ last_order_synced_at: cursorIso, error_message: null })
            .eq('id', connection.id)
          connection.last_order_synced_at = cursorIso
          prevCursorMs = candidateMs
        }
      }

      if (!page.hasMore) {
        windowExhausted = true
        break
      }
      lastPurchaseHash = page.lastPurchaseHash

      if (summary.fetched >= MAX_PURCHASES_PER_RUN) {
        log.warn('purchase cap reached; remaining purchases resume next run', {
          connectionId: connection.id,
          cap: MAX_PURCHASES_PER_RUN,
        })
        break
      }
    }

    if (windowExhausted) {
      const watermarkMs = Math.min(runStartMs, failureFloorMs)
      if (watermarkMs > prevCursorMs) {
        const cursorIso = new Date(watermarkMs).toISOString()
        await supabase
          .from('zettle_connections')
          .update({ last_order_synced_at: cursorIso, error_message: null })
          .eq('id', connection.id)
        connection.last_order_synced_at = cursorIso
      }
    }
  } catch (err) {
    if (isRevokedCredentialsError(err) || isRevokedOAuthError(err)) {
      summary.revoked = true
      await supabase
        .from('zettle_connections')
        .update({
          status: 'revoked',
          error_message: 'Zettle avvisade anslutningen. Anslut kontot igen.',
          refresh_token_encrypted: null,
          oauth_state: null,
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

  log.info('zettle purchase sync done', {
    connectionId: connection.id,
    ...summary,
  })
  return summary
}
