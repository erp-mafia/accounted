/**
 * The owner loan register against the ledger: per BAS account, what the
 * active loans on it say is owed on a day, and the account's balance in the
 * books on that day. A difference is a warning (a repayment not entered
 * in the register, a loan booked but not registered, another debt on the
 * same account); nothing is corrected automatically. Read-only and pure:
 * the balances are read by the caller.
 */
import { roundOre } from '@/lib/money'
import { loanActiveOn, type OwnerLoanRow } from './loans'

export interface LoanAccountReconciliation {
  account: string
  /** Outstanding per the register on the day (sum of the active loans on the account). */
  register_amount: number
  /** The account's balance in the ledger on the day, as a positive amount owed; null when it could not be read. */
  ledger_amount: number | null
  /** ledger_amount - register_amount; null when the ledger could not be read. */
  difference: number | null
  matches: boolean | null
  owner_loan_ids: string[]
}

/**
 * `ledgerDebitBalance` is debit minus credit per account (the ledger's
 * sign): an asset (the company lends) is owed when it is positive, a
 * liability (the company borrows) when it is negative.
 */
export function reconcileLoanAccounts(
  loans: readonly Pick<OwnerLoanRow, 'id' | 'kind' | 'account' | 'outstanding' | 'status' | 'start_date' | 'repaid_on'>[],
  ledgerDebitBalance: ReadonlyMap<string, number | null>,
  day: string,
): LoanAccountReconciliation[] {
  const byAccount = new Map<string, { amount: number; ids: string[] }>()
  for (const loan of loans) {
    if (loan.kind !== 'loan' || !loan.account || !loanActiveOn(loan, day)) continue
    const entry = byAccount.get(loan.account) ?? { amount: 0, ids: [] }
    entry.amount = roundOre(entry.amount + loan.outstanding)
    entry.ids.push(loan.id)
    byAccount.set(loan.account, entry)
  }
  // An account the register used before (a repaid loan) still reconciles: a balance left on it is worth a look.
  for (const loan of loans) {
    if (loan.kind === 'loan' && loan.account && loan.status !== 'cancelled' && !byAccount.has(loan.account) && loan.start_date <= day) {
      byAccount.set(loan.account, { amount: 0, ids: [] })
    }
  }
  return [...byAccount.entries()]
    .map(([account, entry]) => {
      const raw = ledgerDebitBalance.get(account)
      const ledger = raw === null || raw === undefined ? null : roundOre(account.startsWith('1') ? raw : -raw)
      const difference = ledger === null ? null : roundOre(ledger - entry.amount)
      return {
        account,
        register_amount: entry.amount,
        ledger_amount: ledger,
        difference,
        matches: difference === null ? null : Math.abs(difference) < 0.005,
        owner_loan_ids: entry.ids,
      }
    })
    .sort((a, b) => a.account.localeCompare(b.account))
}
