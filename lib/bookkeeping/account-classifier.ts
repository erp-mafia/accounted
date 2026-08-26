import { getBASReference } from './bas-reference'
import { classifyAccountHeuristic, type ClassifiedAccount } from './account-classifier-heuristic'

export type { AccountType, ClassifiedAccount, NormalBalance } from './account-classifier-heuristic'


/**
 * Map a 4-digit BAS account number to its account_type and normal_balance.
 *
 * Strategy:
 *   1. If the number is in BAS_REFERENCE, return that authoritative entry.
 *   2. Otherwise fall back to a group-based heuristic aligned with BAS 2026.
 *
 * Class-8 groups are subtle: 80/81/82/83/87/88 are intäkter (revenue), 84/89 are
 * kostnader (expense). The legacy heuristic defaulted everything not in 83/84 to
 * expense, which silently misclassified dividends, capital gains, and
 * bokslutsdispositioner.
 */
export function classifyAccount(accountNumber: string): ClassifiedAccount {
  const ref = getBASReference(accountNumber)
  if (ref) {
    return { account_type: ref.account_type, normal_balance: ref.normal_balance }
  }
  return classifyAccountHeuristic(accountNumber)
}
