import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchExchangeRate } from '@/lib/currency/riksbanken'
import { roundOre as round } from '@/lib/money'
import { createLogger } from '@/lib/logger'
import type { Currency, WebshopOrder } from '@/types'
import type {
  WebshopOrderRemovalResult,
  WebshopOrderUpsert,
  WebshopOrderUpsertResult,
} from './types'

const log = createLogger('webshop-orders/ingest')

/**
 * Upsert service for webshop order rows: the single write path the platform
 * syncs (woocommerce/shopify extensions) use, mirroring how the transactions
 * feed goes through ingestTransactions().
 *
 * Unlike the append-only transactions feed, order rows are living mirrors:
 * status changes, date_paid arriving later, growing refund totals and billing
 * corrections all land as updates on (company_id, external_id). The boundary
 * is the financial freeze: once a row is booked (journal_entry_id) or
 * invoiced (invoice_id), financial fields are immutable (DB trigger). This
 * service respects that application-side: a frozen row whose incoming
 * financials differ gets remote_changed_after_freeze = true and only its
 * safe fields updated, so the sync never trips the trigger and divergence is
 * surfaced instead of silently dropped.
 *
 * Also owns:
 * - FX enrichment: non-SEK rows get exchange_rate/total_sek via Riksbanken
 *   (rate date = paid date, falling back to order date). Unresolved rates
 *   leave total_sek null; booking is blocked until a later sync resolves it.
 * - Legacy cross-marking: rows whose external_id already exists in the
 *   transactions feed (imported before the Orders switch-over) get
 *   legacy_transaction_id set, and the booking route refuses to double-book.
 * - Refund parenting: refund rows resolve parent_external_id to
 *   parent_order_id (parent in the same batch or already in the table).
 */

/** Batch size for selects/inserts; keeps PostgREST URLs and payloads sane. */
const CHUNK_SIZE = 200

/** Financial fields the freeze protects; compared to detect remote drift. */
const FINANCIAL_FIELDS = [
  'total',
  'total_tax',
  'currency',
  'order_date',
  'paid_date',
  'is_paid',
  'payment_method',
] as const

type ExistingRow = Pick<
  WebshopOrder,
  | 'id'
  | 'external_id'
  | 'journal_entry_id'
  | 'invoice_id'
  | 'manually_booked_at'
  | 'legacy_transaction_id'
  | 'remote_changed_after_freeze'
  | 'total'
  | 'total_tax'
  | 'total_sek'
  | 'exchange_rate'
  | 'currency'
  | 'order_date'
  | 'paid_date'
  | 'is_paid'
  | 'payment_method'
  | 'payment_method_title'
  | 'gateway_reference'
  | 'order_number'
  | 'status'
  | 'refunded_total'
  | 'store_label'
  | 'connection_id'
  | 'customer_name'
  | 'customer_company'
  | 'customer_email'
  | 'customer_orgnr'
  | 'customer_country'
  | 'vat_breakdown'
  | 'line_items'
