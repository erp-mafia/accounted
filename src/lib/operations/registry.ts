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
import { settingsGetSkattekontoAccount, settingsUpdateSkattekontoAccount } from './skattekonto-account'
import {
  cashAccountsCreate,
  cashAccountsSetPayeeDefault,
  cashAccountsSetPrimary,
  cashAccountsUpdate,
} from './cash-accounts'
import {
  fiscalPeriodsCloseExternal,
  fiscalPeriodsCreate,
  fiscalPeriodsDelete,
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
import { salaryForaReportGet } from './salary-fora-report'
import { salaryVacationLiabilityReconcile } from './salary-vacation-liability'
import {
  invoicesBook,
  invoicesBulkBook,
  supplierInvoicesBook,
} from './invoice-booking'
import { invoicesCancel } from './invoice-cancel'
import { invoicesLatePaymentInterestGet } from './late-payment-interest'
import {
  invoicesPeppolDeliveries,
  invoicesPeppolReadiness,
  invoicesSendPeppol,
  peppolGetRegistration,
  peppolRegister,
  peppolRequestAccess,
} from './peppol'
import { suppliersCreate, suppliersUpdate } from './suppliers'
import { customersMerge, customersMergeUndo } from './customers'
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
import { inboxItemsSetPurchaseCategory } from './inbox-purchase-category'
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
import { accrualSchedulesReplan } from './accrual-schedules'
import {
  auditTrailList,
  reportsBehandlingshistorik,
  reportsBokslutsbilagor,
  reportsDimensionCross,
  reportsDimensionCrossLines,
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
  arsredovisningRequestSignatures,
  arsredovisningRemoveSignatory,
  arsredovisningUpdateCompliance,
  arsredovisningUpdateNarrative,
  arsredovisningValidateIxbrl,
} from './arsredovisning'
import { reportsForenklatArsbokslut } from './forenklat-arsbokslut'
import { MEASURE_OPERATIONS } from './measures'
import { CASH_FORECAST_OPERATIONS } from './cash-forecast'
import { UNEXPLAINED_OPERATIONS } from './unexplained'
import {
  skattekontoSync,
  skatteverketAgiValidateHuvuduppgift,
  skatteverketAgiValidateIndividuppgift,
} from './skatteverket-helpers'
import {
  posSalesClearingBalance,
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
import { webshopOrdersBook, webshopOrdersBookDay, webshopOrdersGet, webshopOrdersList, webshopOrdersOssUnderlag } from './webshop-orders'
import { COLLECTIONS_OPERATION_LIST } from './collections'
import { PACKAGE_OPERATIONS } from './packages'
import { K3_OPERATIONS } from './k3'
import { BUDGET_OPERATIONS } from './budgets'
import { BANK_FEED_OPERATIONS } from './bank-feed'
import { PAYMENT_SIGNING_LINK_OPERATIONS } from './payment-signing-links'
import { SIGNING_REQUEST_OPERATIONS } from './signing-requests'
import { BOLAGET_OPERATIONS } from './bolaget'
import { BOLAGET_CAPITAL_OPERATIONS } from './bolaget-capital'
import { BOLAGET_OWNER_TAX_OPERATIONS } from './bolaget-owner-tax'
import { CORPORATE_MEETING_OPERATIONS } from './corporate-meetings'
import { bolagetRollout } from '@/lib/env/bolaget-switch'
import { SUPPLIER_INVOICE_ATTEST_OPERATIONS } from './supplier-invoice-attest'
import { readCollectionsEnv } from '@/lib/collections/flags'
import { CUSTOMER_LOSS_OPERATION_LIST } from './customer-loss'
import { COUNTERPARTY_SETOFF_OPERATION_LIST } from './counterparty-setoff'
import { counterpartySetoffEnabled } from '@/lib/env/counterparty-setoff-switch'
import { customerLossEnabled } from '@/lib/env/customer-loss-switch'
import { COMMITMENTS_OPERATIONS } from './commitments'
import { commitmentsRolloutConfigured } from '@/lib/env/commitments-switch'
import { TAX_LOSS_CARRYFORWARD_OPERATIONS } from './tax-loss-carryforwards'
import { lossCarryforwardDiscoverable } from '@/lib/env/loss-carryforward-switch'
import { STOCK_COUNT_OPERATION_LIST } from './inventory-counts'
import { stockCountConfigured } from '@/lib/env/stock-count-switch'
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
  // skattekonto-account (PH 175)
  settingsGetSkattekontoAccount,
  settingsUpdateSkattekontoAccount,
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
  fiscalPeriodsDelete,
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
  // salary-fora-report (v1 + MCP, summary only: the file is the salary run page's download)
  salaryForaReportGet,
  // salary-vacation-liability (v1; the dashboard route calls the same service)
  salaryVacationLiabilityReconcile,
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
  // late-payment-interest (dröjsmålsränta per invoice; the dashboard route calls the same service)
  invoicesLatePaymentInterestGet,
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
  // customers (merge; create, update, list, get and archive are hand-written doors)
  customersMerge,
  customersMergeUndo,
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
  // inbox purchase category
  inboxItemsSetPurchaseCategory,
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
  // accrual-schedules (periodisering)
  accrualSchedulesReplan,
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
  reportsDimensionCross,
  reportsDimensionCrossLines,
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
  arsredovisningRequestSignatures,
  arsredovisningRemoveSignatory,
  arsredovisningValidateIxbrl,
  // forenklat-arsbokslut (ideell förening, BFNAR 2010:1)
  reportsForenklatArsbokslut,
  // measures: defined figures equal to their report, explained down to every line (lib/measures)
  ...MEASURE_OPERATIONS,
  // cash-forecast: the 13-week liquidity forecast and its rows (lib/forecast); the rows are not bookkeeping and write directly
  ...CASH_FORECAST_OPERATIONS,
  // unexplained: expected-zero checks with explain handles (lib/unexplained)
  ...UNEXPLAINED_OPERATIONS,
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
  posSalesClearingBalance,
  posSalesFetch,
  // webshop-orders (Shopify, WooCommerce, Zettle): read the synced rows, book one with the caller's lines,
  // book a day and payment method as one verifikat, and the OSS underlag the booked orders add up to
  webshopOrdersList,
  webshopOrdersGet,
  webshopOrdersBook,
  webshopOrdersBookDay,
  webshopOrdersOssUnderlag,
  // bank-feed (reading a bank with BankID through Open Payments): the reads and the signatory link bind v1 + MCP;
  // start, poll, restart, select and disconnect have no door (a person's BankID and a person's choice), and sync
  // is already served by POST /bank-connections/:connectionId/sync and gnubok_sync_bank for every aggregator.
  ...BANK_FEED_OPERATIONS,
  // The payment signing link: a person without a login signs approved bank payments with BankID; agents request it, staged.
  ...PAYMENT_SIGNING_LINK_OPERATIONS,
  ...SIGNING_REQUEST_OPERATIONS,
  // The attest policy for supplier invoices: read it (also as an MCP tool), save it (v1 only: owners and admins), and one invoice's attest trail.
  ...SUPPLIER_INVOICE_ATTEST_OPERATIONS,
  // Packages: read their status (winding down included) and stage a switch on or off; approval by an owner or admin.
  ...PACKAGE_OPERATIONS,
  // K3 (accounted#111): nedskrivning, component replacement, a building's tax plan, the deferred tax inputs,
  // the 18.7 model, and the transition to K3 with its component split.
  ...K3_OPERATIONS,
  // Budgets (accounted#134): named versions per fiscal year, their amounts, copy and spread, and budget against actual.
  ...BUDGET_OPERATIONS,
]

/**
 * Every operation defined, discoverable or not: the contract test checks
 * them all, and the staged-operation commit path finds each by its pending
 * type, so an operation staged while its feature was on still commits.
 */
export const ALL_OPERATIONS: readonly AnyOperation[] = [
  ...CORE_OPERATIONS,
  ...COLLECTIONS_OPERATION_LIST,
  ...CUSTOMER_LOSS_OPERATION_LIST,
  ...COUNTERPARTY_SETOFF_OPERATION_LIST,
  ...BOLAGET_OPERATIONS,
  ...BOLAGET_CAPITAL_OPERATIONS,
  ...BOLAGET_OWNER_TAX_OPERATIONS,
  ...CORPORATE_MEETING_OPERATIONS,
  ...COMMITMENTS_OPERATIONS,
  ...TAX_LOSS_CARRYFORWARD_OPERATIONS,
  ...STOCK_COUNT_OPERATION_LIST,
]

/**
 * The operations the machine doors serve (MCP tools, the search index):
 * the collections operations only while COLLECTIONS_ENABLED is set at
 * module load, so nothing about them is discoverable while the feature is
 * dark. Each run() still checks the start gates per company (flags.ts).
 */
export const OPERATIONS: readonly AnyOperation[] = [
  ...CORE_OPERATIONS,
  ...(readCollectionsEnv().enabled ? COLLECTIONS_OPERATION_LIST : []),
  // Kundförlust likewise only while CUSTOMER_LOSS_ENABLED is set.
  ...(customerLossEnabled() ? CUSTOMER_LOSS_OPERATION_LIST : []),
  // Kvittning likewise only while COUNTERPARTY_SETOFF_ENABLED is set.
  ...(counterpartySetoffEnabled() ? COUNTERPARTY_SETOFF_OPERATION_LIST : []),
  // The Bolaget registers only while BOLAGET_COMPANY_IDS names a company; each run() checks the company too.
  ...(bolagetRollout() === 'all' || bolagetRollout().length > 0 ? BOLAGET_OPERATIONS : []),
  ...(bolagetRollout() === 'all' || bolagetRollout().length > 0 ? BOLAGET_CAPITAL_OPERATIONS : []),
  ...(bolagetRollout() === 'all' || bolagetRollout().length > 0 ? BOLAGET_OWNER_TAX_OPERATIONS : []),
  // Meetings and minutes roll out with the registers (same switch, same per-company check in run()).
  ...(bolagetRollout() === 'all' || bolagetRollout().length > 0 ? CORPORATE_MEETING_OPERATIONS : []),
  // Avtal och åtaganden (Bolaget) only while BOLAGET_COMPANY_IDS names a
  // company; each run() still refuses a company outside the list.
  ...(commitmentsRolloutConfigured() ? COMMITMENTS_OPERATIONS : []),
  // The underskottsregister only while BOLAGET_COMPANY_IDS opens it for some
  // company; each run still checks the company (lib/bokslut/loss-carryforward).
  ...(lossCarryforwardDiscoverable() ? TAX_LOSS_CARRYFORWARD_OPERATIONS : []),
  // The year-end stock count likewise only while BOLAGET_COMPANY_IDS names a company.
  ...(stockCountConfigured() ? STOCK_COUNT_OPERATION_LIST : []),
]

const byPendingType = new Map<string, AnyOperation>()
for (const op of ALL_OPERATIONS) {
  const pendingType = op.mcp?.stage?.pendingType
  if (pendingType) byPendingType.set(pendingType, op)
}

/** The operation an approved pending operation of this type runs, if any. */
export function operationForPendingType(pendingType: string): AnyOperation | undefined {
  return byPendingType.get(pendingType)
}
