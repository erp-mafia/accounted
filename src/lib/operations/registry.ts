/**
 * Every operation served through the machine doors (see ./types.ts). Adding
 * one here is what makes it reachable over MCP and through the staged
 * approval path; its v1 route file (`export const POST = v1OperationHandler(op)`)
 * makes it reachable over REST. operation-contract.test.ts fails until the
 * data tables it needs (scope catalogue, risk tiers, approval vocabulary)
 * know about it.
 */
import {
  dimensionsCreate,
  dimensionsDelete,
  dimensionsList,
  dimensionsUpdate,
} from './dimensions'
import {
  accountsActivate,
  accountsCreate,
  accountsDeactivate,
  accountsDelete,
  accountsUpdate,
} from './accounts'
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
  openingBalancesCorrect,
  openingBalancesSetManual,
} from './opening-balances'
import {
  salaryRunsAttachExpenseClaims,
  salaryRunsRevert,
  salaryRunsSendPayslips,
  salaryRunsUnapprove,
} from './salary-run-lifecycle'
import {
  invoicesBook,
  invoicesBulkBook,
  supplierInvoicesBook,
} from './invoice-booking'
import {
  invoicesPeppolDeliveries,
  invoicesPeppolReadiness,
  invoicesSendPeppol,
  peppolGetRegistration,
  peppolRegister,
  peppolRequestAccess,
} from './peppol'
import {
  supplierInvoicesDelete,
  supplierInvoicesMarkBankEntered,
  supplierInvoicesUncredit,
  supplierInvoicesUpdateItemAccount,
} from './supplier-invoice-actions'
import {
  expenseClaimsCreate,
  expenseClaimsDelete,
  expenseClaimsGet,
  expenseClaimsList,
  expenseClaimsRecordPayout,
  transactionsMatchExpensePayout,
} from './expense-claims'
import {
  supplierPaymentBatchesCancel,
  supplierPaymentBatchesCreate,
  supplierPaymentBatchesFile,
  supplierPaymentBatchesGet,
  supplierPaymentBatchesList,
  supplierPaymentBatchesPreview,
} from './supplier-payment-batches'
import {
  documentsDelete,
  documentsGet,
  documentsList,
  transactionsAttachDocument,
  transactionsDetachDocument,
} from './documents'
import {
  inboxItemsConvertToSupplierInvoice,
  inboxItemsDelete,
  inboxItemsGet,
  inboxItemsList,
  inboxItemsUnmatchTransaction,
  inboxItemsUpdateExtractedData,
} from './inbox-items'
import {
  inboxItemsMatchSupplier,
  inboxItemsMatchTransaction,
} from './inbox-matches'
import {
  transactionsBulkBook,
  transactionsDelete,
  transactionsLinkJournalEntry,
  transactionsMatchBatch,
  transactionsRefreshExchangeRate,
  transactionsUpdate,
} from './transactions'
import {
  importsBankUndo,
  importsSieResume,
  importsSieUndo,
} from './imports'
import {
  importsSkattekontoFile,
} from './skattekonto-file'
import {
  journalEntriesBatchNoDocumentRequired,
  journalEntriesClearNoDocumentRequired,
  journalEntriesCorrectMetadata,
  journalEntriesRattelseLog,
  journalEntriesRedate,
  journalEntriesSetNoDocumentRequired,
  journalEntriesSetNote,
  journalEntriesStrikeLines,
  journalEntriesUpdateDraft,
} from './journal-entries'
import {
  auditTrailList,
  reportsBehandlingshistorik,
  reportsBokslutsbilagor,
  reportsDimensionPnl,
  reportsInk2,
  reportsKassaflodesanalys,
  reportsKpi,
  reportsNeBilaga,
  reportsPeriodiskSammanstallning,
} from './filing-reports'
import {
  reportsVatSettlementProposal,
  vatBookSettlement,
} from './vat-settlement'
import {
  arsredovisningAddSignatory,
  arsredovisningCreateVersion,
  arsredovisningListSignatories,
  arsredovisningRecordSignature,
  arsredovisningRemoveSignatory,
  arsredovisningUpdateCompliance,
  arsredovisningUpdateNarrative,
  arsredovisningValidateIxbrl,
} from './arsredovisning'
import {
  skattekontoSync,
  skatteverketAgiValidateHuvuduppgift,
  skatteverketAgiValidateIndividuppgift,
} from './skatteverket-helpers'
import type { AnyOperation } from './types'

