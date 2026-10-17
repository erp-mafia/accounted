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
  dimensionRulesCreate,
  dimensionRulesDelete,
  dimensionRulesList,
  dimensionRulesUpdate,
} from './dimension-rules'
import { dimensionsRetagLines, dimensionsRetagLog } from './dimension-retag'
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
  openingBalancesSplitPerProject,
  openingBalancesSplitPreview,
} from './opening-balances'
import {
  salaryRunsAttachExpenseClaims,
  salaryRunsRevert,
  salaryRunsSendPayslips,
  salaryRunsUnapprove,
} from './salary-run-lifecycle'
import {
  salaryRunsCorrect,
  salaryRunsEmployeesAdd,
  salaryRunsEmployeesRemove,
  salaryRunsLinesCreate,
  salaryRunsLinesDelete,
  salaryRunsList,
  salaryRunsMarkPaid,
} from './salary-run-structure'
import {
  employeesBenefitsCreate,
  employeesBenefitsDelete,
  employeesBenefitsList,
  employeesBenefitsUpdate,
  employeesDelete,
  employeesRecurringLinesCreate,
  employeesRecurringLinesDelete,
  employeesRecurringLinesList,
  employeesRecurringLinesUpdate,
  employeesWorkedDaysDelete,
  employeesWorkedDaysList,
  employeesWorkedDaysUpsert,
} from './salary-employee-setup'
import { salaryRunsPaymentFilesList } from './salary-payment-files'
import {
  invoicesBook,
  invoicesBulkBook,
  supplierInvoicesBook,
} from './invoice-booking'
import { invoicesCancel } from './invoice-cancel'
import {
  invoicesPeppolDeliveries,
  invoicesPeppolReadiness,
  invoicesSendPeppol,
  peppolGetRegistration,
  peppolRegister,
  peppolRequestAccess,
} from './peppol'
import { suppliersCreate, suppliersUpdate } from './suppliers'
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
  paymentOrdersApprove,
  paymentOrdersCancel,
  paymentOrdersGet,
  paymentOrdersList,
  paymentOrdersPrepare,
  paymentOrdersUnapprove,
  paymentsAvailability,
  paymentsSigningLink,
  paymentsUsage,
  paymentsVerification,
  paymentsVerificationStart,
} from './payment-orders'
import { paymentsCompanyGiroNumbers, paymentsLookupCreditor } from './bankgiro-lookup'
import { supplierPayeesConfirm } from './supplier-payees'
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
  journalEntriesCancelDraft,
} from './journal-entries'
import {
  auditTrailList,
  reportsBehandlingshistorik,
  reportsBokslutsbilagor,
  reportsDimensionPnl,
  reportsInk2,
  reportsInk3,
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
  vatFilingsList,
  vatFilingsMark,
  vatFilingsUnmark,
} from './vat-filings'
import { vatCheckReviewsMark } from './vat-check-reviews'
import { agiFilingsMark } from './agi-filings'
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
import { reportsForenklatArsbokslut } from './forenklat-arsbokslut'
import { MEASURE_OPERATIONS } from './measures'
import {
  skattekontoSync,
  skatteverketAgiValidateHuvuduppgift,
  skatteverketAgiValidateIndividuppgift,
} from './skatteverket-helpers'
import {
  posSalesConnect,
  posSalesConnectionsList,
  posSalesDayBook,
  posSalesDayGet,
  posSalesDaysList,
  posSalesDisconnect,
  posSalesFetch,
  posSalesUpdateSettings,
  posSalesVenuesList,
} from './pos-sales'
import { COLLECTIONS_OPERATION_LIST } from './collections'
import { BANK_FEED_OPERATIONS } from './bank-feed'
import { PAYMENT_SIGNING_LINK_OPERATIONS } from './payment-signing-links'
import { SUPPLIER_INVOICE_ATTEST_OPERATIONS } from './supplier-invoice-attest'
import { readCollectionsEnv } from '@/lib/collections/flags'
import type { AnyOperation } from './types'

