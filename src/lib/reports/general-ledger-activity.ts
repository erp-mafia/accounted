import type { GeneralLedgerAccount } from './general-ledger'

/** A ledger account is active when its selected interval has a balance or vouchers. */
export function isActiveLedgerAccount(account: Pick<GeneralLedgerAccount, 'closing_balance' | 'lines'>): boolean {
  return account.closing_balance !== 0 || account.lines.length > 0
}
