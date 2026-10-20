/**
 * The bank leg of a bank-transaction booking.
 *
 * A verifikat for a bank transaction moves the transaction's own settlement
 * ledger (cash_accounts.ledger_account) on the bank side: credit for money
 * out, debit for money in. commit_journal_entry refuses anything else
 * (BANK_BOOKING_SETTLEMENT_CHANGED). Every proposal source names that leg
 * with SOME account: the catalog and the categories with the 1930
 * placeholder, a learned counterparty template or mapping rule with the
 * ledger it happened to be learned on. Which of the company's cash ledgers
 * the money moved on is a fact of the transaction, never of the proposal, so
 * the bank leg is always put on the settlement ledger here, and the counter
 * leg is left as proposed.
 *
 * Pure and dependency free: shared by the server booking paths
 * (applySettlementAccount), the proposals the transactions page shows
 * (bindTemplateToSettlementAccount) and the client prefill
 * (proposalLinesToFormLines, and templateBankLeg for a company's own mall).
 */

export type BankSide = 'debit' | 'credit'

/** A company cash ledger: the BAS 19xx accounts (kassa, plusgiro, bank). */
export function isCashLedger(account: string | null | undefined): account is string {
  return !!account && /^19\d{2}$/.test(account)
}

/**
 * Which lines of a verifikat are the bank side of a batch of bank rows, given
 * the ledgers those rows settle on: the rule bulk_book_transactions measures
 * its bank net with (migration 20261010200000), here for the dialog that
 * previews it. A line counts when its account is one of those ledgers, or,
 * when any of them is a 19xx cash ledger, anywhere in 1900-1999.
 *
 * So rows on 19xx accounts keep the rule they always had (the whole range
 * must move by their sum), and a cash account kept elsewhere, such as a
 * payment provider's balance on 1686, is measured on its own ledger alone: a
 * payout from it debits 1930, which is the other end of the transfer and not
 * that row's bank side.
 */
export function bankNetAccountTest(settlementLedgers: readonly string[]): (account: string) => boolean {
  const ledgers = new Set(settlementLedgers)
  const anyCashLedger = settlementLedgers.some(isCashLedger)
  return (account) => ledgers.has(account) || (anyCashLedger && isCashLedger(account))
}

/** The side a bank transaction moves its own ledger on: credit for an outflow, debit for an inflow. */
export function bankSideOf(transactionAmount: number): BankSide {
  return transactionAmount < 0 ? 'credit' : 'debit'
}

/**
 * Put the bank leg of a debit/credit pair on the settlement ledger.
 *
 * Only a cash-ledger leg on the bank side moves: a learned 2440, 1510 or
 * 2890 there is a different booking, not a stale bank account. The counter
 * leg stays as proposed, another cash ledger included, so a transfer between
 * two of the company's own accounts keeps its other end. When the counter leg
 * already IS the settlement ledger, the pair is that transfer replayed from
 * its other end, and the proposed bank ledger becomes the counter leg
 * instead of the entry booking one account against itself.
 */
export function settleBankLeg<T extends { debit_account: string; credit_account: string }>(
  pair: T,
  bankSide: BankSide,
  settlementAccount: string,
): T {
  const bankLeg = bankSide === 'credit' ? pair.credit_account : pair.debit_account
  if (!isCashLedger(bankLeg) || bankLeg === settlementAccount) return pair
  const counterLeg = bankSide === 'credit' ? pair.debit_account : pair.credit_account
  const counter = counterLeg === settlementAccount ? bankLeg : counterLeg
  return bankSide === 'credit'
    ? { ...pair, debit_account: counter, credit_account: settlementAccount }
    : { ...pair, debit_account: settlementAccount, credit_account: counter }
}

/** A booking template line as templateBankLeg reads it. */
export interface TemplateBankLegLine {
  account: string
  side: BankSide
  /** The template's own tag: 'settlement' is "Betalning" in the editor. */
  type?: string
}

/**
 * The bank leg of a booking template (a company's mall) applied to a bank
 * transaction: the line that books the transaction's settlement ledger, and
 * whether its account has to move there.
 *
 * A mall books the accounts it was saved with. Only a line that stands for
 * "the bank" moves, and only when the mall does not already name the
 * transaction's ledger:
 *   1. A line on the bank side already on the settlement ledger is the bank
 *      leg as saved: nothing moves. A mall that names the ledger on its other
 *      side only (a transfer replayed from its other end, or a mall used
 *      against its direction) is prefilled as saved as well.
 *   2. Else the one cash ledger (19xx) line on the bank side is the bank the
 *      mall was saved on, or the 1930 placeholder: it moves to the settlement
 *      ledger, as settleBankLeg moves a proposal's.
 *   3. A mall without any cash ledger line can name its money leg only by
 *      the "Betalning" tag: the one line tagged settlement on the bank side
 *      moves. Booked as saved, the bank would not move at all, which
 *      commit_journal_entry refuses.
 * So a non-cash line of a mall that names a bank never moves. Moving the
 * line tagged settlement whatever its account turned a derived mall's
 * 1930 D / 1580 K into 1930 D / 1930 K (crm#1321): the tag is a best guess
 * of which leg is the payment, not an instruction to rewrite the account.
 *
 * Null when no single line is the bank leg: the mall is prefilled as saved
 * and the person sees what to change.
 */
export function templateBankLeg(
  lines: ReadonlyArray<TemplateBankLegLine>,
  bankSide: BankSide,
  settlementAccount: string,
): { index: number; moves: boolean } | null {
  const onBankSide = (test: (line: TemplateBankLegLine) => boolean) =>
    lines.flatMap((line, index) => (line.side === bankSide && test(line) ? [index] : []))

  const asSaved = onBankSide((line) => line.account === settlementAccount)
  if (asSaved.length > 0) return { index: asSaved[0], moves: false }
  if (lines.some((line) => line.account === settlementAccount)) return null

  const cash = onBankSide((line) => isCashLedger(line.account))
  if (cash.length > 0) return cash.length === 1 ? { index: cash[0], moves: true } : null
  if (lines.some((line) => isCashLedger(line.account))) return null

  const tagged = onBankSide((line) => line.type === 'settlement')
  return tagged.length === 1 ? { index: tagged[0], moves: true } : null
}
