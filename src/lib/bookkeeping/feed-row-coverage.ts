/**
 * Booking-time half of the ledger coverage rule (accounted#101): a feed row on
 * a day the books already hold is refused by categorize and bulk book. The
 * coverage itself is ledgerCoveredThrough, the rule the backfill floor uses,
 * so both doors share one definition.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { ledgerCoveredThrough } from '@/lib/bookkeeping/ledger-coverage'

/**
 * transactions.import_source of the cursor-based feed connectors whose rows
 * land in the bank inbox and are booked through categorize and bulk book:
 * Stripe (the extension's STRIPE_IMPORT_SOURCE; a test there keeps the two
 * equal). Shopify, WooCommerce and Zettle orders are booked from the Orders
 * page, not through these doors. A bank row from a bank connection, a bank
 * file or a manual entry is never a feed row: its account (1930) carries
 * every kind of payment, so a hand-entered voucher on it says nothing about
 * which days are booked.
 */
export const FEED_CONNECTOR_IMPORT_SOURCES: readonly string[] = ['stripe']

export function isFeedConnectorRow(row: { import_source?: string | null }): boolean {
  return row.import_source != null && FEED_CONNECTOR_IMPORT_SOURCES.includes(row.import_source)
}

/** A feed row the booking doors refuse: its day is already in the books. */
export interface CoveredFeedRow {
  transactionId: string
  settlementAccount: string
  coveredThrough: string
}

/**
 * The first feed-connector row (crm#1386, accounted#101) whose day the books
 * already hold, or null. Rows that are not feed rows are never read for.
 * One coverage read per settlement account: from the earliest feed row's day,
 * the latest covered day L covers every row dated on or before L.
 */
export async function firstCoveredFeedRow(
  supabase: SupabaseClient,
  companyId: string,
  rows: ReadonlyArray<{ id: string; date: string; import_source?: string | null }>,
  settlementAccountOf: (transactionId: string) => string | undefined,
): Promise<CoveredFeedRow | null> {
  const byAccount = new Map<string, Array<{ id: string; day: string }>>()
  for (const row of rows) {
    if (!isFeedConnectorRow(row)) continue
    const account = settlementAccountOf(row.id)
    if (!account) continue
    const list = byAccount.get(account) ?? []
    list.push({ id: row.id, day: row.date.slice(0, 10) })
    byAccount.set(account, list)
  }
  for (const [settlementAccount, list] of byAccount) {
    const sorted = [...list].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
    const coveredThrough = await ledgerCoveredThrough(supabase, companyId, [settlementAccount], sorted[0].day)
    if (!coveredThrough) continue
    const covered = sorted.find((row) => row.day <= coveredThrough)
    if (covered) return { transactionId: covered.id, settlementAccount, coveredThrough }
  }
  return null
}
