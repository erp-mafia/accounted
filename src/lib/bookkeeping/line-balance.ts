import { normalizeLineDimensions } from './dimension-resolver'
import { amountInCurrencyToStore } from './line-side'
import { roundOre, sumOre } from '@/lib/money'
import type { CreateJournalEntryLineInput } from '@/types'

export type LineAmount = number | string | null | undefined

export interface BalanceLine {
  debit_amount?: LineAmount
  credit_amount?: LineAmount
}

export interface LineBalance {
  /** Sum of the debits as stored, each line in whole öre. */
  totalDebit: number
  /** Sum of the credits as stored, each line in whole öre. */
  totalCredit: number
  /** totalDebit - totalCredit, to the öre. */
  difference: number
  /** Debits equal credits and both are above zero: what may post (CLAUDE.md hard rule 3). */
  balanced: boolean
}

/**
 * One side of one line as journal_entry_lines stores it: to the öre. A form's
 * text amount reads as parseFloat reads it; an empty or unreadable amount is 0.
 */
export function storedLineAmount(amount: LineAmount): number {
  const value = typeof amount === 'string' ? parseFloat(amount) : amount
  return roundOre(value || 0)
}

/**
 * The journal_entry_lines columns of a set of lines: every writer of new lines
 * stores through here, the engine and the correction beside a storno alike, so
 * no writer can store another amount than lineBalance judged. A correction
 * held its own copy with Math.round: 1,005 passed the check as 1,01, stored as
 * 1,00, and the trigger refused it after the storno had drawn its number.
 *
 * dimensions JSONB is the single source of truth; cost_center/project are
 * GENERATED columns derived from keys '1'/'6' since the PR9 cutover
 * (20260702230000): writing them explicitly would error.
 */
export function storedLineValues(lines: CreateJournalEntryLineInput[], accountIdMap: Map<string, string>) {
  return lines.map((line, index) => {
    const amountInCurrency = amountInCurrencyToStore(line.currency, line.amount_in_currency)
    return {
      account_number: line.account_number,
      account_id: accountIdMap.get(line.account_number) || null,
      debit_amount: storedLineAmount(line.debit_amount),
      credit_amount: storedLineAmount(line.credit_amount),
      currency: line.currency || 'SEK',
      amount_in_currency: amountInCurrency === null ? null : roundOre(amountInCurrency),
      exchange_rate: line.exchange_rate || null,
      line_description: line.line_description || null,
      tax_code: line.tax_code || null,
      dimensions: normalizeLineDimensions(line),
      sort_order: index,
    }
  })
}

/**
 * Whether a set of journal lines balances: the one balance rule of every door,
 * the engine, the routes, the dialogs and the imports. No engine or Supabase
 * import, so the browser runs it too.
 *
 * It answers for the amounts the lines store. The engine rounds each line to
 * the öre before insert (storedLineAmount) and the balance trigger sums what
 * was stored, so summing the raw lines and rounding the sum answered another
 * question: 100,004 + 100,004 against 200,01 balances as raw numbers and stores
 * 200,00 against 200,01. The caller got a failed commit where it should have
 * had a refusal. The trigger stays the floor; this says beforehand what it
 * will say.
 */
export function lineBalance(lines: ReadonlyArray<BalanceLine>): LineBalance {
  const totalDebit = sumOre(lines.map((line) => storedLineAmount(line.debit_amount)))
  const totalCredit = sumOre(lines.map((line) => storedLineAmount(line.credit_amount)))
  const difference = roundOre(totalDebit - totalCredit)
  return { totalDebit, totalCredit, difference, balanced: difference === 0 && totalDebit > 0 }
}
