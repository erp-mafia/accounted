import type { SupabaseClient } from '@supabase/supabase-js'
import type { CommitActor } from '@/lib/bookkeeping/actor-context'
import { runWithActor } from '@/lib/bookkeeping/actor-context-node'
import { fetchEntryLines, type EntryLinesQuery } from '@/lib/bookkeeping/entry-lines'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { resolveCompanyEntityType, resultClosingAccounts, retainedResultAccount } from '@/lib/company/entity-type'
import {
  planResultAppropriation,
  postResultAppropriation,
  type ResultAppropriationTarget,
} from '@/lib/core/bookkeeping/result-appropriation-service'
import { createLogger } from '@/lib/logger'
import { equalOre, isZeroOre, roundOre } from '@/lib/money'
import { formatCurrency } from '@/lib/utils'
import { makeNotice, type ImportNotice } from './notices'
import type { OpeningBalanceDifference, SIEResultTransfer } from './types'

const log = createLogger('sie-result-transfer')

/**
 * Last year's result, moved the way the file's #IB moves it.
 *
 * A year imported on top of the year before opens on that year's closing
 * balance (sie-continuity.ts), with last year's result still on the result
 * account (aktiebolag 2099): nothing moves it at the year shift unless the
 * file holds a verifikat that does. Many programs move it in the next year's
 * #IB instead, onto 2098 or straight onto 2091, so the books differed from
 * the file on those two accounts year after year, and the year-end close
 * refused to run until the move was booked by hand.
 *
 * When that move is all the opening balance differs from the file's #IB by,
 * the import books it: the year-end's own omföring (planResultAppropriation),
 * dated the year's first day, onto the account the file's #IB uses. The
 * amount must be the one the year-end would move. Anything else is not
 * explained by the omföring, so nothing is booked and the difference stays
 * the warning it was (continuityNotices).
 *
 * The verifikat is the omföring's own, as the close's is: an undo of the
 * import leaves it, and the next import of the year finds it and books none.
 */

const sek = (amount: number) => formatCurrency(amount, 'SEK', { minimumFractionDigits: 2 })

/** The form's accounts the omföring moves between. */
interface ResultAccounts {
  /** Årets resultat (aktiebolag 2099). */
  result: string
  /** Where the close carries it (aktiebolag 2098). */
  carry: string
  /** Balanserat resultat (aktiebolag 2091). */
  retained: string
}

/** The omföring the file's #IB has made: where to, and what moves off the result account. */
export interface FileResultTransfer {
  to: ResultAppropriationTarget
  account: string
  /** Credit-positive, as the year-end plan states it: a profit moved off is > 0. */
  net: number
}

/**
 * The omföring the file's #IB has made and the books have not, read off the
 * opening-balance differences (compareOpeningBalances): exactly two accounts
 * differ, the result account and the carry or balanserat resultat account,
 * by the same amount the opposite way. Null for any other set.
 */
export function fileResultTransfer(
  differences: readonly OpeningBalanceDifference[],
  accounts: ResultAccounts,
): FileResultTransfer | null {
  if (differences.length !== 2) return null
  const result = differences.find((row) => row.account === accounts.result)
  const other = differences.find((row) => row.account !== accounts.result)
  if (!result || !other) return null
  const to = other.account === accounts.carry ? 'carry' : other.account === accounts.retained ? 'retained' : null
  if (!to || !isZeroOre(roundOre(result.difference + other.difference))) return null
  // books minus file, debit-positive: a profit the books still carry is a
  // credit the file no longer has there, a negative difference.
  return { to, account: other.account, net: roundOre(-result.difference) }
}

interface BookedOmforing {
  id: string
  voucher: string
  date: string
  /** Credit-positive balance per account. */
  net: Map<string, number>
}

