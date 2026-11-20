/**
 * Booking-time half of the ledger coverage rule (accounted#101): a feed row on
 * a day the books already hold is refused by categorize and bulk book. The
 * coverage itself is ledgerCoverage, the rule the backfill floor uses (through
 * ledgerCoveredThrough), so both doors share one definition.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { ledgerCoverage, type LedgerCoverageSource } from '@/lib/bookkeeping/ledger-coverage'

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

/**
 * The feed rows on one settlement account that the booking doors refuse:
 * their days are already in the books. The shape the refusal's details carry,
 * so every door and every message states the same facts.
 */
export interface CoveredFeedRows {
  settlement_account: string
  /** The last day the books already hold on that account. */
  covered_through: string
  /** What holds it (ledgerCoverage). */
  covered_by: LedgerCoverageSource
  /** The hand-entered verifikat dated covered_through, when covered_by is manual_voucher. */
  covering_voucher?: { journal_entry_id: string; voucher_label: string }
  /** The covered rows, earliest day first. */
  transaction_ids: string[]
}

/**
 * Every feed-connector row (crm#1386, accounted#101) whose day the books
 * already hold, per settlement account; empty when none is. Rows that are not
 * feed rows are never read for. One coverage read per settlement account:
 * from the earliest feed row's day, the latest covered day L covers every row
 * dated on or before L.
 */
export async function coveredFeedRows(
  supabase: SupabaseClient,
  companyId: string,
  rows: ReadonlyArray<{ id: string; date: string; import_source?: string | null }>,
  settlementAccountOf: (transactionId: string) => string | undefined,
): Promise<CoveredFeedRows[]> {
  const byAccount = new Map<string, Array<{ id: string; day: string }>>()
  for (const row of rows) {
    if (!isFeedConnectorRow(row)) continue
    const account = settlementAccountOf(row.id)
    if (!account) continue
    const list = byAccount.get(account) ?? []
    list.push({ id: row.id, day: row.date.slice(0, 10) })
    byAccount.set(account, list)
  }
  const covered: CoveredFeedRows[] = []
  for (const [settlementAccount, list] of byAccount) {
    const sorted = [...list].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
    const coverage = await ledgerCoverage(supabase, companyId, [settlementAccount], sorted[0].day)
    if (!coverage) continue
    const ids = sorted.filter((row) => row.day <= coverage.through).map((row) => row.id)
    if (ids.length === 0) continue
    covered.push({
      settlement_account: settlementAccount,
      covered_through: coverage.through,
      covered_by: coverage.source,
      ...(coverage.voucher ? { covering_voucher: coverage.voucher } : {}),
      transaction_ids: ids,
    })
  }
  return covered
}

/**
 * What holds the days and through which day. The refusal said only "already
 * booked", so an agent probed day by day for the boundary and blamed a
 * verifikat that did not set it (crm#1901).
 */
export function coveredDayReason(covered: Omit<CoveredFeedRows, 'transaction_ids'>): { sv: string; en: string } {
  const { settlement_account: account, covered_through: day } = covered
  if (covered.covered_by === 'manual_voucher') {
    const label = covered.covering_voucher ? ` (${covered.covering_voucher.voucher_label})` : ''
    return {
      sv: `Konto ${account} har ett manuellt verifikat daterat ${day}${label}. Transaktioner som hämtats till kontot räknas som redan bokförda till och med den dagen.`,
      en: `Account ${account} has a hand-entered verifikat dated ${day}${label}. Feed rows on the account count as already booked up to and including that day.`,
    }
  }
  return {
    sv: `Bokföringen du importerade från ditt förra program når till och med ${day} (dess sista verifikat). Transaktioner som hämtats till konto ${account} räknas som redan bokförda där till och med den dagen.`,
    en: `The ledger imported from the previous system reaches ${day} (its last imported verifikat, on any account). Feed rows on account ${account} count as already booked there up to and including that day.`,
  }
}

/**
 * The refusal's sentence for a person, at both booking doors: the reason per
 * settlement account, how many of the `rowCount` rows asked for it stops, and
 * the two ways out the registry sentence names.
 */
export function coveredDayMessage(covered: readonly CoveredFeedRows[], rowCount: number): { sv: string; en: string } {
  const count = covered.reduce((sum, c) => sum + c.transaction_ids.length, 0)
  const rest = rowCount - count
  const parts: Array<{ sv: string; en: string }> = covered.map((c) => coveredDayReason(c))
  if (rowCount === 1) {
    parts.push({
      sv: 'Det gäller den här raden. Länka den till verifikatet som innehåller den eller ignorera den, i stället för att bokföra den igen.',
      en: 'That holds for this row. Link it to the verifikat that holds it or ignore it instead of booking it again.',
    })
  } else {
    parts.push({
      sv: `Det gäller ${rest > 0 ? `${count} av ${rowCount} rader` : 'alla rader'} i urvalet. Länka dem till verifikatet som innehåller dem eller ignorera dem, i stället för att skapa ett nytt samlingsverifikat.`,
      en: `That holds for ${rest > 0 ? `${count} of the ${rowCount} selected rows` : 'every selected row'}. Link them to the verifikat that holds them or ignore them instead of creating a new samlingsverifikat.`,
    })
  }
  if (rest > 0) {
    parts.push({
      sv: `De övriga ${rest} berörs inte och kan bokföras för sig.`,
      en: `The other ${rest} are not affected and can be booked on their own.`,
    })
  }
  return { sv: parts.map((p) => p.sv).join(' '), en: parts.map((p) => p.en).join(' ') }
}
