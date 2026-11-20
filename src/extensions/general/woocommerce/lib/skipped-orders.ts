import type { SupabaseClient } from '@supabase/supabase-js'
import type { SkippedCurrencyOrder, SkippedOrdersStatus } from '../types'

export type { SkippedCurrencyOrder, SkippedOrdersStatus }

/**
 * Orders the sync skipped because their currency could not be resolved (see
 * lib/order-currency), kept durably per store until a later sync imports them.
 *
 * Why durable: the sync cursor moves past a skipped order (holding it would
 * stall the whole feed on data only the store can fix), so the per-run toast
 * and the log were the only trace of an affärshändelse that never reached the
 * Orders page. Every one of them has to reach the books (BFL), so the list
 * stays visible in the settings panel until the order imports.
 *
 * Storage: public.extension_data (extension_id 'woocommerce'), one row per
 * store. Keyed by the store scope, not the connection id, for the same reason
 * the external_id scheme is (lib/order-sync wooStoreScope): a reconnect after
 * a revoked key is a new connection row, and the list must survive it. The
 * sync writes on the service role; the panel reads through GET /status on
 * the user's client (extension_data_select: company members).
 */

export const WOO_EXTENSION_ID = 'woocommerce'

/** How many entries GET /status hands the panel; the count is always exact. */
export const SKIPPED_ORDERS_STATUS_LIMIT = 50

/** Longest raw currency value kept (it is plugin output, not trusted). */
const MAX_CURRENCY_LENGTH = 32

/** One sighting of an order whose currency could not be resolved. */
export interface SkippedSighting {
  order_id: number
  order_number: string
  order_date: string | null
  currency: string
}

/** Stored shape of the extension_data value. */
export interface SkippedOrdersValue {
  orders: SkippedCurrencyOrder[]
}

export function skippedOrdersKey(storeScope: string): string {
  return `skipped_currency_orders:${storeScope}`
}

function isEntry(value: unknown): value is SkippedCurrencyOrder {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v.order_id === 'number' &&
    typeof v.order_number === 'string' &&
    (v.order_date === null || typeof v.order_date === 'string') &&
    typeof v.currency === 'string' &&
    typeof v.first_seen_at === 'string' &&
    typeof v.last_seen_at === 'string'
  )
}

/** Read a stored value defensively: anything malformed is dropped. */
export function parseSkippedOrders(value: unknown): SkippedCurrencyOrder[] {
  if (!value || typeof value !== 'object') return []
  const orders = (value as { orders?: unknown }).orders
  return Array.isArray(orders) ? orders.filter(isEntry) : []
}

function byOrderDate(a: SkippedCurrencyOrder, b: SkippedCurrencyOrder): number {
  const dateA = a.order_date ?? ''
  const dateB = b.order_date ?? ''
  if (dateA !== dateB) return dateA < dateB ? -1 : 1
  return a.order_id - b.order_id
}

/**
 * The list after one page of a sync: resolved orders leave, sighted orders
 * are added or refreshed (first_seen_at kept, the rest from the latest
 * sighting). An order reported as both is treated as resolved; the sync
 * never reports one order as both within a page.
 */
export function mergeSkippedOrders(
  existing: readonly SkippedCurrencyOrder[],
  change: { sighted: readonly SkippedSighting[]; resolvedOrderIds: readonly number[] },
  nowIso: string,
): SkippedCurrencyOrder[] {
  const resolved = new Set(change.resolvedOrderIds)
  const byId = new Map<number, SkippedCurrencyOrder>()
  for (const entry of existing) {
    if (!resolved.has(entry.order_id)) byId.set(entry.order_id, entry)
  }
  for (const sighting of change.sighted) {
    if (resolved.has(sighting.order_id)) continue
    const previous = byId.get(sighting.order_id)
    byId.set(sighting.order_id, {
      order_id: sighting.order_id,
      order_number: sighting.order_number,
      order_date: sighting.order_date,
      currency: sighting.currency.slice(0, MAX_CURRENCY_LENGTH),
      first_seen_at: previous?.first_seen_at ?? nowIso,
      last_seen_at: nowIso,
    })
  }
  return [...byId.values()].sort(byOrderDate)
}

/** Whether two lists differ in anything the panel or a later merge reads. */
export function skippedOrdersChanged(
  before: readonly SkippedCurrencyOrder[],
  after: readonly SkippedCurrencyOrder[],
): boolean {
  if (before.length !== after.length) return true
  return before.some((entry, i) => JSON.stringify(entry) !== JSON.stringify(after[i]))
}

