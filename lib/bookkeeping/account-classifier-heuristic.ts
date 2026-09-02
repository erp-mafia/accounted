/**
 * Group-based account classification aligned with BAS 2026. Pure, no data
 * import: the server classifier (account-classifier.ts) consults the BAS
 * chart first and falls back to this; the client classifier
 * (account-classifier-client.ts) uses the lazily loaded chart the same way.
 */

import type { AccountType, NormalBalance } from '@/types'

export type { AccountType, NormalBalance }

export interface ClassifiedAccount {
  account_type: AccountType
  normal_balance: NormalBalance
}

/**
 * Class-8 groups are subtle: 80/81/82/83/87/88 are intäkter (revenue), 84/89
 * are kostnader (expense). The legacy heuristic defaulted everything not in
 * 83/84 to expense, which silently misclassified dividends, capital gains and
 * bokslutsdispositioner.
 */
export function classifyAccountHeuristic(accountNumber: string): ClassifiedAccount {
  const cls = parseInt(accountNumber[0], 10)
  const group = parseInt(accountNumber.substring(0, 2), 10)

  switch (cls) {
    case 1:
      return { account_type: 'asset', normal_balance: 'debit' }
    case 2:
      if (group === 20) return { account_type: 'equity', normal_balance: 'credit' }
      if (group === 21) return { account_type: 'untaxed_reserves', normal_balance: 'credit' }
      return { account_type: 'liability', normal_balance: 'credit' }
    case 3:
      return { account_type: 'revenue', normal_balance: 'credit' }
    case 4:
    case 5:
    case 6:
    case 7:
      return { account_type: 'expense', normal_balance: 'debit' }
    case 8:
      if (group >= 80 && group <= 83) return { account_type: 'revenue', normal_balance: 'credit' }
      if (group === 84) return { account_type: 'expense', normal_balance: 'debit' }
      if (group === 85) return { account_type: 'revenue', normal_balance: 'credit' }
      if (group === 86) return { account_type: 'expense', normal_balance: 'debit' }
      if (group === 87 || group === 88) return { account_type: 'revenue', normal_balance: 'credit' }
      if (group === 89) return { account_type: 'expense', normal_balance: 'debit' }
      return { account_type: 'expense', normal_balance: 'debit' }
    default:
      return { account_type: 'expense', normal_balance: 'debit' }
  }
}