const CORE_OPERATIONS: readonly AnyOperation[] = [
  // dimensions
  dimensionsList,
  dimensionsCreate,
  dimensionsUpdate,
  dimensionsDelete,
  // dimension-rules
  dimensionRulesList,
  dimensionRulesCreate,
  dimensionRulesUpdate,
  dimensionRulesDelete,
  // dimension-retag (the write is v1 only: MCP has gnubok_tag_journal_lines over the same service)
  dimensionsRetagLines,
  dimensionsRetagLog,
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
  openingBalancesSplitPreview,
  openingBalancesSplitPerProject,
  // salary-run-lifecycle
  salaryRunsSendPayslips,
  salaryRunsRevert,
  salaryRunsUnapprove,
  salaryRunsAttachExpenseClaims,
  // salary-run-structure (MCP only: the v1 doors are the hand-written salary-run routes)
  salaryRunsList,
  salaryRunsEmployeesAdd,
  salaryRunsEmployeesRemove,
  salaryRunsLinesCreate,
  salaryRunsLinesDelete,
  salaryRunsCorrect,
  salaryRunsMarkPaid,
  // salary-payment-files (MCP only, metadata only: no door builds or hands over a file)
  salaryRunsPaymentFilesList,
  // salary-employee-setup (MCP only: the v1 doors are the hand-written employee routes)
  employeesWorkedDaysList,
  employeesWorkedDaysUpsert,
  employeesWorkedDaysDelete,
  employeesBenefitsList,
  employeesBenefitsCreate,
  employeesBenefitsUpdate,
  employeesBenefitsDelete,
  employeesRecurringLinesList,
  employeesRecurringLinesCreate,
  employeesRecurringLinesUpdate,
  employeesRecurringLinesDelete,
  employeesDelete,
  // invoice-booking
  invoicesBook,
  invoicesBulkBook,
  supplierInvoicesBook,
  // invoice-cancel (makulera a quote or proforma; the dashboard route calls the same service)
  invoicesCancel,
  // peppol
  invoicesPeppolReadiness,
  invoicesSendPeppol,
  invoicesPeppolDeliveries,
  peppolGetRegistration,
  peppolRegister,
  peppolRequestAccess,
  // suppliers (create and update: list, get and archive are hand-written doors)
  suppliersCreate,
  suppliersUpdate,
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
  // payment-orders (bank payments; approve is v1 only, signing is a person's act: no door starts a BankID signing)
  paymentOrdersList,
  paymentOrdersGet,
  paymentOrdersPrepare,
  paymentOrdersApprove,
  paymentOrdersUnapprove,
  paymentOrdersCancel,
  // Bankgiro Lookup (premium, behind OPENPAYMENTS_BANKGIRO_LOOKUP): reads only.
  paymentsLookupCreditor,
  paymentsCompanyGiroNumbers,
  paymentsAvailability,
  paymentsUsage,
  paymentsVerification,
  paymentsVerificationStart,
  paymentsSigningLink,
  // changed supplier bank details: MCP stages the approval, a person gives it in the web UI
  supplierPayeesConfirm,
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
  journalEntriesCancelDraft,
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
  reportsInk3,
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
  // vat-filings (MCP only: the v1 doors are the hand-written filings route)
  vatFilingsList,
  vatFilingsMark,
  vatFilingsUnmark,
  // vat-check-reviews (MCP only: the web view has its own check-reviews route)
  vatCheckReviewsMark,
  // agi-filings (MCP only: the dashboard completes a deadline by id)
  agiFilingsMark,
  // arsredovisning
  arsredovisningUpdateNarrative,
  arsredovisningUpdateCompliance,
  arsredovisningCreateVersion,
  arsredovisningListSignatories,
  arsredovisningAddSignatory,
  arsredovisningRecordSignature,
  arsredovisningRemoveSignatory,
  arsredovisningValidateIxbrl,
  // forenklat-arsbokslut (ideell förening, BFNAR 2010:1)
  reportsForenklatArsbokslut,
  // measures: defined figures equal to their report, explained down to every line (lib/measures)
  ...MEASURE_OPERATIONS,
  // skatteverket-helpers
  skatteverketAgiValidateHuvuduppgift,
  skatteverketAgiValidateIndividuppgift,
  skattekontoSync,
  // pos-sales (kassasystem via Accounted Connect; the fetch is v1 only)
  posSalesConnectionsList,
  posSalesVenuesList,
  posSalesConnect,
  posSalesDisconnect,
  posSalesUpdateSettings,
  posSalesDaysList,
  posSalesDayGet,
  posSalesDayBook,
  posSalesFetch,
  // bank-feed (reading a bank with BankID through Open Payments): the reads and the signatory link bind v1 + MCP;
  // start, poll, restart, select and disconnect have no door (a person's BankID and a person's choice), and sync
  // is already served by POST /bank-connections/:connectionId/sync and gnubok_sync_bank for every aggregator.
  ...BANK_FEED_OPERATIONS,
  // The payment signing link: a person without a login signs approved bank payments with BankID; agents request it, staged.
  ...PAYMENT_SIGNING_LINK_OPERATIONS,
  // The attest policy for supplier invoices: read it (also as an MCP tool), save it (v1 only: owners and admins), and one invoice's attest trail.
  ...SUPPLIER_INVOICE_ATTEST_OPERATIONS,
]

/**
 * Every operation defined, discoverable or not: the contract test checks
 * them all, and the staged-operation commit path finds each by its pending
 * type, so an operation staged while its feature was on still commits.
 */
export const ALL_OPERATIONS: readonly AnyOperation[] = [...CORE_OPERATIONS, ...COLLECTIONS_OPERATION_LIST]

/**
 * The operations the machine doors serve (MCP tools, the search index):
 * the collections operations only while COLLECTIONS_ENABLED is set at
 * module load, so nothing about them is discoverable while the feature is
 * dark. Each run() still checks the start gates per company (flags.ts).
 */
export const OPERATIONS: readonly AnyOperation[] = readCollectionsEnv().enabled ? ALL_OPERATIONS : CORE_OPERATIONS

const byPendingType = new Map<string, AnyOperation>()
for (const op of ALL_OPERATIONS) {
  const pendingType = op.mcp?.stage?.pendingType
  if (pendingType) byPendingType.set(pendingType, op)
}

/** The operation an approved pending operation of this type runs, if any. */
export function operationForPendingType(pendingType: string): AnyOperation | undefined {
  return byPendingType.get(pendingType)
}