>

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * Rows whose financials must not be silently refreshed. Booked/invoiced rows
 * are frozen by the DB trigger; manually marked rows (#1879) are treated the
 * same APPLICATION-side: the user asserted "this row is covered by verifikat
 * X", so a remote financial delta must surface as remote_changed_after_freeze
 * (the same badge booked rows get) instead of mutating the row under that
 * assertion and hiding the incremental business event forever.
 */
function isFrozen(
  row: Pick<ExistingRow, 'journal_entry_id' | 'invoice_id' | 'manually_booked_at'>,
): boolean {
  return (
    row.journal_entry_id !== null ||
    row.invoice_id !== null ||
    row.manually_booked_at !== null
  )
}

/**
 * Field-wise jsonb array comparison. NEVER JSON.stringify: Postgres jsonb
 * does not preserve object key order, so a stringify of what PostgREST
 * returns differs from a stringify of what was inserted even when the
 * values are identical (that bug falsely flagged every booked row as
 * remote-changed on the first re-poll). Array ORDER is preserved by jsonb,
 * so element-by-element field comparison is exact.
 */
function sameVatBreakdown(
  a: ExistingRow['vat_breakdown'],
  b: WebshopOrderUpsert['vat_breakdown'],
): boolean {
  if (a.length !== b.length) return false
  return a.every(
    (bucket, i) =>
      bucket.rate === b[i].rate && bucket.net === b[i].net && bucket.tax === b[i].tax,
  )
}

function sameLineItems(
  a: ExistingRow['line_items'],
  b: WebshopOrderUpsert['line_items'],
): boolean {
  if (a.length !== b.length) return false
  return a.every(
    (item, i) =>
      item.name === b[i].name &&
      item.quantity === b[i].quantity &&
      item.total === b[i].total &&
      item.total_tax === b[i].total_tax &&
      (item.vat_rate ?? null) === (b[i].vat_rate ?? null),
  )
}

function financialsDiffer(existing: ExistingRow, incoming: WebshopOrderUpsert): boolean {
  for (const field of FINANCIAL_FIELDS) {
    if ((existing[field] ?? null) !== (incoming[field] ?? null)) return true
  }
  return !sameVatBreakdown(existing.vat_breakdown, incoming.vat_breakdown)
}

/** Non-financial fields that keep syncing on every row, frozen or not. */
function safeFields(incoming: WebshopOrderUpsert) {
  return {
    status: incoming.status,
    refunded_total: incoming.refunded_total,
    store_label: incoming.store_label,
    connection_id: incoming.connection_id,
  }
}

interface FxResolution {
  total_sek: number | null
  exchange_rate: number | null
}

/**
 * Resolve SEK amount for one row, with a per-run (currency, date) cache.
 * Unknown currencies and Riksbanken failures resolve to nulls: booking stays
 * blocked, never a fake 1:1 rate.
 */
async function resolveFx(
  supabase: SupabaseClient,
  row: WebshopOrderUpsert,
  cache: Map<string, number | null>,
): Promise<FxResolution> {
  const currency = row.currency.toUpperCase()
  if (currency === 'SEK') return { total_sek: round(row.total), exchange_rate: 1 }
  const rateDate = row.paid_date ?? row.order_date
  const cacheKey = `${currency}:${rateDate}`
  let rate = cache.get(cacheKey)
  if (rate === undefined) {
    try {
      const result = await fetchExchangeRate(
        currency as Currency,
        new Date(`${rateDate}T00:00:00Z`),
        supabase,
      )
      rate = result?.rate ?? null
    } catch (err) {
      log.warn('exchange rate fetch failed; row stays unbookable until resolved', {
        currency,
        rateDate,
        message: err instanceof Error ? err.message : String(err),
      })
      rate = null
    }
    cache.set(cacheKey, rate)
  }
  if (rate === null) return { total_sek: null, exchange_rate: null }
  return { total_sek: round(row.total * rate), exchange_rate: rate }
}

export async function upsertWebshopOrders(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  rows: WebshopOrderUpsert[],
): Promise<WebshopOrderUpsertResult> {
  const result: WebshopOrderUpsertResult = {
    inserted: 0,
    updated: 0,
    unchanged: 0,
    frozenFlagged: 0,
    crossMarked: 0,
    errors: 0,
  }
  if (rows.length === 0) return result

  const recordError = (err: unknown) => {
    result.errors += 1
    if (!result.firstError) {
      const anyErr = err as { message?: string; code?: string | null }
      result.firstError = {
        message: anyErr?.message ?? String(err),
        code: anyErr?.code ?? null,
      }
    }
  }

  // Two phases: ALL order rows first, then refund rows. A refund's parent is
  // resolved from knownIds, which is only populated once the parent's insert
  // has actually executed; mixing both row types in one batch would leave
  // same-batch refunds unparented.
  const orderRows = rows.filter((r) => r.row_type === 'order')
  const refundRows = rows.filter((r) => r.row_type === 'refund')

  const fxCache = new Map<string, number | null>()
  // external_id -> row id, for refund parenting across chunks.
  const knownIds = new Map<string, string>()

  for (const batch of [...chunk(orderRows, CHUNK_SIZE), ...chunk(refundRows, CHUNK_SIZE)]) {
    const externalIds = batch.map((r) => r.external_id)
    const parentIds = batch
      .map((r) => r.parent_external_id)
      .filter((id): id is string => id !== null && !knownIds.has(id))
    const lookupIds = Array.from(new Set([...externalIds, ...parentIds]))

    const { data: existingData, error: existingError } = await supabase
      .from('webshop_orders')
      .select(
        'id, external_id, journal_entry_id, invoice_id, manually_booked_at, legacy_transaction_id, remote_changed_after_freeze, total, total_tax, total_sek, exchange_rate, currency, order_date, paid_date, is_paid, payment_method, payment_method_title, gateway_reference, order_number, status, refunded_total, store_label, connection_id, customer_name, customer_company, customer_email, customer_orgnr, customer_country, vat_breakdown, line_items',
      )
      .eq('company_id', companyId)
      .in('external_id', lookupIds)
    if (existingError) {
      recordError(existingError)
      continue
    }
    const existingByExternalId = new Map<string, ExistingRow>()
    for (const row of (existingData ?? []) as ExistingRow[]) {
      existingByExternalId.set(row.external_id, row)
      knownIds.set(row.external_id, row.id)
    }

    // Legacy feed overlap for this batch, one query.
    const { data: legacyData, error: legacyError } = await supabase
      .from('transactions')
      .select('id, external_id')
      .eq('company_id', companyId)
      .in('external_id', externalIds)
    if (legacyError) {
      recordError(legacyError)
      continue
    }
    const legacyByExternalId = new Map<string, string>()
    for (const row of (legacyData ?? []) as Array<{ id: string; external_id: string }>) {
      legacyByExternalId.set(row.external_id, row.id)
    }

    const inserts: Array<Record<string, unknown>> = []

    for (const incoming of batch) {
      const existing = existingByExternalId.get(incoming.external_id)
      const legacyTransactionId = legacyByExternalId.get(incoming.external_id) ?? null
      const parentOrderId = incoming.parent_external_id
        ? (knownIds.get(incoming.parent_external_id) ?? null)
        : null

      if (!existing) {
        const fx = await resolveFx(supabase, incoming, fxCache)
        inserts.push({
          company_id: companyId,
          user_id: userId,
          platform: incoming.platform,
          store_scope: incoming.store_scope,
          store_label: incoming.store_label,
          connection_id: incoming.connection_id,
          row_type: incoming.row_type,
          parent_order_id: parentOrderId,
          external_id: incoming.external_id,
          platform_order_id: incoming.platform_order_id,
          order_number: incoming.order_number,
          status: incoming.status,
          is_paid: incoming.is_paid,
          order_date: incoming.order_date,
          paid_date: incoming.paid_date,
          currency: incoming.currency.toUpperCase(),
          total: incoming.total,
          total_tax: incoming.total_tax,
          total_sek: fx.total_sek,
          exchange_rate: fx.exchange_rate,
          vat_breakdown: incoming.vat_breakdown,
          line_items: incoming.line_items,
          customer_name: incoming.customer_name,
          customer_company: incoming.customer_company,
          customer_email: incoming.customer_email,
          customer_orgnr: incoming.customer_orgnr,
          customer_country: incoming.customer_country,
          payment_method: incoming.payment_method,
          payment_method_title: incoming.payment_method_title,
          gateway_reference: incoming.gateway_reference,
          refunded_total: incoming.refunded_total,
          legacy_transaction_id: legacyTransactionId,
        })
        if (legacyTransactionId) result.crossMarked += 1
        continue
      }

      if (isFrozen(existing)) {
        const drifted = financialsDiffer(existing, incoming)
        const update: Record<string, unknown> = { ...safeFields(incoming) }
        if (drifted && !existing.remote_changed_after_freeze) {
          update.remote_changed_after_freeze = true
        }
        const changedSafe =
          existing.status !== incoming.status ||
          existing.refunded_total !== incoming.refunded_total ||
          existing.store_label !== incoming.store_label ||
          existing.connection_id !== incoming.connection_id ||
          update.remote_changed_after_freeze === true
        if (!changedSafe) {
          result.unchanged += 1
          continue
        }
        const { error } = await supabase
          .from('webshop_orders')
          .update(update)
          .eq('id', existing.id)
          .eq('company_id', companyId)
        if (error) {
          recordError(error)
        } else {
          result.updated += 1
          if (drifted) result.frozenFlagged += 1
        }
        continue
      }

      // Unfrozen existing row: full refresh. Recompute FX only when the
      // money or dates moved; otherwise keep the stored resolution (or
      // retry a previously unresolved rate).
      const moneyMoved = financialsDiffer(existing, incoming)
      const needsFx = moneyMoved || existing.total_sek === null
      const fx = needsFx
        ? await resolveFx(supabase, incoming, fxCache)
        : { total_sek: existing.total_sek, exchange_rate: existing.exchange_rate }

      const update: Record<string, unknown> = {
        ...safeFields(incoming),
        order_number: incoming.order_number,
        is_paid: incoming.is_paid,
        order_date: incoming.order_date,
        paid_date: incoming.paid_date,
        currency: incoming.currency.toUpperCase(),
        total: incoming.total,
        total_tax: incoming.total_tax,
        total_sek: fx.total_sek,
        exchange_rate: fx.exchange_rate,
        vat_breakdown: incoming.vat_breakdown,
        line_items: incoming.line_items,
        customer_name: incoming.customer_name,
        customer_company: incoming.customer_company,
        customer_email: incoming.customer_email,
        customer_orgnr: incoming.customer_orgnr,
        customer_country: incoming.customer_country,
        payment_method: incoming.payment_method,
        payment_method_title: incoming.payment_method_title,
        gateway_reference: incoming.gateway_reference,
      }
      // Never null-out an already-resolved parent link (the parent may just
      // be absent from this batch's lookup).
      if (parentOrderId !== null) update.parent_order_id = parentOrderId
      const newLegacyLink =
        existing.legacy_transaction_id === null && legacyTransactionId !== null
      if (newLegacyLink) {
        update.legacy_transaction_id = legacyTransactionId
        result.crossMarked += 1
      }

      // Every field the update payload writes must be compared here: a field
      // written but not compared makes its corrections silently drop as
      // "unchanged" (review finding: billing corrections).
      const unchanged =
        !moneyMoved &&
        !needsFx &&
        !newLegacyLink &&
        existing.status === incoming.status &&
        existing.refunded_total === incoming.refunded_total &&
        existing.store_label === incoming.store_label &&
        existing.connection_id === incoming.connection_id &&
        existing.order_number === incoming.order_number &&
        (existing.payment_method_title ?? null) === (incoming.payment_method_title ?? null) &&
        (existing.gateway_reference ?? null) === (incoming.gateway_reference ?? null) &&
        (existing.customer_name ?? null) === (incoming.customer_name ?? null) &&
        (existing.customer_company ?? null) === (incoming.customer_company ?? null) &&
        (existing.customer_email ?? null) === (incoming.customer_email ?? null) &&
        (existing.customer_orgnr ?? null) === (incoming.customer_orgnr ?? null) &&
        (existing.customer_country ?? null) === (incoming.customer_country ?? null) &&
        sameLineItems(existing.line_items, incoming.line_items)
      if (unchanged) {
        result.unchanged += 1
        continue
      }

      const { error } = await supabase
        .from('webshop_orders')
        .update(update)
        .eq('id', existing.id)
        .eq('company_id', companyId)
      if (error) recordError(error)
      else result.updated += 1
    }

    if (inserts.length > 0) {
      const { data: insertedRows, error: insertError } = await supabase
        .from('webshop_orders')
        .insert(inserts)
        .select('id, external_id')
      if (insertError) {
        recordError(insertError)
        log.warn('webshop order insert batch failed', {
          companyId,
          batchSize: inserts.length,
          code: (insertError as { code?: string }).code,
        })
      } else {
        result.inserted += insertedRows?.length ?? 0
        for (const row of (insertedRows ?? []) as Array<{ id: string; external_id: string }>) {
          knownIds.set(row.external_id, row.id)
        }
      }
    }
  }

  return result
}

/**
 * Delete rows the store no longer considers money events (WooCommerce
 * 'failed' payment attempts: user report, failed checkouts sat forever as
 * unbookable "Ej betald" rows). The freeze boundary applies to deletes as it
 * does to updates, application-side here because the table has no
 * delete-protection trigger:
 *
 * - a frozen row (booked / invoiced / manually marked) is never deleted;
 * - a paid row is never deleted: money moved at some point, and a paid row
 *   is also the only kind that can have refund children (parent_order_id
 *   cascades, so deleting one could take a booked refund row with it);
 * - a cross-marked row (legacy_transaction_id) is never deleted: the order
 *   may be booked via the retired transactions feed without any freeze
 *   column set on this row;
 * - every guard is repeated ON THE DELETE STATEMENT itself, not only on the
 *   candidate select (skeptic finding): a row booked between the select and
 *   the delete must survive, exactly like the conditional booking claim in
 *   book-order.ts. The frozen-child veto select below is defense in depth
 *   on top of the is_paid guard.
 */
export async function removeWebshopOrders(
  supabase: SupabaseClient,
  companyId: string,
  externalIds: string[],
): Promise<WebshopOrderRemovalResult> {
  const result: WebshopOrderRemovalResult = { removed: 0, errors: 0 }
  if (externalIds.length === 0) return result

  const recordError = (err: unknown) => {
    result.errors += 1
    if (!result.firstError) {
      const anyErr = err as { message?: string; code?: string | null }
      result.firstError = {
        message: anyErr?.message ?? String(err),
        code: anyErr?.code ?? null,
      }
    }
  }

  for (const batch of chunk(externalIds, CHUNK_SIZE)) {
    const { data: candidates, error: candidateError } = await supabase
      .from('webshop_orders')
      .select('id')
      .eq('company_id', companyId)
      .in('external_id', batch)
      .eq('is_paid', false)
      .is('journal_entry_id', null)
      .is('invoice_id', null)
      .is('manually_booked_at', null)
      .is('legacy_transaction_id', null)
    if (candidateError) {
      recordError(candidateError)
      continue
    }
    const candidateIds = ((candidates ?? []) as Array<{ id: string }>).map((r) => r.id)
    if (candidateIds.length === 0) continue

    const { data: frozenChildren, error: childError } = await supabase
      .from('webshop_orders')
      .select('parent_order_id')
      .eq('company_id', companyId)
      .in('parent_order_id', candidateIds)
      .or('journal_entry_id.not.is.null,invoice_id.not.is.null,manually_booked_at.not.is.null')
    if (childError) {
      recordError(childError)
      continue
    }
    const vetoedParents = new Set(
      ((frozenChildren ?? []) as Array<{ parent_order_id: string }>).map(
        (r) => r.parent_order_id,
      ),
    )
    const deletableIds = candidateIds.filter((id) => !vetoedParents.has(id))
    if (deletableIds.length === 0) continue

    const { data: deletedRows, error: deleteError } = await supabase
      .from('webshop_orders')
      .delete()
      .eq('company_id', companyId)
      .in('id', deletableIds)
      .eq('is_paid', false)
      .is('journal_entry_id', null)
      .is('invoice_id', null)
      .is('manually_booked_at', null)
      .is('legacy_transaction_id', null)
      .select('id')
    if (deleteError) {
      recordError(deleteError)
      log.warn('webshop order removal batch failed', {
        companyId,
        batchSize: deletableIds.length,
        code: (deleteError as { code?: string }).code,
      })
    } else {
      const deletedIds = ((deletedRows ?? []) as Array<{ id: string }>).map((r) => r.id)
      result.removed += deletedIds.length
      if (deletedIds.length > 0) {
        // Hard delete of financial staging rows: the log is the only record
        // of what was removed and by which process (compliance finding, ISO
        // A.8.10), since pre-bokföring rows carry no behandlingshistorik.
        log.info('webshop order rows removed (store reports order failed)', {
          companyId,
          deletedIds,
          requestedExternalIds: batch,
        })
      }
    }
  }

  return result
}
