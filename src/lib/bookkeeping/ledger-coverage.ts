/**
 * How far the books already hold a feed connector's money (crm#1386).
 *
 * A backfill moves a connector's cursor back to a chosen day and brings every
 * row from there into the inbox (Stripe) or onto the Orders page (Shopify,
 * WooCommerce, Zettle) as unbooked. Before the connection existed the company
 * kept those books another way, and a row from a period that is already
 * booked is not new money: booking it again counts the same sale twice. The
 * external_id dedup cannot see that, because a voucher made outside the feed
 * has no external_id.
 *
 * Two kinds of voucher say the books already hold the money:
 * - the migrated ledger (fetchMigrationCoverageEnd): every affärshändelse up
 *   to the last imported voucher is in it, on whatever account the old system
 *   used (prod: Stripe and POS sales migrated on 1510/1580/1930, never 1686);
 * - a hand-entered voucher on the connector's settlement account, such as a
 *   samlingsverifikat for a range of Stripe sales on 1686. Counted even when
 *   a feed row was later linked to it: linking does not make it a feed
 *   booking.
 * A voucher the booking of a feed row created (bank_transaction), an invoice
 * payment or a single booked order is one movement, not the period, and is
 * left out: it would floor a backfill on one sale.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchEntryLines, type EntryLinesQuery } from '@/lib/bookkeeping/entry-lines'
import { fetchMigrationCoverageEnd } from '@/lib/bookkeeping/migration-coverage-end'

/**
 * The latest day on or after `fromDay` that the books already hold, or null
 * when nothing from `fromDay` on is booked outside the feed.
 *
 * Throws when the hand-entered vouchers cannot be read: the caller must not
 * guess the floor. The migration end reads a failure as "no migration"
 * (fetchMigrationCoverageEnd), which leaves the backfill as it was before.
 */
export async function ledgerCoveredThrough(
  supabase: SupabaseClient,
  companyId: string,
  settlementAccounts: readonly string[],
  fromDay: string,
): Promise<string | null> {
  const [migratedThrough, handLines] = await Promise.all([
    fetchMigrationCoverageEnd(supabase, companyId),
    settlementAccounts.length === 0
      ? Promise.resolve([])
      : fetchEntryLines<{ journal_entry: { entry_date: string } }>({
          supabase,
          entryColumns: 'entry_date',
          lineColumns: 'account_number',
          filterEntries: (q: EntryLinesQuery) =>
            q
              .eq('company_id', companyId)
              .eq('status', 'posted')
              .eq('source_type', 'manual')
              .gte('entry_date', fromDay),
          filterLines: (q: EntryLinesQuery) => q.in('account_number', [...settlementAccounts]),
          attachEntriesAs: 'journal_entry',
        }),
  ])

  let latest: string | null = migratedThrough && migratedThrough >= fromDay ? migratedThrough : null
  for (const line of handLines) {
    const day = line.journal_entry?.entry_date
    if (day && (latest === null || day > latest)) latest = day
  }
  return latest
}
