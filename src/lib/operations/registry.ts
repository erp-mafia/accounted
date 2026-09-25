/**
 * Every operation served through the machine doors (see ./types.ts). Adding
 * one here is what makes it reachable over MCP and through the staged
 * approval path; its v1 route file (`export const POST = v1OperationHandler(op)`)
 * makes it reachable over REST. operation-contract.test.ts fails until the
 * data tables it needs (scope catalogue, risk tiers, approval vocabulary)
 * know about it.
 */
import { dimensionsCreate, dimensionsDelete, dimensionsList, dimensionsUpdate } from './dimensions'
import { accountsActivate, accountsCreate, accountsDeactivate, accountsDelete, accountsUpdate } from './accounts'
import {
  settingsGet,
  settingsUpdate,
  settingsUpdateBookkeepingLock,
  settingsUpdateTaxProfile,
} from './company-settings'
import {
  cashAccountsCreate,
  cashAccountsSetPayeeDefault,
  cashAccountsSetPrimary,
  cashAccountsUpdate,
} from './cash-accounts'
import {
  fiscalPeriodsCloseExternal,
  fiscalPeriodsCreate,
  fiscalPeriodsReopenExternal,
  fiscalPeriodsUnlock,
  fiscalPeriodsUpdate,
} from './fiscal-periods'
import {
  salaryRunsAttachExpenseClaims,
  salaryRunsRevert,
  salaryRunsSendPayslips,
  salaryRunsUnapprove,
} from './salary-run-lifecycle'
import {
  expenseClaimsCreate,
  expenseClaimsDelete,
  expenseClaimsGet,
  expenseClaimsList,
  expenseClaimsRecordPayout,
  transactionsMatchExpensePayout,
} from './expense-claims'
import { invoicesBook, invoicesBulkBook, supplierInvoicesBook } from './invoice-booking'
import {
  supplierPaymentBatchesCancel,
  supplierPaymentBatchesCreate,
  supplierPaymentBatchesFile,
  supplierPaymentBatchesGet,
  supplierPaymentBatchesList,
  supplierPaymentBatchesPreview,
} from './supplier-payment-batches'
import type { AnyOperation } from './types'

export const OPERATIONS: readonly AnyOperation[] = [
  dimensionsList,
  dimensionsCreate,
  dimensionsUpdate,
  dimensionsDelete,
  accountsCreate,
  accountsUpdate,
  accountsDelete,
  accountsActivate,
  accountsDeactivate,
  settingsGet,
  settingsUpdate,
  settingsUpdateTaxProfile,
  settingsUpdateBookkeepingLock,
  cashAccountsCreate,
  cashAccountsUpdate,
  cashAccountsSetPrimary,
  cashAccountsSetPayeeDefault,
  fiscalPeriodsCreate,
  fiscalPeriodsUpdate,
  fiscalPeriodsUnlock,
  fiscalPeriodsCloseExternal,
  fiscalPeriodsReopenExternal,
  salaryRunsSendPayslips,
  salaryRunsRevert,
  salaryRunsUnapprove,
  salaryRunsAttachExpenseClaims,
  invoicesBook,
  invoicesBulkBook,
  supplierInvoicesBook,
  expenseClaimsList,
  expenseClaimsGet,
  expenseClaimsCreate,
  expenseClaimsDelete,
  expenseClaimsRecordPayout,
  transactionsMatchExpensePayout,
  supplierPaymentBatchesPreview,
  supplierPaymentBatchesCreate,
  supplierPaymentBatchesList,
  supplierPaymentBatchesGet,
  supplierPaymentBatchesFile,
  supplierPaymentBatchesCancel,
]

const byPendingType = new Map<string, AnyOperation>()
for (const op of OPERATIONS) {
  const pendingType = op.mcp?.stage?.pendingType
  if (pendingType) byPendingType.set(pendingType, op)
}

/** The operation an approved pending operation of this type runs, if any. */
export function operationForPendingType(pendingType: string): AnyOperation | undefined {
  return byPendingType.get(pendingType)
}
