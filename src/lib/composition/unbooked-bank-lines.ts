/**
 * The bank side's answer to the ledger's "which bank lines still owe the
 * books a verifikat?" (contract: lib/bookkeeping/unbooked-bank-lines.ts).
 * Written out by hand and imported statically by the ledger: no lazy loading,
 * no lib/init, no event bus.
 *
 * One answer, the transactions block's predicate, called with exactly the
 * arguments the ledger passed it before the plug-in point existed.
 */
import type { UnbookedBankLines } from '@/lib/bookkeeping/unbooked-bank-lines'
import { countUnbookedBankTransactions } from '@/lib/transactions/unbooked'

export const UNBOOKED_BANK_LINES: UnbookedBankLines = Object.freeze<UnbookedBankLines>({
  module: 'transactions',
  count: (...args) => countUnbookedBankTransactions(...args),
})
