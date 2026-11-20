/**
 * The bank side's answers to the ledger's "who signed off each account,
 * and through which date?" (contract: lib/reports/reconciliation-signoffs.ts).
 * Written out by hand and imported statically by the ledger: no lazy
 * loading, no lib/init, no event bus.
 *
 * Each member calls a function the reconciliation store already had,
 * unchanged, with the arguments the ledger passed it before the plug-in
 * point existed.
 */
import type { ReconciliationSignoffs } from '@/lib/reports/reconciliation-signoffs'
import { getLatestSignoffs, mapSignoffRow } from '@/lib/reconciliation/signoff-store'
import { bankAccountKey } from '@/lib/reconciliation/schemas'

export const RECONCILIATION_SIGNOFFS: ReconciliationSignoffs = Object.freeze<ReconciliationSignoffs>({
  module: 'transactions',
  latest: (...args) => getLatestSignoffs(...args),
  fromRow: (row) => mapSignoffRow(row),
  bankAccountKey: (cashAccountId) => bankAccountKey(cashAccountId),
})
