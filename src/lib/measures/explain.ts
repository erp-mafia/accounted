/**
 * The shared parts of a measure's explanation: the journal lines behind a
 * set of accounts (read from the huvudbok generator, the report a person
 * drills into), paging, and the öre tolerance a breakdown ties out within.
 */
import { toHandle } from '@/lib/handles'
import { roundOre } from '@/lib/money'
import { generateGeneralLedger } from '@/lib/reports/general-ledger'
import type { MeasureContext, MeasureJournalLine, MeasurePage } from './types'

/** Default and largest page of a drill-down list. */
export const DEFAULT_DRILLDOWN_LIMIT = 50
export const MAX_DRILLDOWN_LIMIT = 500

/**
 * True when a breakdown's sum equals the figure. Each rounded addend may be
 * off by half an öre, so the tolerance grows with the number of addends.
 */
export function tiesOut(sum: number, value: number, addends: number): boolean {
  return Math.abs(roundOre(sum) - value) <= 0.005 * Math.max(1, addends) + 1e-9
}

/** One account's lines in the huvudbok, with its opening and closing balance (debit minus credit). */
export interface AccountLedger {
  account_number: string
  account_name: string
  opening: number
  closing: number
  lines: MeasureJournalLine[]
}

/** Order of a journal line list: date, voucher, account. Paging by offset relies on it. */
function compareLines(a: MeasureJournalLine, b: MeasureJournalLine): number {
  return (
    a.date.localeCompare(b.date) ||
    a.voucher_series.localeCompare(b.voucher_series) ||
    a.voucher_number - b.voucher_number ||
    a.account_number.localeCompare(b.account_number) ||
    a.journal_entry_id.localeCompare(b.journal_entry_id)
  )
}

/**
 * The huvudbok of `accounts` over a range inside one fiscal period, from
 * generateGeneralLedger. `excludeYearEnd` drops the bokslut entries
 * (source_type 'year_end'), the income statement's operational convention;
 * a storno of one is not recognised here, which the caller's tie-out then
 * reports instead of hiding.
 */
export async function ledgerForAccounts(
  ctx: MeasureContext,
  fiscalPeriodId: string,
  accounts: readonly string[],
  range: { fromDate?: string; toDate?: string },
  options: { excludeYearEnd?: boolean } = {},
): Promise<Map<string, AccountLedger>> {
  const wanted = new Set(accounts)
  const result = new Map<string, AccountLedger>()
  if (wanted.size === 0) return result
  const sorted = [...wanted].sort()
  const gl = await generateGeneralLedger(
    ctx.supabase,
    ctx.companyId,
    fiscalPeriodId,
    sorted[0],
    sorted[sorted.length - 1],
    { fromDate: range.fromDate, toDate: range.toDate },
  )
  for (const account of gl.accounts) {
    if (!wanted.has(account.account_number)) continue
    const lines = account.lines
      .filter((line) => !(options.excludeYearEnd && line.source_type === 'year_end'))
      .map(
        (line): MeasureJournalLine => ({
          journal_entry_id: line.journal_entry_id,
          handle: toHandle('journal_entry', line.journal_entry_id),
          voucher_series: line.voucher_series,
          voucher_number: line.voucher_number,
          date: line.date,
          account_number: account.account_number,
          description: line.description,
          debit: line.debit,
          credit: line.credit,
        }),
      )
    result.set(account.account_number, {
      account_number: account.account_number,
      account_name: account.account_name,
      opening: account.opening_balance,
      closing: roundOre(account.opening_balance + lines.reduce((sum, l) => sum + l.debit - l.credit, 0)),
      lines,
    })
  }
  return result
}

/** Every line of the ledgers, in drill-down order. */
export function flattenLines(ledgers: Iterable<AccountLedger>): MeasureJournalLine[] {
  const lines: MeasureJournalLine[] = []
  for (const ledger of ledgers) lines.push(...ledger.lines)
  return lines.sort(compareLines)
}

export function sortLines(lines: MeasureJournalLine[]): MeasureJournalLine[] {
  return lines.sort(compareLines)
}

/** One page of a drill-down list, with the offset of the next page (null on the last). */
export function pageOf<T>(items: readonly T[], page: MeasurePage): { items: T[]; total: number; next_offset: number | null } {
  const slice = items.slice(page.offset, page.offset + page.limit)
  const nextOffset = page.offset + slice.length
  return { items: slice, total: items.length, next_offset: nextOffset < items.length ? nextOffset : null }
}
