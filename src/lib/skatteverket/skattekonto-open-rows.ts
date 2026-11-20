/**
 * Which skattekonto rows are open work: the one definition behind Att göra
 * (Bokför skattekontohändelser), the Hem step, the Transaktioner inbox, the
 * skattekonto page and the reconciliation's before_history list
 * (scripts/checks/one-definition/skattekonto-row-open.mjs).
 *
 * A row is open work when
 *   - Skatteverket has carried it out (status 'booked', its "tidigare";
 *     'upcoming' is a charge still to come, with nothing to book yet),
 *   - no verifikat holds it (journal_entry_id is the booked marker here,
 *     unlike bank rows) and the user has not ignored it, and
 *   - it is dated on or after the latest ingående balans on the skattekonto
 *     account (1630, or 2012 for an enskild firma that runs it there).
 *
 * The IB restates everything booked before it (findOpeningBalanceFloor): a
 * migrated company's time at its previous system, and every year closed in
 * the app, is in that balance. A row dated before it is history the IB
 * carries, not an event to book: booking it would put it on the account a
 * second time. Such a row is listed apart (before_history in the
 * reconciliation), outside every sum and count, and may still be linked to
 * the verifikat that holds it or ignored; nothing asks for either
 * (crm#1153, crm#2010). Whether the IB itself agrees with Skatteverket is
 * the reconciliation's opening difference, a line of its own.
 *
 * Client-safe: the reader only takes a client as an argument, the browser
 * client included (it reads through two RPCs).
 */
import type { SupabaseDataClient } from '@/lib/supabase/data-client'
import { findOpeningBalanceFloor } from '@/lib/bookkeeping/ledger-balance'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { resolveSkattekontoAccount, type SkattekontoLedgerAccount } from './skattekonto-account'

/** The fields of a skattekonto_transactions row the reading uses. */
export interface SkattekontoWorkRow {
  status: string
  journal_entry_id: string | null
  is_ignored: boolean | null
  transaktionsdatum: string
}

/** Carried out at Skatteverket, and neither linked nor ignored here. */
function settledAndUnhandled(row: SkattekontoWorkRow): boolean {
  return row.status === 'booked' && !row.journal_entry_id && !row.is_ignored
}

/**
 * Whether the ingående balans dated `openingDate` carries the row: it is
 * dated before it. No IB (null) carries nothing.
 */
function carriedByOpeningBalance(row: Pick<SkattekontoWorkRow, 'transaktionsdatum'>, openingDate: string | null): boolean {
  return openingDate !== null && row.transaktionsdatum < openingDate
}

/** A row that is open work (see the module doc). */
export function isOpenSkattekontoRow(row: SkattekontoWorkRow, openingDate: string | null): boolean {
  return settledAndUnhandled(row) && !carriedByOpeningBalance(row, openingDate)
}

/**
 * A row that would be open work but for the date: unlinked, not ignored and
 * carried by the IB. The reconciliation lists these as before_history and
 * the skattekonto page marks them as part of the opening balance.
 */
export function isSkattekontoRowBeforeHistory(row: SkattekontoWorkRow, openingDate: string | null): boolean {
  return settledAndUnhandled(row) && carriedByOpeningBalance(row, openingDate)
}

/** The filter methods the reading uses, on any query of skattekonto_transactions. */
interface OpenRowFilter {
  eq(column: string, value: string | boolean): OpenRowFilter
  is(column: string, value: null): OpenRowFilter
  gte(column: string, value: string): OpenRowFilter
}

/** isOpenSkattekontoRow as a filter on a query of skattekonto_transactions. */
export function whereSkattekontoRowOpen<Query>(query: Query, openingDate: string | null): Query {
  const open = (query as unknown as OpenRowFilter)
    .eq('status', 'booked')
    .is('journal_entry_id', null)
    .eq('is_ignored', false)
  return (openingDate ? open.gte('transaktionsdatum', openingDate) : open) as unknown as Query
}

/**
 * The date of the latest ingående balans on the company's skattekonto
 * account through `through` (today in Sweden when absent), or null when the
 * account has none. Throws when it cannot be read: a caller that guesses
 * null shows every row as work, which is the safe side, and says so.
 */
export async function readSkattekontoOpeningDate(
  supabase: SupabaseDataClient,
  companyId: string,
  options: { account?: SkattekontoLedgerAccount; through?: string } = {},
): Promise<string | null> {
  const account = options.account ?? (await resolveSkattekontoAccount(supabase, companyId))
  const floor = await findOpeningBalanceFloor(supabase, companyId, account, options.through ?? todayIsoStockholm())
  return floor?.date ?? null
}
