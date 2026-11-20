/**
 * The proposal lines the review shows and the hand-off of those lines into
 * the manual booking form ("Ändra rader", Ny verifikation, Bokför från mall).
 *
 * The lines themselves come from the server (POST
 * /api/bookkeeping/proposal-preview, lib/bookkeeping/proposal-preview.ts),
 * built by the mapping builders and the line assembly the booking posts with.
 * This module only converts them, so it stays safe for the browser.
 */

import { isGeneratedVatAccount, isReverseChargeBasisLeg } from '@/lib/bookkeeping/vat-entries'
import { buildCurrencyMetadata } from '@/lib/bookkeeping/currency-utils'
import { roundOre } from '@/lib/money'
import { isCashLedger } from '@/lib/bookkeeping/bank-leg'
import { templateAccountForForm } from '@/lib/company/entity-type'
import { templateSkattekontoAccount, type SkattekontoLedgerAccount } from '@/lib/skatteverket/skattekonto-account'

import type { FormLine } from '@/components/bookkeeping/JournalEntryForm'
import type { EntityType } from '@/types'

export interface ProposalLine {
  side: 'debet' | 'kredit'
  account: string
  amount: number
  /**
   * True for the bank/settlement leg (the money side). The prefill stamps
   * currency metadata on this leg, and swaps in the transaction's resolved
   * cash account when the leg is any cash ledger: the same contract as the
   * engine's applySettlementAccount (mapping-engine.ts). A learned non-cash
   * money leg (1510, 2440, 2890) is never rewritten.
   */
  settlement?: boolean
}

/**
 * Resolve a static template's accounts for the company's entity type: the
 * same substitution buildMappingResultFromTemplate performs before booking.
 * Exposed so the proposal dialog resolves the accounts it shows and hands
 * over, instead of previewing EF accounts to an aktiebolag. With the
 * company's skattekonto account, a template's 1630 becomes that account
 * (2012 for an enskild firma that runs it there, PH 175), as at booking.
 */
export function resolveTemplateAccountsForEntity(
  template: {
    debit_account?: string
    credit_account?: string
    debit_account_ab?: string
    credit_account_ab?: string
  },
  entityType: EntityType | undefined,
  skattekontoAccount?: SkattekontoLedgerAccount,
): { debitAccount?: string; creditAccount?: string } {
  const forCompany = (a: string | undefined) => (a ? templateSkattekontoAccount(a, skattekontoAccount) : a)
  if (!entityType) {
    return { debitAccount: forCompany(template.debit_account), creditAccount: forCompany(template.credit_account) }
  }
  return {
    debitAccount: forCompany(templateAccountForForm(entityType, template.debit_account, template.debit_account_ab)),
    creditAccount: forCompany(templateAccountForForm(entityType, template.credit_account, template.credit_account_ab)),
  }
}

/**
 * Convert proposal lines into JournalEntryForm prefill lines: the same
 * hand-off shape buildInitialLinesFromTemplate produces for library
 * templates. Amounts arrive already öre-rounded from the preview; toFixed(2)
 * here only formats the input-field string (same pattern as applyTemplate /
 * buildInitialLines), it is not money math.
 */
export function proposalLinesToFormLines(
  lines: ProposalLine[],
  opts: {
    /**
     * Resolved cash account: replaces the settlement leg's account when that
     * leg is a cash ledger (the 1930 default, or the 19xx ledger a template
     * was learned on), mirroring the engine's applySettlementAccount. A
     * learned non-cash money leg (1510, 2440, 2890) is authoritative and is
     * never rewritten.
     */
    settlementAccount?: string
    currency?: string | null
    /** Foreign-currency amount of the transaction (absolute). */
    foreignAmount?: number | null
    exchangeRate?: number | null
    /**
     * Radtext for the business lines: what the money was for, in the words
     * the review used. The money leg keeps the bank text and the moms legs
     * are named by their accounts, so neither needs it.
     */
    businessLineDescription?: string
  } = {},
): FormLine[] {
  const currencyMeta = buildCurrencyMetadata(opts.currency, opts.foreignAmount, opts.exchangeRate)

  return lines.map((line) => {
    const amount = roundOre(line.amount)
    const amountStr = amount.toFixed(2)
    const isSettlement = line.settlement === true
    const swapAccount = isSettlement && isCashLedger(line.account) && !!opts.settlementAccount
    // The line that says what the money was for: not the money leg, not a
    // moms or reverse-charge basis leg.
    const isBusinessLine =
      !isSettlement && !isGeneratedVatAccount(line.account) && !isReverseChargeBasisLeg(line.account)
    return {
      account_number: swapAccount && opts.settlementAccount ? opts.settlementAccount : line.account,
      debit_amount: line.side === 'debet' ? amountStr : '',
      credit_amount: line.side === 'kredit' ? amountStr : '',
      line_description: isBusinessLine ? (opts.businessLineDescription ?? '') : '',
      // Currency metadata belongs on the money leg only, mirroring
      // buildTransactionEntryLines' settlement handling.
      ...(isSettlement ? currencyMeta : {}),
    }
  })
}
