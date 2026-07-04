import type { CashAccount } from '@/types'

export interface ResolvedAccount {
  account: string
  fallback: boolean
}

/**
 * Resolve the BAS ledger account number for a bank transaction.
 *
 * Resolution order:
 * 1. cash_account_id is set → return that cash account's ledger_account.
 * 2. Exactly one enabled account for the transaction currency → return it.
 * 3. Give up → return '1930' with fallback=true.
 */
export function resolveAccount(
  cashAccounts: CashAccount[],
  cashAccountId: string | null,
  currency: string,
): ResolvedAccount {
  if (cashAccountId) {
    const bound = cashAccounts.find((a) => a.id === cashAccountId)
    // If an explicit ID was given but not found, skip the currency fallback and
    // return 1930 with fallback=true: the missing link is a data integrity signal.
    if (bound) return { account: bound.ledger_account, fallback: false }
    return { account: '1930', fallback: true }
  }
  const sameCurrency = cashAccounts.filter((a) => a.enabled && a.currency === currency)
  if (sameCurrency.length === 1) return { account: sameCurrency[0].ledger_account, fallback: false }
  return { account: '1930', fallback: true }
}