/** The panel's slice of a stored list: exact count, oldest orders first. */
export function skippedOrdersStatus(orders: readonly SkippedCurrencyOrder[]): SkippedOrdersStatus {
  return { count: orders.length, orders: orders.slice(0, SKIPPED_ORDERS_STATUS_LIMIT) }
}

/** One page's delta to the list: never a whole list, so two runs merge. */
export interface SkippedOrdersChange {
  sighted: readonly SkippedSighting[]
  resolvedOrderIds: readonly number[]
}

/**
 * Outcome of applying a delta. 'failed' and 'contended' both mean the delta
 * is NOT stored; the caller holds its cursor exactly as for a failed write.
 */
export type SkippedOrdersWriteResult = 'written' | 'unchanged' | 'failed' | 'contended'

/** Read-merge-write rounds before giving up on a contended row. */
export const SKIPPED_ORDERS_WRITE_ATTEMPTS = 5

/** Postgres unique_violation: another run inserted the row first. */
const UNIQUE_VIOLATION = '23505'

/**
 * Apply one page's delta to the stored list with compare-and-swap.
 *
 * Why CAS: the manual /sync, /backfill and the nightly cron can run for one
 * store at the same time. A run that merged into a copy read earlier and
 * then replaced the whole value would drop entries another run added in
 * between, and its cursor would then move past that page: the lost order is
 * never listed again. So every round re-reads the row, merges THIS page's
 * delta into what is stored now, and writes on the condition that the row
 * still carries the updated_at it read (set_updated_at_extension_data bumps
 * it on every update). Zero rows matched means another run wrote first: read
 * again and merge again. An absent row is created with a plain insert, so
 * two runs racing to create it collide on the unique key instead of one
 * silently replacing the other.
 *
 * A read error is an error, never an empty list: merging into an empty list
 * would erase every recorded order. An empty result removes the row (value
 * is NOT NULL and an empty row would only be noise), under the same
 * condition.
 */
export async function applySkippedOrdersChange(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  storeScope: string,
  change: SkippedOrdersChange,
  nowIso: string,
  maxAttempts: number = SKIPPED_ORDERS_WRITE_ATTEMPTS,
): Promise<SkippedOrdersWriteResult> {
  if (change.sighted.length === 0 && change.resolvedOrderIds.length === 0) return 'unchanged'
  const key = skippedOrdersKey(storeScope)

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const { data: row, error: readError } = await supabase
      .from('extension_data')
      .select('value, updated_at')
      .eq('company_id', companyId)
      .eq('extension_id', WOO_EXTENSION_ID)
      .eq('key', key)
      .maybeSingle()
    if (readError) return 'failed'

    const current = parseSkippedOrders(row?.value)
    const next = mergeSkippedOrders(current, change, nowIso)
    if (!skippedOrdersChanged(current, next)) return 'unchanged'
    const value: SkippedOrdersValue = { orders: next }

    if (!row) {
      // next is non-empty here: it differs from the empty current list.
      const { error: insertError } = await supabase.from('extension_data').insert({
        user_id: userId,
        company_id: companyId,
        extension_id: WOO_EXTENSION_ID,
        key,
        value,
      })
      if (!insertError) return 'written'
      if (insertError.code === UNIQUE_VIOLATION) continue
      return 'failed'
    }

    // The version this round read. The column defaults to now() and the
    // trigger sets it on every update, so a stored row always carries one;
    // without it there is nothing to compare against, so do not write blind.
    const readVersion: unknown = row.updated_at
    if (typeof readVersion !== 'string') return 'failed'

    const { data: matched, error: writeError } =
      next.length === 0
        ? await supabase
            .from('extension_data')
            .delete()
            .eq('company_id', companyId)
            .eq('extension_id', WOO_EXTENSION_ID)
            .eq('key', key)
            .eq('updated_at', readVersion)
            .select('id')
        : await supabase
            .from('extension_data')
            .update({ value })
            .eq('company_id', companyId)
            .eq('extension_id', WOO_EXTENSION_ID)
            .eq('key', key)
            .eq('updated_at', readVersion)
            .select('id')
    if (writeError) return 'failed'
    if (Array.isArray(matched) && matched.length > 0) return 'written'
    // Zero rows: another run changed the row since this round read it.
  }
  return 'contended'
}
