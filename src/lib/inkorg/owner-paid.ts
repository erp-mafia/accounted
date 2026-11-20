/**
 * "Privat, med mina egna pengar": an enskild firma's cost paid with the
 * owner's own money, booked through book-direct with the payment side on
 * the owner's account (2018 Egna insättningar) instead of a bank or 2890
 * line.
 *
 * The lines are the ones "Bokför direkt" proposes for the same document
 * (lib/bookkeeping/book-direct-prefill.ts): the cost, the input VAT the
 * document states (its own figure, never computed here; none for a company
 * that is not VAT-registered) and the payment, here on the owner's account.
 * suggest-booking has nothing to add: it proposes only for an item matched
 * to a bank row, and money that never touched the company account has none.
 * The cost account is the one the company has booked this supplier on
 * (its counterparty template, the same rule "Bokför direkt" applies), else
 * empty for the person to pick (no generic seed); a foreign-currency
 * document gets no amounts: its kronor are typed.
 *
 * Pure: the dialog shows these and the person adjusts them before booking.
 */
import type { InvoiceExtractionResult } from '@/types'
import { buildBookDirectPrefillLines, toBookDirectPayloadLine } from '@/lib/bookkeeping/book-direct-prefill'
import { classifyAccountHeuristic } from '@/lib/bookkeeping/account-classifier-heuristic'
import { isCashLedger } from '@/lib/bookkeeping/bank-leg'
import type { VatRegistration } from '@/lib/bookkeeping/vat-registration'

export interface OwnerPaidLine {
  account_number: string
  debit_amount: number
  credit_amount: number
  description: string
}

/** What GET /api/settings/counterparty-templates?counterparty= answers, as far as this reads it. */
export interface CounterpartyTemplateMatch {
  confidence?: number | null
  template?: { debit_account?: string | null; credit_account?: string | null } | null
}

/**
 * The cost account the company's own history books this supplier on, by the
 * rule "Bokför direkt" applies to the same answer: a match at least half
 * sure, an expense account on the debit side and a cash ledger on the
 * credit side, so a private or balance-sheet template never plants its
 * account on a cost line. Null otherwise.
 */
export function templateCostAccount(match: CounterpartyTemplateMatch | null | undefined): string | null {
  if (!match || (match.confidence ?? 0) < 0.5) return null
  const debit = match.template?.debit_account?.trim()
  const credit = match.template?.credit_account?.trim()
  if (!debit || classifyAccountHeuristic(debit).account_type !== 'expense' || !isCashLedger(credit)) return null
  return debit
}

export function ownerPaidLines(
  reading: InvoiceExtractionResult | null,
  ownerAccount: string,
  vatRegistered?: VatRegistration,
  costAccount: string | null = null,
): OwnerPaidLine[] {
  const description = reading?.supplier?.name?.trim() ?? ''
  return buildBookDirectPrefillLines(reading, null, ownerAccount, { vatRegistered }).map((line) => {
    // The payment side is the owner's money whatever the prefill knew: an
    // unresolved pair (no kronor total) leaves its account empty. The cost
    // line takes the supplier's learned account when there is one.
    const account =
      line.role === 'settlement' ? ownerAccount : line.role === 'cost' && costAccount ? costAccount : line.account_number
    const payload = toBookDirectPayloadLine({ ...line, account_number: account })
    return {
      account_number: payload.account_number,
      debit_amount: payload.debit_amount,
      credit_amount: payload.credit_amount,
      description,
    }
  })
}