export const OPERATIONS: readonly AnyOperation[] = [
  // dimensions
  dimensionsList,
  dimensionsCreate,
  dimensionsUpdate,
  dimensionsDelete,
  // accounts
  accountsCreate,
  accountsUpdate,
  accountsDelete,
  accountsActivate,
  accountsDeactivate,
  // company-settings
  settingsGet,
  settingsUpdate,
  settingsUpdateTaxProfile,
  settingsUpdateBookkeepingLock,
  // cash-accounts
  cashAccountsCreate,
  cashAccountsUpdate,
  cashAccountsSetPrimary,
  cashAccountsSetPayeeDefault,
  // fiscal-periods
  fiscalPeriodsCreate,
  fiscalPeriodsUpdate,
  fiscalPeriodsUnlock,
  fiscalPeriodsCloseExternal,
  fiscalPeriodsReopenExternal,
  // opening-balances
  openingBalancesSetManual,
  openingBalancesCorrect,
  // salary-run-lifecycle
  salaryRunsSendPayslips,
  salaryRunsRevert,
  salaryRunsUnapprove,
  salaryRunsAttachExpenseClaims,
  // invoice-booking
  invoicesBook,
  invoicesBulkBook,
  supplierInvoicesBook,
  // peppol
  invoicesPeppolReadiness,
  invoicesSendPeppol,
  invoicesPeppolDeliveries,
  peppolGetRegistration,
  peppolRegister,
  peppolRequestAccess,
  // supplier-invoice-actions
  supplierInvoicesDelete,
  supplierInvoicesUncredit,
  supplierInvoicesUpdateItemAccount,
  supplierInvoicesMarkBankEntered,
  // expense-claims
  expenseClaimsList,
  expenseClaimsGet,
  expenseClaimsCreate,
  expenseClaimsDelete,
  expenseClaimsRecordPayout,
  transactionsMatchExpensePayout,
  // supplier-payment-batches
  supplierPaymentBatchesPreview,
  supplierPaymentBatchesCreate,
  supplierPaymentBatchesList,
  supplierPaymentBatchesGet,
  supplierPaymentBatchesFile,
  supplierPaymentBatchesCancel,
  // documents
  documentsList,
  documentsGet,
  documentsDelete,
  transactionsAttachDocument,
  transactionsDetachDocument,
  // inbox-items
  inboxItemsList,
  inboxItemsGet,
  inboxItemsUpdateExtractedData,
  inboxItemsDelete,
  inboxItemsUnmatchTransaction,
  inboxItemsConvertToSupplierInvoice,
  // inbox-matches
  inboxItemsMatchSupplier,
  inboxItemsMatchTransaction,
  // transactions
  transactionsDelete,
  transactionsUpdate,
  transactionsRefreshExchangeRate,
  transactionsLinkJournalEntry,
  transactionsMatchBatch,
  transactionsBulkBook,
  // imports
  importsBankUndo,
  importsSieUndo,
  importsSieResume,
  // skattekonto-file
  importsSkattekontoFile,
  // journal-entries
  journalEntriesUpdateDraft,
  journalEntriesSetNote,
  journalEntriesCorrectMetadata,
  journalEntriesStrikeLines,
  journalEntriesRedate,
  journalEntriesSetNoDocumentRequired,
  journalEntriesClearNoDocumentRequired,
  journalEntriesBatchNoDocumentRequired,
  journalEntriesRattelseLog,
  // filing-reports
  reportsInk2,
  reportsNeBilaga,
  reportsPeriodiskSammanstallning,
  reportsKassaflodesanalys,
  reportsBehandlingshistorik,
  reportsBokslutsbilagor,
  reportsKpi,
  reportsDimensionPnl,
  auditTrailList,
  // vat-settlement
  reportsVatSettlementProposal,
  vatBookSettlement,
  // arsredovisning
  arsredovisningUpdateNarrative,
  arsredovisningUpdateCompliance,
  arsredovisningCreateVersion,
  arsredovisningListSignatories,
  arsredovisningAddSignatory,
  arsredovisningRecordSignature,
  arsredovisningRemoveSignatory,
  arsredovisningValidateIxbrl,
  // skatteverket-helpers
  skatteverketAgiValidateHuvuduppgift,
  skatteverketAgiValidateIndividuppgift,
  skattekontoSync,
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