/** The period's live omföringar (source_type result_appropriation), with their lines. */
async function bookedOmforingar(supabase: SupabaseClient, companyId: string, periodId: string): Promise<BookedOmforing[]> {
  type Line = {
    journal_entry_id: string
    account_number: string
    debit_amount: number | string
    credit_amount: number | string
    journal_entries: { id: string; voucher_series: string | null; voucher_number: number | null; entry_date: string }
  }
  const lines = await fetchEntryLines<Line>({
    supabase,
    lineColumns: 'journal_entry_id, account_number, debit_amount, credit_amount',
    entryColumns: 'id, voucher_series, voucher_number, entry_date',
    filterEntries: (q: EntryLinesQuery) =>
      q.eq('company_id', companyId).eq('fiscal_period_id', periodId)
        .eq('source_type', 'result_appropriation').eq('status', 'posted'),
  })
  const byEntry = new Map<string, BookedOmforing>()
  for (const line of lines) {
    const entry = line.journal_entries
    let booked = byEntry.get(line.journal_entry_id)
    if (!booked) {
      booked = { id: line.journal_entry_id, voucher: formatVoucher(entry), date: entry.entry_date, net: new Map() }
      byEntry.set(line.journal_entry_id, booked)
    }
    const net = (booked.net.get(line.account_number) ?? 0) + Number(line.credit_amount) - Number(line.debit_amount)
    booked.net.set(line.account_number, roundOre(net))
  }
  return [...byEntry.values()]
}

/** Whether a booked omföring moves exactly what the file's #IB moved, and nothing else. */
function movesAsFile(booked: BookedOmforing, resultAccount: string, file: FileResultTransfer): boolean {
  return booked.net.size === 2 && equalOre(booked.net.get(resultAccount) ?? 0, -file.net) &&
    equalOre(booked.net.get(file.account) ?? 0, file.net)
}

/**
 * After a continuation import's verifikat are in: the omföring that explains
 * the opening balance against the file's #IB (fileResultTransfer), booked
 * now, or found when the year already has it (an earlier attempt of this
 * import, an earlier import of the year, the close). Null when the
 * differences are not that omföring, when the year-end would move another
 * amount, or for a form that carries no result forward (enskild firma).
 *
 * The verifikat is booked for `actor`, the one that submitted the import, as
 * the import's own verifikat are. Never throws: the import is complete
 * without it, so a failure costs the omföring (an alert) and the
 * differences stay the warning.
 */
export async function bookFileResultTransfer(
  supabase: SupabaseClient,
  input: {
    companyId: string
    fiscalPeriodId: string
    userId: string
    actor: CommitActor | null
    differences: readonly OpeningBalanceDifference[]
  },
): Promise<SIEResultTransfer | null> {
  const { companyId, fiscalPeriodId } = input
  // The omföring differs on exactly two accounts: read nothing for any other set.
  if (input.differences.length !== 2) return null
  try {
    const entityType = await resolveCompanyEntityType(supabase, companyId)
    const { closing, priorYearCarry } = resultClosingAccounts(entityType)
    if (!priorYearCarry) return null
    const file = fileResultTransfer(input.differences,
      { result: closing, carry: priorYearCarry, retained: retainedResultAccount(entityType) })
    if (!file) return null
    const amount = roundOre(Math.abs(file.net))

    const booked = await bookedOmforingar(supabase, companyId, fiscalPeriodId)
    if (booked.length > 0) {
      const same = booked.find((entry) => movesAsFile(entry, closing, file))
      return same
        ? { entryId: same.id, voucher: same.voucher, date: same.date, from: closing, to: file.account, amount }
        : null
    }

    // The year-end's plan decides the amount, from the books: what the file
    // moved must be exactly that, between the same two accounts.
    const plan = await planResultAppropriation(supabase, companyId, fiscalPeriodId, { to: file.to })
    if (!plan || !equalOre(plan.net, file.net) || plan.resultAccount !== closing || plan.priorResultAccount !== file.account) {
      return null
    }
    const post = () => postResultAppropriation(supabase, companyId, input.userId, plan)
    const entry = await (input.actor ? runWithActor(input.actor, post) : post())
    return { entryId: entry.id, voucher: formatVoucher(entry), date: plan.periodStart, from: closing, to: file.account, amount }
  } catch (err) {
    log.error('SIE import: the omföring of last year\'s result was not booked; the opening balance stays a warning',
      err instanceof Error ? err : new Error(String(err)), { alert: true, companyId, fiscalPeriodId })
    return null
  }
}

/** The import result's sentence and its structured twin for the omföring. */
export function resultTransferNotice(transfer: SIEResultTransfer): { text: string; notice: ImportNotice } {
  const amount = sek(transfer.amount)
  return {
    text: `Föregående års resultat, ${amount}, är omfört från konto ${transfer.from} till ${transfer.to} med ` +
      `verifikation ${transfer.voucher} den ${transfer.date}, så att kontona stämmer med filens ingående balans.`,
    notice: makeNotice('sie_result_transferred', 'info',
      { amount, from: transfer.from, to: transfer.to, voucher: transfer.voucher, date: transfer.date }),
  }
}
