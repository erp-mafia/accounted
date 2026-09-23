/**
 * Client-side account classification: the lazily loaded BAS chart when it
 * has arrived (see lib/bookkeeping/bas-lazy.ts), the BAS-aligned heuristic
 * until then. Components call useBasReference() to re-render once the chart
 * lands so an authoritative answer replaces the heuristic one.
 */

import { getBasLoadedByNumber } from './bas-lazy'
import { classifyAccountHeuristic, type ClassifiedAccount } from './account-classifier-heuristic'

export function classifyAccountClient(accountNumber: string): ClassifiedAccount {
  const ref = getBasLoadedByNumber(accountNumber)
  if (ref) return { account_type: ref.account_type, normal_balance: ref.normal_balance }
  return classifyAccountHeuristic(accountNumber)
}
