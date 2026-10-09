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
 * (proposalLinesToFormLines).
 */

export type BankSide = 'debit' | 'credit'

/** A company cash ledger: the BAS 19xx accounts (kassa, plusgiro, bank). */
export function isCashLedger(account: string | null | undefined): account is string {
  return !!account && /^19\d{2}$/.test(account)
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
