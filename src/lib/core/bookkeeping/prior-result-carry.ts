import type { SupabaseClient } from '@supabase/supabase-js'
import { resultClosingAccounts, retainedResultAccount } from '@/lib/company/entity-type'
import { fetchEntryLines, type EntryLinesQuery } from '@/lib/bookkeeping/entry-lines'
import { getOpeningBalances } from '@/lib/reports/opening-balances'
import { roundOre, ORE_TOLERANCE } from '@/lib/bokslut/rounding'
import type { EntityType } from '@/types'
import { movedOffCarry, overMovedCarry, remainingCarry, type CarryEntry } from './prior-result-guard'

export interface PriorResultCarry {
  /** The form's "årets resultat" account (aktiebolag 2099, ideell förening 2069). */
  resultAccount: string
  resultAccountName: string
  /** Where a prior result is carried at year start (2098 / 2068). */
  priorResultAccount: string
  /** Balanserat resultat, where the annual meeting's decision puts it (2091 / 2067). */
  retainedAccount: string
  /** The prior result on the result account's ingående balans, credit-positive. */
  ibNet: number
  /** What is still carried after the automatic omföring and hand-booked dispositions. */
  remaining: number
  /**
   * What the dispositions moved beyond the carry, credit-positive and so of
   * the opposite sign to `ibNet` (see overMovedCarry); 0 when they did not.
   */
  overMoved: number
  /** Vouchers (e.g. "A12") that moved part or all of it. */
  movedBy: string[]
}

/**
 * The prior result carried into `period` on the form's result account, and
 * how much of it is still there after the automatic omföring and any
 * disposition booked by hand (see movedOffCarry). Null for forms that close
 * straight into equity (enskild firma, 2010).
 *
 * Shared by the year-end readiness check (a carry still there blocks the
 * close, PostHog PH 120) and the omföring itself (it moves only what is still
 * there, PostHog PH 108), so the two can never disagree.
 */
export async function priorResultCarry(
  supabase: SupabaseClient,
  companyId: string,
  period: { id: string; period_start: string; opening_balance_entry_id: string | null },
  entityType: EntityType,
): Promise<PriorResultCarry | null> {
  const accounts = resultClosingAccounts(entityType)
  if (!accounts.priorYearCarry) return null

  // Read the result account from the period's INGÅENDE BALANS only: that is
  // what was carried in. getOpeningBalances reads the committed opening_balance
  // entry, falling back to an aggregate of prior posted lines when none is set.
  // credit - debit is positive for a profit (the account is credit-normal).
  const { balances } = await getOpeningBalances(supabase, companyId, period)
  const ib = balances.get(accounts.closing)
  const ibNet = ib ? roundOre(ib.credit - ib.debit) : 0
  return carryAfterDispositions(supabase, companyId, period.id, entityType, ibNet)
}

/**
 * The carry `ibNet` (credit-positive) into the period `periodId` after the
 * dispositions already booked there (see movedOffCarry). `periodId` null: the
 * period does not exist yet, so nothing in it has moved the carry.
 *
 * priorResultCarry reads `ibNet` from the period's ingående balans. The
 * year-end previews pass the ingående balans the close WILL write (this year's
 * closing balance on the result account) before it exists, so the omföring
 * they disclose comes from the same computation the close uses.
 */
export async function carryAfterDispositions(
  supabase: SupabaseClient,
  companyId: string,
  periodId: string | null,
  entityType: EntityType,
  ibNet: number,
): Promise<PriorResultCarry | null> {
  const accounts = resultClosingAccounts(entityType)
  if (!accounts.priorYearCarry) return null
  const retainedAccount = retainedResultAccount(entityType)
  const base = {
    resultAccount: accounts.closing,
    resultAccountName: accounts.closingName,
    priorResultAccount: accounts.priorYearCarry,
    retainedAccount,
  }
  if (Math.abs(ibNet) < ORE_TOLERANCE) return { ...base, ibNet: 0, remaining: 0, overMoved: 0, movedBy: [] }

  const dispositionAccounts = [...new Set([accounts.priorYearCarry, retainedAccount])].filter(
    (account) => account !== accounts.closing,
  )
  const entries = periodId
    ? await fetchCarryEntries(supabase, companyId, periodId, [accounts.closing, ...dispositionAccounts])
    : []
  const moved = movedOffCarry(entries, accounts.closing, dispositionAccounts, ibNet)
  return {
    ...base,
    ibNet,
    remaining: remainingCarry(ibNet, moved.net),
    overMoved: overMovedCarry(ibNet, moved.net),
    movedBy: moved.vouchers,
  }
}

/** Live (posted) entries in the period with their lines on `accounts`, one item per entry. */
async function fetchCarryEntries(
  supabase: SupabaseClient,
  companyId: string,
  periodId: string,
  accounts: string[],
): Promise<CarryEntry[]> {
  type Line = {
    journal_entry_id: string
    account_number: string
    debit_amount: number | string
    credit_amount: number | string
    journal_entries: {
      id: string
      source_type: string | null
      voucher_series: string | null
      voucher_number: number | null
    }
  }
  const lines = await fetchEntryLines<Line>({
    supabase,
    lineColumns: 'journal_entry_id, account_number, debit_amount, credit_amount',
    entryColumns: 'id, source_type, voucher_series, voucher_number',
    filterEntries: (q: EntryLinesQuery) =>
      q.eq('company_id', companyId).eq('fiscal_period_id', periodId).eq('status', 'posted'),
    filterLines: (q: EntryLinesQuery) => q.in('account_number', accounts),
  })

  const byEntry = new Map<string, CarryEntry>()
  for (const line of lines) {
    const parent = line.journal_entries
    let entry = byEntry.get(line.journal_entry_id)
    if (!entry) {
      entry = {
        sourceType: parent?.source_type ?? null,
        voucher: `${parent?.voucher_series ?? ''}${parent?.voucher_number ?? ''}`,
        lines: [],
      }
      byEntry.set(line.journal_entry_id, entry)
    }
    entry.lines.push({
      account_number: line.account_number,
      debit_amount: line.debit_amount,
      credit_amount: line.credit_amount,
    })
  }
  return [...byEntry.values()]
}
