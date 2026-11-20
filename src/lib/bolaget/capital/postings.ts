/**
 * The verifikat of the capital events, as lines, and the one way they are
 * posted: through the posting port, so the engine draws the voucher number
 * and the balance trigger, the period lock and the lock date apply. Nothing
 * here writes a journal table.
 *
 *   Utdelning, decision (stämma day):  D 2098 or 2091 / K 2898
 *   Utdelning, payout:                 D 2898 / K bank
 *   Aktieägartillskott (K2 15.5):      D bank (or 1685 while promised) / K 2093
 *   Återbetalning villkorat tillskott: D 2093 / K bank
 *   Nyemission, payment:               D bank / K 2082 (kvotvärde) + K 2097 (överkurs)
 *   Nyemission, registration (13:29):  D 2082 / K 2081
 *   Fondemission, registration (12:10): D the fund (2091, 2097, 2086, 2085) / K 2081
 *   Minskning, registration (20:20):   D 2081 / K 2091 (loss cover, free fund) or 2890 (repayment)
 *
 * Accounts are strings; amounts are rounded to the öre and every builder
 * answers balanced lines (capital-postings.test.ts).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { findFiscalPeriod } from '@/lib/bookkeeping/engine'
import { postingPort } from '@/lib/posting/port'
import { mappingVersion } from '@/lib/posting/mapping-version'
import type { BusinessEventDraft } from '@/lib/posting/types'
import { roundOre } from '@/lib/money'
import { lineBalance } from '@/lib/bookkeeping/line-balance'
import type { CreateJournalEntryLineInput, JournalEntry } from '@/types'
import {
  CONTRIBUTION_ACCOUNT,
  DIVIDEND_LIABILITY_ACCOUNT,
  SHARE_CAPITAL_ACCOUNT,
  SHARE_PREMIUM_ACCOUNT,
  UNREGISTERED_SHARE_CAPITAL_ACCOUNT,
} from './types'

export type CapitalLine = CreateJournalEntryLineInput

function debit(account: string, amount: number, description: string): CapitalLine {
  return { account_number: account, debit_amount: roundOre(amount), credit_amount: 0, line_description: description }
}

function credit(account: string, amount: number, description: string): CapitalLine {
  return { account_number: account, debit_amount: 0, credit_amount: roundOre(amount), line_description: description }
}

export function dividendDecisionLines(sourceAccount: string, total: number): CapitalLine[] {
  return [debit(sourceAccount, total, 'Beslutad utdelning'), credit(DIVIDEND_LIABILITY_ACCOUNT, total, 'Outtagen vinstutdelning')]
}

export function dividendPayoutLines(bankAccount: string, total: number): CapitalLine[] {
  return [debit(DIVIDEND_LIABILITY_ACCOUNT, total, 'Utbetald utdelning'), credit(bankAccount, total, 'Utbetald utdelning')]
}

export function contributionLines(counterAccount: string, amount: number, conditional: boolean): CapitalLine[] {
  const text = conditional ? 'Villkorat aktieägartillskott' : 'Ovillkorat aktieägartillskott'
  return [debit(counterAccount, amount, text), credit(CONTRIBUTION_ACCOUNT, amount, text)]
}

export function contributionRepaymentLines(bankAccount: string, amount: number): CapitalLine[] {
  return [
    debit(CONTRIBUTION_ACCOUNT, amount, 'Återbetalning av villkorat aktieägartillskott'),
    credit(bankAccount, amount, 'Återbetalning av villkorat aktieägartillskott'),
  ]
}

export function nyemissionPaymentLines(bankAccount: string, shareCapital: number, premium: number): CapitalLine[] {
  const lines = [
    debit(bankAccount, roundOre(shareCapital + premium), 'Inbetalning nyemission'),
    credit(UNREGISTERED_SHARE_CAPITAL_ACCOUNT, shareCapital, 'Ej registrerat aktiekapital'),
  ]
  if (roundOre(premium) > 0) lines.push(credit(SHARE_PREMIUM_ACCOUNT, premium, 'Överkurs vid nyemission'))
  return lines
}

export function nyemissionRegistrationLines(shareCapital: number): CapitalLine[] {
  return [
    debit(UNREGISTERED_SHARE_CAPITAL_ACCOUNT, shareCapital, 'Nyemission registrerad'),
    credit(SHARE_CAPITAL_ACCOUNT, shareCapital, 'Nyemission registrerad'),
  ]
}

export function fondemissionLines(sourceAccount: string, shareCapital: number): CapitalLine[] {
  return [debit(sourceAccount, shareCapital, 'Fondemission'), credit(SHARE_CAPITAL_ACCOUNT, shareCapital, 'Fondemission')]
}

export function minskningLines(targetAccount: string, shareCapital: number): CapitalLine[] {
  return [
    debit(SHARE_CAPITAL_ACCOUNT, shareCapital, 'Minskning av aktiekapitalet'),
    credit(targetAccount, shareCapital, 'Minskning av aktiekapitalet'),
  ]
}

/** Whether lines balance with both sides above zero (CLAUDE.md hard rule 3). */
export function linesBalance(lines: readonly CapitalLine[]): boolean {
  return lineBalance(lines).balanced
}

export class CapitalPostingPeriodError extends Error {
  readonly code = 'CAPITAL_NO_OPEN_PERIOD'
  constructor(readonly entryDate: string) {
    super(`Det finns inget öppet räkenskapsår för ${entryDate}. Lägg upp räkenskapsåret eller välj ett annat datum.`)
    this.name = 'CapitalPostingPeriodError'
  }
}

export interface PostCapitalEntryArgs {
  supabase: SupabaseClient
  companyId: string
  userId: string
  entryDate: string
  description: string
  lines: CapitalLine[]
  /** For the business event: an owner transfer (dividend, tillskott) or a change of capital. */
  category: 'owner.transfer' | null
  pendingOperationId?: string | null
}

export function capitalBusinessEvent(args: Pick<PostCapitalEntryArgs, 'entryDate' | 'lines' | 'category' | 'pendingOperationId'>): BusinessEventDraft {
  const amount = roundOre(args.lines.reduce((n, l) => n + l.debit_amount, 0))
  return {
    kind: 'ledger.manual',
    category: args.category,
    occurredOn: args.entryDate,
    subject: null,
    currency: 'SEK',
    amount,
    amountSek: amount,
    pendingOperationId: args.pendingOperationId ?? null,
    mappingVersion: mappingVersion('capitalEvents'),
    jurisdiction: 'SE',
  }
}

/**
 * Post one capital verifikat. The engine refuses an unbalanced entry, a
 * closed or locked period and a date behind the lock date; that refusal is
 * thrown as the engine's own error (a Swedish message through the error
 * registry), never worked around.
 */
export async function postCapitalEntry(args: PostCapitalEntryArgs): Promise<JournalEntry> {
  if (!linesBalance(args.lines)) throw new Error('capital posting does not balance')
  const fiscalPeriodId = await findFiscalPeriod(args.supabase, args.companyId, args.entryDate)
  if (!fiscalPeriodId) throw new CapitalPostingPeriodError(args.entryDate)
  return postingPort.postJournalEntry({
    supabase: args.supabase,
    companyId: args.companyId,
    userId: args.userId,
    event: () => capitalBusinessEvent(args),
    input: {
      fiscal_period_id: fiscalPeriodId,
      entry_date: args.entryDate,
      description: args.description,
      source_type: 'manual',
      lines: args.lines,
    },
  })
}
