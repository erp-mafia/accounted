/**
 * The bank side's answers to the ledger's "what did the reconciliation of
 * each account hold at the balansdag?" (contract:
 * lib/reports/closing-reconciliation.ts). Written out by hand and imported
 * statically by the ledger: no lazy loading, no lib/init, no event bus.
 *
 * Each member calls a function the reconciliation block already had,
 * unchanged, with the arguments the ledger passed it before the plug-in
 * point existed; the specification providers are read when asked for, as
 * the ledger read them.
 */
import type { ClosingReconciliation } from '@/lib/reports/closing-reconciliation'
import { listReconciliationAccounts } from '@/lib/reconciliation/service'
import {
  loadBalanceSheetSnapshot,
  loadSpecificationAmounts,
  SPECIFICATION_PROVIDERS,
} from '@/lib/reconciliation/manual-reconciliation'
import { listAttachmentRowsInRange } from '@/lib/reconciliation/attachments-store'

export const CLOSING_RECONCILIATION: ClosingReconciliation = Object.freeze<ClosingReconciliation>({
  module: 'transactions',
  listAccounts: (...args) => listReconciliationAccounts(...args),
  balanceSheetSnapshot: (...args) => loadBalanceSheetSnapshot(...args),
  specificationAmounts: (...args) => loadSpecificationAmounts(...args),
  get specificationProviders() {
    return SPECIFICATION_PROVIDERS
  },
  attachmentRowsInRange: (...args) => listAttachmentRowsInRange(...args),
})
