/**
 * Unified entry point for executing a pending_operation.
 *
 * Used by:
 *   - The web UI commit route (app/api/pending-operations/[id]/commit/route.ts)
 *     when a human clicks "Approve"
 *   - The bulk-approval route (app/api/pending-operations/bulk-commit/route.ts)
 *   - The MCP server (extensions/general/mcp-server/server.ts) when an agent
 *     relays a human approval
 *
 * Both paths converge here so the same audit trail, event emission, error
 * handling, and status transition logic apply.
 *
 * The executor functions previously lived in the commit route. They are kept
 * private to this module: call `commitPendingOperation()` to invoke them.
 */
import { bankBookingContext } from '@/lib/bookkeeping/bank-booking-context'
import type { SupabaseClient } from '@supabase/supabase-js'
import { commitArkivProposeFact } from '@/lib/arkiv/facts/propose'
import { parseEntityType, resolveCompanyEntityType } from '@/lib/company/entity-type'
import { eventBus } from '@/lib/events'
import { bulkBookMatchedInboxItems, categorizeMatchedTransaction } from '@/lib/transactions/categorize-core'
import { fetchExchangeRate, isExchangeRateTemporarilyUnavailable } from '@/lib/currency/riksbanken'
import {
  resolveSupplierInvoiceExchangeRate,
  supplierInvoiceSekAmounts,
} from '@/lib/currency/supplier-invoice-rate'
import { roundOre } from '@/lib/money'
import {
  exceedsSupplierInvoiceTotalsTolerance,
  supplierInvoiceLinesInclVat,
  supplierInvoiceTotalsGap,
} from '@/lib/supplier-invoices/line-totals'
import { matchPairs, setItemIgnored, unmatchLink } from '@/lib/reconciliation/actions'
import { signOffAccount } from '@/lib/reconciliation/signoff'
import { bookResidualAndLink, ReconciliationResidualError } from '@/lib/reconciliation/residual'
import { SKATTEKONTO_ACCOUNT_KEY } from '@/lib/reconciliation/schemas'
import { SkattekontoLinkError } from '@/lib/skatteverket/skattekonto-link'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { createCustomer, PERSONAL_NUMBER_CIPHERTEXT_RE, updateCustomer } from '@/lib/customers/customer-commands'
import { toCustomerRecord } from '@/lib/customers/customer-record'
import {
  normalizeVatRateToDecimal,
  treatmentDeductsInputVat,
} from '@/lib/vat/supplier-invoice-line-checks'
import { createInvoiceCashEntry } from '@/lib/bookkeeping/invoice-entries'
import {
  archiveIssuedInvoicePdf,
  issueAndBookInvoice,
  markInvoiceSentAndBook,
  restoreUnbookedDraft,
  type IssuableInvoice,
} from '@/lib/invoices/issue-and-book-invoice'
import { resolveSettlementAccount } from '@/lib/bookkeeping/settlement-account'
import { buildInvoiceMatchClearingLines } from '@/lib/bookkeeping/invoice-payment-lines'
import { booksInvoicesOnIssue, cashPartialBlockReason } from '@/lib/bookkeeping/booking-mode'
import { ensureManualCashAccount, resolveDefaultCashAccount } from '@/lib/cash-accounts/service'
import { ingestTransactions } from '@/lib/transactions/ingest'
import { createJournalEntry, findFiscalPeriod, getSwedishLocalDate, reverseEntry, validateBalance } from '@/lib/bookkeeping/engine'
import { approveSupplierInvoice } from '@/lib/supplier-invoices/attest-service'
import { CreditSupplierInvoiceInputSchema, creditSupplierInvoice } from '@/lib/supplier-invoices/credit'
import { resolveInboxKind } from '@/lib/documents/inbox-kind'
import { claimInboxItemOrReverseEntry, readInboxItemBookingState } from '@/lib/documents/inbox-item-claim'
import { coerceDimensionsBag } from '@/lib/bookkeeping/dimension-resolver'
import { ACCOUNT_NUMBER_RE } from '@/lib/invariants/account-number'
import { isSlpPensionAccount } from '@/lib/bookkeeping/slp-lines'
import { foldSellerVatIntoCost, sellerVatIsCost } from '@/lib/bookkeeping/vat-registration'
import { isReverseChargeKind } from '@/lib/bookkeeping/vat-entries'
import { runWithActor } from '@/lib/bookkeeping/actor-context-node'
import { getActor, type CommitActor } from '@/lib/bookkeeping/actor-context'
import { createServiceClient } from '@/lib/supabase/server'
import { revokeServiceAccount } from '@/lib/service-accounts/service'
import { runInOperationCommit } from './commit-scope'
import { recordOperationDecision } from '@/lib/suggestion-log/operation'
import { correctEntry } from '@/lib/core/bookkeeping/storno-service'
import {
  existingOpeningBalanceMessage,
  findExistingOpeningBalance,
  OPENING_BALANCE_EXISTS_CODE,
  type ExistingOpeningBalance,
} from '@/lib/import/opening-balance/existing'
import { linkOpeningBalance, OpeningBalanceExistsError } from '@/lib/import/opening-balance/existing'
import { saveVoucherGapExplanation, voucherGapExplanationFromParams } from '@/lib/core/bookkeeping/voucher-gaps'
import { SIEImportFlagsSchema } from '@/lib/api/schemas'
import { closePeriod, lockPeriod, resolvePeriodStatusForDate } from '@/lib/core/bookkeeping/period-service'
import {
  executeYearEndClosing,
  generateOpeningBalances,
} from '@/lib/core/bookkeeping/year-end-service'
import {
  assessKontantmetodCutoff,
  cutoffPreviewFingerprint,
  hasIncompleteKontantmetodCutoffPair,
  KontantmetodCutoffPartialError,
  postKontantmetodCutoff,
} from '@/lib/core/bookkeeping/kontantmetod-cutoff'
import {
  isKontantmetodCutoffSuspended,
  KONTANTMETOD_CUTOFF_SUSPENDED_CODE,
  kontantmetodCutoffSuspendedMessageSv,
} from '@/lib/core/bookkeeping/kontantmetod-cutoff-suspension'
import { executeCurrencyRevaluation } from '@/lib/bookkeeping/currency-revaluation'
import {
  AssetCorrectionBlockedError,
  createAsset as createFixedAsset,
  disposeAsset as disposeFixedAsset,
  getAsset as getFixedAsset,
  hasPostedDepreciation,
  updateAsset as updateFixedAsset,
} from '@/lib/bokslut/assets/asset-service'
import {
  CreateAssetSchema,
  DisposeAssetSchema,
  UpdateAssetSchema,
  assetView,
  checkCreateAssetGates,
  checkUpdateAssetGates,
} from '@/lib/bokslut/assets/asset-api'
import { createSupplierInvoiceRegistrationEntry } from '@/lib/bookkeeping/supplier-invoice-entries'
import { linkInvoiceToVoucher, type LinkInvoiceToVoucherResult } from '@/lib/invoices/voucher-matching'
import { RegisterBookedInvoiceParamsSchema, registerBookedInvoice } from '@/lib/invoices/register-booked-invoice'
import { isRegisterBookedInvoiceParams } from '@/lib/invoices/register-booked-invoice-mode'
import {
  RegisterBookedSupplierInvoiceParamsSchema,
  registerBookedSupplierInvoice,
} from '@/lib/supplier-invoices/register-booked'
import { planTransactionInvoiceMatch } from '@/lib/invoices/match-payment-plan'
import { findDuplicatePaymentCandidatesForInvoice } from '@/lib/invoices/duplicate-payment-candidates'
import {
  guardDuplicatePaymentVoucher,
  recordDuplicateCandidateOverride,
} from '@/lib/invoices/already-explained-guard'
import {
  linkSupplierInvoiceToVoucher,
  type LinkSupplierInvoiceToVoucherResult,
} from '@/lib/invoices/supplier-voucher-matching'
import { clearSettledInvoiceSuggestions } from '@/lib/invoices/clear-settled-invoice-suggestions'
import { emitInvoicePaidIfSettled } from '@/lib/invoices/paid-events'
import { settleInvoicePayment } from '@/lib/invoices/settle-invoice-payment'
import { creditInvoice } from '@/lib/invoices/credit-invoice'
import { recordInvoicePaymentRow } from '@/lib/invoices/invoice-payment-row'
import { paidAtFromDate } from '@/lib/invoices/paid-at'
import { matchTransactionToRotRutPayout } from '@/lib/invoices/rot-rut-match-transaction'
import { linkRotRutPayoutVoucher } from '@/lib/invoices/rot-rut-link-voucher'
import {
  DocumentAlreadyLinkedError,
  documentHeldElsewhereReasonSv,
  isDocumentImmutabilityRefusal,
} from '@/lib/documents/link-holder'
import { linkDocumentCopyToVoucher, linkDocumentToVoucher, type LinkDocumentRefusal } from '@/lib/documents/link-document'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { classifyError, isPeriodLockRefusal } from '@/lib/errors/get-structured-error'
import { requiresWebApproval } from '@/lib/pending-operations/risk-tiers'
import { invoiceLacksCustomer } from '@/lib/invoices/invoice-customer'
import { createDimensionValue } from '@/lib/dimensions/registry-service'
import { submitSIEJob } from '@/lib/import/sie-jobs'
import type { AccountMapping } from '@/lib/import/types'
import { AccountsNotInChartError, isBookkeepingError, ACCOUNTS_NOT_IN_CHART } from '@/lib/bookkeeping/errors'
import { extensionRegistry } from '@/lib/extensions/registry'
import { applyPaymentLinkToInvoice } from '@/lib/extensions/payment-links'
import {
  SkatteverketRecoverableError,
  maskPersonnummerDeep,
  type SkatteverketCommitServices,
  type SkattekontoBookingCommitService,
  type SkvSubmitResult,
} from '@/lib/pending-operations/skatteverket-commit'
import { maskPersonnummerInText } from '@/lib/salary/personnummer-format'
import { PartialCommitError } from '@/lib/pending-operations/errors'
import { getEmailService } from '@/lib/email/service'
import { resolveInvoiceSender } from '@/lib/email/invoice-sender'
import { hasCapability, capabilityBlockedError } from '@/lib/entitlements/has-capability'
import { PAID_OPERATION_CAPABILITY_MAP } from '@/lib/entitlements/keys'
import { exceedsUnattendedLimit } from './unattended-limit'
import {
  generateInvoiceEmailHtml,
  generateInvoiceEmailText,
  generateInvoiceEmailSubject,
} from '@/lib/email/invoice-templates'
import { linkToJournalEntry } from '@/lib/core/documents/document-service'
import { renderInvoicePdfBuffer } from '@/lib/invoices/render-invoice-pdf'
import { resolveInvoicePayeeChoice, resolveInvoiceSettlementAccount, snapshotInvoicePayee } from '@/lib/invoices/invoice-payee'
import {
  describeMissingInvoicePaymentAccount,
  hasRequiredInvoicePaymentAccount,
  invoiceRequiresPaymentAccount,
} from '@/lib/invoices/payment-accounts'
import { hasRequiredSellerVatNumber } from '@/lib/invoices/seller-vat-number'
import {
  exceedsInvoiceEmailRecipientLimit,
  invoiceEmailRecipientCount,
  resolveInvoiceEmailRecipients,
  resolveInvoiceReplyTo,
} from '@/lib/invoices/email-recipients'
import { ensureInvoiceNumber, InvoiceNumberSeriesBehindError } from '@/lib/invoices/ensure-invoice-number'
import { convertToInvoice } from '@/lib/invoices/convert-to-invoice'
import { invoicePdfFilename } from '@/lib/invoices/pdf-filename'
import {
  reserveInvoiceDelivery,
  sendTrackedInvoiceEmail,
} from '@/lib/invoices/invoice-deliveries'
import { createLogger } from '@/lib/logger'
import { appendProcessingHistory } from '@/lib/processing-history/append'
import { createSupplier } from '@/lib/suppliers/create-supplier'
import { createArticle, updateArticle } from '@/lib/articles/article-commands'
import { UUID_RE } from '@/lib/invariants/uuid'
import { CreateDimensionValueParamsSchema } from '@/lib/pending-operations/schemas/dimension-value'
import { RetagLineDimensionsParamsSchema } from '@/lib/pending-operations/schemas/retag-line-dimensions'
import { everyRetagRefused, retagLines } from '@/lib/dimensions/retag-service'
import { IgnoreTransactionParamsSchema } from '@/lib/pending-operations/schemas/ignore-transaction'
import { setTransactionIgnored } from '@/lib/transactions/ignore'
import { loadEntryLines, recordInboxDecision, snapshotInboxExtraction } from '@/lib/suggestion-log/inbox'
import { passed as checkPassed, warned as checkWarned } from '@/lib/suggestion-log/checks'
import { resultAccounts } from '@/lib/suggestion-log/inbox-classify'
import {
  CreateInvoiceFromSalesOrderParamsSchema,
  CreateSalesOrderParamsSchema,
  RegisterSalesOrderDeliveryParamsSchema,
  TransitionSalesOrderParamsSchema,
} from '@/lib/pending-operations/schemas/sales-order'
import { createSalesOrder } from '@/lib/sales-orders/write'
import { transitionSalesOrder } from '@/lib/sales-orders/transitions'
import { registerSalesOrderDelivery } from '@/lib/sales-orders/register-delivery'
import { createInvoiceFromSalesOrder } from '@/lib/sales-orders/create-invoice-from-order'
import { convertToSalesOrder } from '@/lib/sales-orders/convert-to-sales-order'
import type { ServiceFailure } from '@/lib/sales-orders/result'
import {
  CreateRecurringScheduleParamsSchema,
  UpdateRecurringScheduleParamsSchema,
} from '@/lib/pending-operations/schemas/recurring-schedule'
import {
  computeInitialRunDate,
  computeNextRunDate,
  rollNextRunDateForward,
  getStockholmDateHour,
} from '@/lib/invoices/recurring-schedule-service'
import { runDateMatchesDayOfMonth } from '@/lib/invoices/recurring-run-date'
import { UpdateInvoiceParamsSchema } from '@/lib/pending-operations/schemas/update-invoice'
import { buildStagedInvoice } from '@/lib/pending-operations/build-staged-invoice'
import {
  buildInvoiceWriteData,
  type InvoiceWriteInput,
  type InvoiceWriteItemInput,
} from '@/lib/invoices/build-invoice-write'
import { deleteDraftInvoice } from '@/lib/invoices/delete-draft-invoice'
import { isEditableInvoiceDraft } from '@/lib/invoices/is-editable-draft'
import { replaceInvoiceItems } from '@/lib/invoices/replace-invoice-items'
import { applyRecurringScheduleUpdate } from '@/lib/invoices/apply-recurring-schedule-update'
import { toRecurringScheduleItemRow } from '@/lib/invoices/recurring-schedule-items'
import { periodPlaceholderProblem } from '@/lib/invoices/recurring-placeholders'
import {
  BulkBookInboxSchema,
  ConvertQuotePartSchema,
  CreateArticleSchema,
  CreateCustomerSchema,
  CreateSupplierSchema,
  OpeningBalancesBulkSchema,
  UpdateArticleSchema,
  UpdateCustomerSchema,
} from '@/lib/api/schemas'
import { z } from 'zod'
import { operationForPendingType } from '@/lib/operations/registry'
import { rejectSupersededInboxConversions } from './supersede'
import { backfillSupplierPaymentDetails, inboxStatedPaymentDetails } from '@/lib/supplier-invoices/payment-details-backfill'
import { assessRegisteredPayee, payeeAlertWarning } from '@/lib/payments/payee-registration'
import { COLLECTIONS_BATCH_TYPE } from '@/lib/collections/batch'
import { batchApprovalRefusal, commitCollectionsDailyBatch } from '@/lib/collections/batch-commit'
import type { AnyOperation, OperationOutcome } from '@/lib/operations/types'
import type {
  Transaction,
  TransactionCategory,
  EntityType,
  VatTreatment,
  Currency,
  Invoice,
  Customer,
  SupplierInvoice,
  SupplierInvoiceItem,
  PendingOperation,
  CompanySettings,
  InvoiceItem,
  InvoiceDocumentType,
  AccountingMethod,
  CreateJournalEntryLineInput,
  JournalEntrySourceType,
  FiscalPeriod,
} from '@/types'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { MATCHABLE_INVOICE_STATUSES, isMatchableInvoiceStatus } from '@/lib/invoices/matchable-statuses'

const log = createLogger('pending-operations/commit')

export interface CommitResult {
  status: 'committed' | 'rejected' | 'failed'
  data?: Record<string, unknown>
  error?: string
  http_status?: number
  auto_rejected?: boolean
  // Structured-error registry code for the failure, when one is known, so a
  // caller can branch on the failure mode instead of parsing `error` text.
  // ACCOUNTS_NOT_IN_CHART is the recoverable case: the booking posts to BAS
  // accounts not active in the company chart, the op is left 'pending', and
  // the route rebuilds the structured envelope (code + account_numbers).
  // Other codes (e.g. INVOICE_RECURRING_UPDATE_PARTIAL) are informational:
  // callers that do not recognize the code fall back to `error`.
  code?: string
  account_numbers?: string[]
  // The two numbers UNATTENDED_COMMIT_LIMIT_EXCEEDED's remediation refers to,
  // in SEK. Present only on that code. Without them the agent knows it was
  // over the ceiling but not by how much, and cannot tell a human what to
  // raise the limit to.
  unattended_limit?: { attempted: number; limit: number }
  // Where the pending_operations row landed, independent of `status`:
  // 'pending' means the op was NOT consumed and can be approved again
  // (recoverable refusal: capability, chart accounts, Skatteverket, or an
  // authorization failure that happened before any side-effect). Agents
  // used to infer "consumed" from status 'failed' and were wrong both ways.
  operation_status?: 'pending' | 'committed' | 'rejected' | 'failed_partial'
}

export interface CommitOptions {
  /** Email address used as cc on send_invoice (typically the human user's email). */
  userEmail?: string
  /**
   * commit_method recorded on any journal_entries created by this operation.
   * Must match the CHECK constraint on journal_entries.commit_method
   * (migration 20260618120001): 'user_accept' | 'bulk_accept' |
   * 'timing_ceiling' | 'migration' | 'legacy' | 'agent' | 'api_key'.
   *
   * Web-UI single-approval passes 'user_accept'; bulk-approval passes
   * 'bulk_accept'. MCP approvals pass the relaying credential: 'api_key'
   * (gnubok-mcp bridge) or 'agent' (OAuth connector), so the immutable layer
   * records that the acknowledgment was agent-relayed rather than a
   * first-party human session. Every path is
   * still human-approval-gated; agent auto-commit was removed in
   * 20260505190027_drop_agent_auto_commit.
   */
  commitMethod?: 'user_accept' | 'bulk_accept' | 'agent' | 'api_key'
  /**
   * WHO is relaying this approval (api_key with the key's display name, plain
   * user, agent_chat, …). Propagated to every journal-entry commit made by the
   * operation via the runWithActor() AsyncLocalStorage scope (unlike
   * commitMethod, which only the create_voucher executor threads explicitly)
   * and stamped onto journal_entries.committed_actor_* plus the audit_log
   * COMMIT row by the commit_journal_entry RPC (migration 20260619120000).
   * Omitted → NULL attribution, identical to pre-attribution behaviour.
   */
  actor?: CommitActor
}

// ensureFiscalPeriod moved to lib/transactions/categorize-core.ts (imported
// above) so the bulk-book-inbox path and the single-categorize path share one
// implementation.

// ── Executors ────────────────────────────────────────────────────

/**
 * The company's booking context for invoice-shaped executors: accounting
 * method and entity type with the engine defaults when the settings row is
 * missing or the read fails (errors are deliberately ignored, as before).
 */
async function loadBookingContext(
  supabase: SupabaseClient,
  companyId: string
): Promise<{ accountingMethod: AccountingMethod; entityType: EntityType }> {
  const { data: settings } = await supabase
    .from('company_settings').select('accounting_method, entity_type').eq('company_id', companyId).single()

  return {
    accountingMethod: (settings?.accounting_method as AccountingMethod) || 'accrual',
    entityType: await resolveCompanyEntityType(supabase, companyId, settings?.entity_type),
  }
}

/**
 * Catch-body shared by the ledger-writing executors: a BookkeepingError is
 * rethrown so the dispatcher maps it to a structured code; anything else
 * becomes a plain failure with the executor's fallback text and status.
 */
function failUnlessBookkeepingError(err: unknown, fallback: string, status: number): ExecutorResult {
  if (isBookkeepingError(err)) throw err
  return { error: err instanceof Error ? err.message : fallback, status }
}

type ExecutorResult = {
  data?: Record<string, unknown>
  error?: string
  // Structured-error registry code for `error`, when the executor has one.
  // Surfaced as CommitResult.code and persisted in result_data.error_code so a
  // caller can branch on the failure mode instead of parsing the message text.
  errorCode?: string
  status?: number
  // Set when the executor already performed an irreversible side-effect
  // (posted voucher, persisted credit note) before the failure in `error`:
  // the dispatcher then lands the op in 'failed_partial' instead of
  // 'rejected' and persists these ids in result_data.posted_ids (issue #842).
  partialPostedIds?: Record<string, string>
  // Set when the refusal came before any side-effect and only says another
  // call holds the resource right now (SALARY_RUN_BOOKING_IN_PROGRESS): the
  // dispatcher hands the op back to 'pending', exactly as for a 401/403, so
  // the approval can be given again once the other call is done instead of
  // the op being consumed as 'rejected'.
  returnToPending?: boolean
}

/**
 * Refusal for a staged foreign-currency operation whose rate lookup hit a
 * temporary Riksbanken refusal (rate limit, outage). Nothing is wrong with the
 * operation and nothing has been written, so it goes back to 'pending' and the
 * same approval works a minute later. As 'rejected' it was consumed, and the
 * user had to stage the row again for a failure that was not about the row.
 * Only for a refusal made before any write.
 */
function exchangeRateRetryLater(): ExecutorResult {
  const entry = getErrorEntry('FX_RATE_TEMPORARILY_UNAVAILABLE')
  return {
    error:
      entry?.message_sv ??
      'Riksbanken svarar inte just nu, så växelkursen kunde inte hämtas. Inget har bokförts och åtgärden ligger kvar: godkänn den igen om en stund.',
    errorCode: 'FX_RATE_TEMPORARILY_UNAVAILABLE',
    status: entry?.httpStatus ?? 503,
    returnToPending: true,
  }
}

/** A draft without a customer (crm#263): refused before anything changes. */
function customerMissingResult(): ExecutorResult {
  const entry = getErrorEntry('INVOICE_CUSTOMER_MISSING')
  return {
    error: entry?.message_sv ?? 'Fakturan saknar kund.',
    errorCode: 'INVOICE_CUSTOMER_MISSING',
    status: entry?.httpStatus ?? 409,
  }
}

/**
 * Executor for an operation from the registry: re-validates the staged input
 * at the commit boundary (a tampered pending_operations row must not reach
 * the books with fields the staging tool never accepted) and runs it for
 * real. A BookkeepingError is rethrown so the dispatcher's catch handles it
 * exactly as for a hand-written executor.
 */
async function commitRegisteredOperation(
  operation: AnyOperation,
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>,
): Promise<ExecutorResult> {
  const upgrade = operation.mcp?.stage?.upgradeParams
  const parsed = (operation.input as unknown as z.ZodTypeAny).safeParse(upgrade ? upgrade(params) : params)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return {
      error: `Invalid ${issue?.path?.join('.') || 'params'}: ${issue?.message ?? 'validation failed'}`,
      errorCode: 'VALIDATION_ERROR',
      status: 400,
    }
  }
  const outcome = await operation.run(
    { supabase, companyId, userId, log: log.child({ operation: operation.id }) },
    parsed.data,
    { dryRun: false },
  )
  if (!outcome.ok) {
    if (outcome.error) throw outcome.error
    const entry = getErrorEntry(outcome.code)
    const partial = outcome.partialPostedIds && Object.keys(outcome.partialPostedIds).length > 0
    return {
      // Never an empty string: an empty error reads as success downstream.
      // Swedish first, like every other executor: the approver reads it.
      error: outcome.messageSv || entry?.message_sv || entry?.message_en || outcome.code,
      errorCode: outcome.code,
      status: entry?.httpStatus ?? 400,
      // What the refusal names (the vouchers that already book a bank row),
      // kept on the rejected row's result_data as v1 answers it in details.
      ...(outcome.details ? { data: outcome.details } : {}),
      // A failure after an irreversible step: failed_partial, not rejected.
      ...(partial ? { partialPostedIds: outcome.partialPostedIds } : {}),
    }
  }
  if (outcome.dryRun) return { data: outcome.preview }
  return { data: outcome.data as Record<string, unknown> }
}

/**
 * settle_rot_rut_payout (gnubok_settle_rot_rut_payout): book Skatteverkets
 * ROT/RUT utbetalning from the bank row against its begäran (one or several,
 * #2239) through the same writer as the dashboard match route. The stage
 * already checked income/SEK/unlinked/sum; the writer re-checks everything
 * under its own CAS guards, so a race between approval and a manual match
 * ends in a coded refusal, never a second 1513 credit.
 */
async function commitSettleRotRutPayout(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const transactionId = params.transaction_id as string | undefined
  const requestIds = Array.isArray(params.request_ids)
    ? (params.request_ids as unknown[]).filter((id): id is string => typeof id === 'string')
    : []
  if (!transactionId || requestIds.length === 0) {
    return { error: 'transaction_id and request_ids are required', status: 400 }
  }

  const outcome = await matchTransactionToRotRutPayout(
    supabase,
    userId,
    companyId,
    { transactionId, requestIds },
    log,
  )

  if (!outcome.ok) {
    if (outcome.kind === 'code') {
      const entry = getErrorEntry(outcome.code)
      // A race or a failed row link happens AFTER the voucher posted: the op
      // lands in failed_partial with the voucher id so nobody books it twice.
      const postedId =
        outcome.details && typeof outcome.details.journal_entry_id === 'string'
          ? (outcome.details.journal_entry_id as string)
          : null
      return {
        error: entry?.message_en ?? outcome.code,
        errorCode: outcome.code,
        status: entry?.httpStatus ?? 500,
        data: outcome.details as Record<string, unknown> | undefined,
        ...(postedId ? { partialPostedIds: { journal_entry_id: postedId } } : {}),
      }
    }
    const message = outcome.error instanceof Error ? outcome.error.message : 'rot/rut payout settle failed'
    // stage 'update' = the voucher posted and the request row did not absorb
    // it: failed_partial with the voucher id, never a plain retryable 500
    // (a retry would hit journal_entries_rot_rut_payout_live_unique).
    return {
      error: `${message} (stage: ${outcome.stage})`,
      status: 500,
      ...(outcome.journalEntryId ? { partialPostedIds: { journal_entry_id: outcome.journalEntryId } } : {}),
    }
  }

  // Audit-trail entry (ids only, no amounts or counterparty PII), same shape
  // as commitMatchBatchAllocate.
  log.info('settle_rot_rut_payout committed', {
    companyId,
    operationType: 'settle_rot_rut_payout',
    transactionId,
    journalEntryId: outcome.journalEntryId,
    requestCount: outcome.requests.length,
  })

  return {
    data: {
      transaction_id: transactionId,
      journal_entry_id: outcome.journalEntryId,
      amount: outcome.amount,
      request_ids: outcome.requests.map((request) => request.id),
      request_statuses: outcome.requests.map((request) => request.status),
    },
  }
}

/**
 * link_rot_rut_payout_voucher (gnubok_link_rot_rut_payout_voucher): attach a
 * payout verifikat that already exists to its begäran. Books nothing; the
 * RPC re-runs every check the stage previewed, under its own locks.
 */
async function commitLinkRotRutPayoutVoucher(
  supabase: SupabaseClient,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const journalEntryId = params.journal_entry_id as string | undefined
  const requestIds = Array.isArray(params.request_ids)
    ? (params.request_ids as unknown[]).filter((id): id is string => typeof id === 'string')
    : []
  if (!journalEntryId || requestIds.length === 0) {
    return { error: 'journal_entry_id and request_ids are required', status: 400 }
  }

  const outcome = await linkRotRutPayoutVoucher(supabase, companyId, { requestIds, journalEntryId })
  if (!outcome.ok) {
    if (outcome.kind === 'code') {
      const entry = getErrorEntry(outcome.code)
      return {
        error: entry?.message_en ?? outcome.code,
        errorCode: outcome.code,
        status: entry?.httpStatus ?? 500,
        data: outcome.details,
      }
    }
    const message = outcome.error instanceof Error ? outcome.error.message : 'rot/rut payout voucher link failed'
    return { error: message, status: 500 }
  }

  log.info('link_rot_rut_payout_voucher committed', {
    companyId,
    operationType: 'link_rot_rut_payout_voucher',
    journalEntryId,
    requestCount: requestIds.length,
  })

  return {
    data: {
      journal_entry_id: journalEntryId,
      request_ids: requestIds,
      already_linked: outcome.result.already_linked,
      rounding: outcome.result.rounding ?? 0,
    },
  }
}

async function commitCategorizeTransaction(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const txId = params.transaction_id as string
  const category = params.category as TransactionCategory
  const vatTreatment = params.vat_treatment as VatTreatment | undefined
  // Optional audit-trail text the agent passed alongside the categorization.
  // For representation bookings the agent captures deltagare + syfte and
  // funnels them in here so the verifikation's description carries the
  // context an external auditor needs (SKV's representationsregler).
  const notes =
    typeof params.notes === 'string' && params.notes.trim().length > 0
      ? (params.notes as string)
      : undefined
  // The underlag's actual VAT, staged when the document's moms differs from
  // rate × belopp (e.g. dricks). Threaded into the mapping builder so the
  // approved posting matches the staged preview exactly.
  const vatAmount =
    typeof params.vat_amount === 'number' && Number.isFinite(params.vat_amount)
      ? params.vat_amount
      : undefined

  // Booking, the duplicate guard, VAT mapping, and matched-inbox underlag
  // propagation all live in the shared core (lib/transactions/categorize-core.ts)
  // so the bulk-book-inbox executor and the Underlag "Bokför valda" route reuse
  // exactly this logic.
  // Tamper/drift gate for the explicit business-side account: a PRESENT but
  // malformed account_override must fail loudly, never degrade to the
  // category default. The approver approved a preview showing the override
  // account, so posting anything else would diverge from what was approved.
  const rawAccountOverride = params.account_override
  if (
    rawAccountOverride != null &&
    !(typeof rawAccountOverride === 'string' && ACCOUNT_NUMBER_RE.test(rawAccountOverride))
  ) {
    return {
      error:
        'Ogiltigt account_override i den stagade operationen (förväntade 4 siffror). ' +
        'Avvisa operationen och stagea om kategoriseringen.',
      status: 400,
    }
  }

  // Same tamper/drift gate for the reverse-charge basis box: the approver saw
  // the ruta the staged kind puts the basis in, so a present but unknown kind
  // must not silently fall back to the EU-services default.
  const rawReverseChargeKind = params.reverse_charge_kind
  if (rawReverseChargeKind != null && !isReverseChargeKind(rawReverseChargeKind)) {
    return {
      error:
        'Ogiltig reverse_charge_kind i den stagade operationen. ' +
        'Avvisa operationen och stagea om kategoriseringen.',
      status: 400,
    }
  }

  return categorizeMatchedTransaction(supabase, userId, companyId, txId, {
    category,
    vatTreatment,
    reverseChargeKind: rawReverseChargeKind ?? undefined,
    vatAmount,
    notes,
    allowDuplicate: params.allow_duplicate === true,
    // Dimensions PR7: resolved at staging; coerce is the drift/tamper gate.
    dimensions: coerceDimensionsBag(params.dimensions),
    // Validated against the chart both at staging and inside the core at commit.
    accountOverride: (rawAccountOverride as string | null | undefined) ?? undefined,
    // The suggestion the agent booked from, for suggestion_log only.
    proposalId: typeof params.proposal_id === 'string' && params.proposal_id.length > 0 ? params.proposal_id : undefined,
  })
}

/**
 * A staged create_customer's params in the shape CreateCustomerSchema reads.
 * Operations staged before the tool shared the dashboard's schema carry
 * `address` and `payment_terms`, and null for every unset field; the schema
 * reads absent fields as unset. The personnummer travels only as ciphertext.
 */
function upgradeStagedCustomerCreate(params: Record<string, unknown>): {
  input: Record<string, unknown>
  personalNumberCiphertext: unknown
} {
  const { personal_number_encrypted: personalNumberCiphertext, address, payment_terms: paymentTerms, ...rest } = params
  const input: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(rest)) {
    if (value !== null) input[key] = value
  }
  if (input.address_line1 === undefined && typeof address === 'string' && address) input.address_line1 = address
  if (input.default_payment_terms === undefined && typeof paymentTerms === 'number') {
    input.default_payment_terms = paymentTerms
  }
  return { input, personalNumberCiphertext }
}

/** A staged ciphertext: absent, null (a clear) or the stored shape, nothing else. */
function stagedCiphertext(value: unknown): { ok: true; value: string | null | undefined } | { ok: false; result: ExecutorResult } {
  if (value === undefined || value === null) return { ok: true, value: value as null | undefined }
  if (typeof value === 'string' && PERSONAL_NUMBER_CIPHERTEXT_RE.test(value)) return { ok: true, value }
  return { ok: false, result: { error: 'Invalid personal_number_encrypted: Invalid encrypted personal number', status: 400 } }
}

async function commitCreateCustomer(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  // Re-validated at the commit boundary with the dashboard's rule set, so a
  // tampered pending_operations row is refused with the same rules (ASVS V4.5).
  const { input, personalNumberCiphertext } = upgradeStagedCustomerCreate(params)
  const ciphertext = stagedCiphertext(personalNumberCiphertext)
  if (!ciphertext.ok) return ciphertext.result
  const parsed = parseRegisterParams(CreateCustomerSchema, input)
  if (!parsed.ok) return parsed.result

  // The insert the dashboard makes (lib/customers/customer-commands.ts).
  const outcome = await createCustomer({ supabase, companyId, userId, log }, parsed.data, {
    personalNumberCiphertext: ciphertext.value,
  })
  if (!outcome.ok) return registerCommandFailure(outcome)
  if (outcome.dryRun) throw new Error('create_customer: unexpected dry-run outcome')
  return { data: { customer_id: outcome.data.id } }
}

async function commitUpdateCustomer(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>,
): Promise<ExecutorResult> {
  const { customer_id: customerId, changes } = params
  if (typeof customerId !== 'string' || !UUID_RE.test(customerId)) {
    return { error: 'Invalid customer_id: expected a UUID', status: 400 }
  }
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
    return { error: 'Invalid changes: expected an object', status: 400 }
  }
  const { personal_number_encrypted: personalNumberCiphertext, ...fields } = changes as Record<string, unknown>
  const ciphertext = stagedCiphertext(personalNumberCiphertext)
  if (!ciphertext.ok) return ciphertext.result
  // The staged changes never hold a plaintext personnummer (staging-pii-guard).
  if ('personal_number' in fields) return { error: 'Invalid changes.personal_number: not accepted here', status: 400 }
  // Strict: a staged change carries only the register's own fields (ASVS V4.5).
  const parsed = parseRegisterParams(UpdateCustomerSchema.strict(), fields)
  if (!parsed.ok) return parsed.result

  // The update the dashboard makes (lib/customers/customer-commands.ts).
  const outcome = await updateCustomer({ supabase, companyId, userId, log }, customerId, parsed.data, {
    personalNumberCiphertext: ciphertext.value,
  })
  if (!outcome.ok) return registerCommandFailure(outcome)
  if (outcome.dryRun) throw new Error('update_customer: unexpected dry-run outcome')
  // The record gnubok_get_customer reads (lib/customers/customer-record.ts),
  // so every field an update can change comes back: a hand-kept list here
  // left out contact_person and the invoice copy lists (crm#1198).
  // Never the stored ciphertext, and never plaintext: result_data is
  // persisted on the pending operation and rendered in approval UIs. The
  // command's row is already masked.
  const { id, personal_number: personalNumberMasked, ...record } = toCustomerRecord(
    outcome.data as unknown as Record<string, unknown>,
  )
  return { data: { customer_id: id, ...record, personal_number_masked: personalNumberMasked } }
}

async function commitCreateRecurringSchedule(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>,
): Promise<ExecutorResult> {
  // Re-validate at the commit boundary with the shared schema so a tampered
  // pending_operations row is rejected with the same rules the staging tool
  // and the cookie-session POST route enforce.
  let validated
  try {
    validated = CreateRecurringScheduleParamsSchema.parse(params)
  } catch (err) {
    if (err instanceof z.ZodError) {
      const issue = err.issues[0]
      return {
        error: `Invalid ${issue?.path?.join('.') ?? 'params'}: ${issue?.message ?? 'validation failed'}`,
        status: 400,
      }
    }
    throw err
  }

  const { data: customer, error: customerError } = await supabase
    .from('customers')
    .select('id, email')
    .eq('id', validated.customer_id)
    .eq('company_id', companyId)
    .maybeSingle()

  if (customerError) return { error: customerError.message, status: 500 }
  if (!customer) return { error: 'Customer not found', status: 404 }

  // auto_send without a customer email would silently degrade to a monthly
  // draft + warning at cron time. Reject at commit exactly like the route.
  if (validated.auto_send && !customer.email) {
    return {
      error: 'Customer has no email address: automatic sending requires one',
      status: 400,
    }
  }

  // Same grid rule as the create route. A start_date that turned stale
  // between staging and approval is NOT rejected: the cron rolls a missed
  // date forward on the grid, so the phase the user chose still holds.
  if (
    validated.start_date !== undefined &&
    !runDateMatchesDayOfMonth(validated.start_date, validated.day_of_month)
  ) {
    return {
      error: 'start_date must fall on day_of_month (clamped to the last day in shorter months)',
      status: 400,
    }
  }

  const nextRunDate = computeInitialRunDate(
    new Date(),
    validated.day_of_month,
    validated.start_date,
  )

  const { data: schedule, error: insertError } = await supabase
    .from('recurring_invoice_schedules')
    .insert({
      company_id: companyId,
      user_id: userId,
      customer_id: validated.customer_id,
      name: validated.name,
      day_of_month: validated.day_of_month,
      interval_months: validated.interval_months,
      send_hour: validated.send_hour,
      payment_terms_days: validated.payment_terms_days,
      currency: validated.currency,
      your_reference: validated.your_reference ?? null,
      our_reference: validated.our_reference ?? null,
      notes: validated.notes ?? null,
      period_start: validated.period_start ?? null,
      auto_send: validated.auto_send,
      default_dimensions: validated.default_dimensions ?? {},
      next_run_date: nextRunDate,
      status: 'active',
    })
    .select()
    .single()

  if (insertError || !schedule) {
    return { error: insertError?.message ?? 'Failed to insert recurring schedule', status: 500 }
  }

  const itemRows = validated.items.map((item, idx) => toRecurringScheduleItemRow(schedule.id, item, idx))

  const { error: itemsError } = await supabase
    .from('recurring_invoice_schedule_items')
    .insert(itemRows)

  if (itemsError) {
    // Roll back the parent so a half-created schedule doesn't ship: an
    // item-less schedule makes every cron run throw "schedule has no items"
    // and silently skip billing dates.
    await supabase
      .from('recurring_invoice_schedules')
      .delete()
      .eq('id', schedule.id)
      .eq('company_id', companyId)
    return { error: itemsError.message, status: 500 }
  }

  return {
    data: {
      recurring_schedule_id: schedule.id,
      name: validated.name,
      customer_id: validated.customer_id,
      day_of_month: validated.day_of_month,
      interval_months: validated.interval_months,
      send_hour: validated.send_hour,
      currency: validated.currency,
      auto_send: validated.auto_send,
      status: 'active',
      next_run_date: nextRunDate,
      item_count: itemRows.length,
    },
  }
}

async function commitUpdateRecurringSchedule(
  supabase: SupabaseClient,
  companyId: string,
  params: Record<string, unknown>,
): Promise<ExecutorResult> {
  let validated
  try {
    validated = UpdateRecurringScheduleParamsSchema.parse(params)
  } catch (err) {
    if (err instanceof z.ZodError) {
      const issue = err.issues[0]
      return {
        error: `Invalid ${issue?.path?.join('.') ?? 'params'}: ${issue?.message ?? 'validation failed'}`,
        status: 400,
      }
    }
    throw err
  }

  const { schedule_id: scheduleId, changes } = validated
  const { items, ...fieldChanges } = changes

  const { data: existing, error: existingError } = await supabase
    .from('recurring_invoice_schedules')
    .select('id, status, auto_send, customer_id, day_of_month, interval_months, next_run_date, notes, period_start, items:recurring_invoice_schedule_items(description)')
    .eq('id', scheduleId)
    .eq('company_id', companyId)
    .maybeSingle()

  if (existingError) return { error: existingError.message, status: 500 }
  if (!existing) return { error: 'Recurring schedule not found', status: 404 }

  // Same rule as PATCH /api/invoices/recurring/[id]: period placeholders in
  // the texts that will be in effect need a period_start in effect.
  const storedDescriptions = ((existing as { items?: Array<{ description: string }> | null }).items ?? [])
    .map((item) => item.description)
  const periodProblem = periodPlaceholderProblem({
    notes: fieldChanges.notes !== undefined ? fieldChanges.notes : (existing as { notes?: string | null }).notes,
    itemDescriptions: items ? items.map((item) => item.description) : storedDescriptions,
    periodStart:
      fieldChanges.period_start !== undefined
        ? fieldChanges.period_start
        : (existing as { period_start?: string | null }).period_start,
  })
  if (periodProblem) return { error: periodProblem, status: 400 }

  // Turning auto_send on (or moving the schedule to another customer) needs
  // the target customer checked: email when auto_send is effectively on
  // (mirrors the PATCH route), and company membership always (this executor
  // runs on a service-role client with no RLS, so a cross-tenant customer_id
  // would otherwise pass the FK).
  if (changes.customer_id !== undefined || changes.auto_send === true) {
    const effectiveAutoSend = changes.auto_send ?? existing.auto_send
    const { data: customer, error: customerError } = await supabase
      .from('customers')
      .select('id, email')
      .eq('id', changes.customer_id ?? existing.customer_id)
      .eq('company_id', companyId)
      .maybeSingle()

    if (customerError) return { error: customerError.message, status: 500 }
    if (!customer) return { error: 'Customer not found', status: 404 }
    if (effectiveAutoSend && !customer.email) {
      return {
        error: 'Customer has no email address: automatic sending requires one',
        status: 400,
      }
    }
  }

  const updateRow: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fieldChanges)) {
    if (v !== undefined) updateRow[k] = v
  }

  // Recompute next_run_date when the schedule is reactivated from a stale
  // date or its day-of-month changed: mirror of the PATCH route. Always the
  // next STRICTLY-future occurrence, never today, so an approval cannot
  // trigger a same-hour surprise send. Editing other fields leaves
  // next_run_date alone so an unrelated edit never skips an imminent send.
  if (
    changes.status === 'active' ||
    changes.day_of_month !== undefined ||
    changes.next_run_date !== undefined
  ) {
    const reactivating = changes.status === 'active'
    const dayChanged =
      changes.day_of_month !== undefined && changes.day_of_month !== existing.day_of_month
    const effectiveDay = changes.day_of_month ?? existing.day_of_month
    const effectiveInterval = changes.interval_months ?? existing.interval_months ?? 1
    const { date: todayStockholm } = getStockholmDateHour(new Date())
    const stockholmToday = new Date(`${todayStockholm}T00:00:00Z`)

    // An explicit next_run_date re-phases the schedule and wins over the
    // recompute. Grid mismatch is rejected like the PATCH route; a date that
    // went stale while the operation waited for approval is rolled forward
    // on its own grid (strictly future) instead of auto-rejecting, so the
    // approved phase survives a slow approval.
    if (changes.next_run_date !== undefined) {
      if (!runDateMatchesDayOfMonth(changes.next_run_date, effectiveDay)) {
        return {
          error: 'next_run_date must fall on day_of_month (clamped to the last day in shorter months)',
          status: 400,
        }
      }
      updateRow.next_run_date =
        changes.next_run_date <= todayStockholm
          ? rollNextRunDateForward(
              changes.next_run_date,
              stockholmToday,
              effectiveDay,
              effectiveInterval,
            )
          : changes.next_run_date
    }

    const staleOnReactivate = reactivating && existing.next_run_date <= todayStockholm
    if (changes.next_run_date === undefined && (staleOnReactivate || dayChanged)) {
      if (effectiveInterval === 1) {
        // Monthly keeps its long-standing today-anchored semantics.
        const rolled = computeInitialRunDate(stockholmToday, effectiveDay)
        updateRow.next_run_date =
          rolled === todayStockholm
            ? computeNextRunDate(stockholmToday, effectiveDay)
            : rolled
      } else {
        // Interval schedules roll on their own month grid so an edit or
        // reactivation cannot shift a quarterly schedule off its phase.
        updateRow.next_run_date = rollNextRunDateForward(
          existing.next_run_date,
          stockholmToday,
          effectiveDay,
          effectiveInterval,
        )
      }
    }

    // A conscious reactivation invalidates any lingering warning.
    if (reactivating) {
      updateRow.last_run_warning = null
    }
  }

  // Items provided = replace all; omitted = keep existing (the schema
  // contract). The shared helper compensates BOTH writes on failure, so an
  // item failure cannot leave the header fields half-saved.
  const result = await applyRecurringScheduleUpdate(supabase, {
    scheduleId,
    companyId,
    fields: updateRow,
    items,
    log,
  })
  if (!result.ok) {
    if (result.stage !== 'header' && (!result.itemsRestored || !result.headerRestored)) {
      // Same registry sentence the PATCH route returns, so the two surfaces
      // cannot drift on what the user is told.
      const partial = getErrorEntry('INVOICE_RECURRING_UPDATE_PARTIAL')
      log.error('recurring schedule update left a partial state', result.error, {
        scheduleId,
        companyId,
        stage: result.stage,
        itemsRestored: result.itemsRestored,
        headerRestored: result.headerRestored,
      })
      return {
        error: `${partial?.message_sv ?? 'Ändringen kunde inte slutföras.'} (${result.error.message})`,
        // Machine-readable twin of the PATCH route's envelope code, so an
        // MCP/staged-op caller can detect the partial state without
        // substring-matching the Swedish sentence.
        errorCode: 'INVOICE_RECURRING_UPDATE_PARTIAL',
        status: 500,
      }
    }
    return { error: result.error.message, status: 500 }
  }
  const itemsReplaced = Boolean(items)

  return {
    data: {
      recurring_schedule_id: scheduleId,
      status: changes.status ?? existing.status,
      updated_fields: Object.keys(updateRow),
      items_replaced: itemsReplaced,
      ...(itemsReplaced && items ? { item_count: items.length } : {}),
      ...(updateRow.next_run_date !== undefined
        ? { next_run_date: updateRow.next_run_date }
        : {}),
    },
  }
}

/**
 * A register command's refusal as the approval's failure, in the register's
 * own codes (lib/articles/article-commands.ts, lib/customers/customer-commands.ts).
 */
function registerCommandFailure(outcome: Extract<OperationOutcome<unknown>, { ok: false }>): ExecutorResult {
  // A posting account that is merely not activated is the recoverable case:
  // thrown, so the op stays pending and the approver can activate and retry.
  if (outcome.code === ACCOUNTS_NOT_IN_CHART) {
    throw new AccountsNotInChartError((outcome.details?.account_numbers as string[] | undefined) ?? [])
  }
  const entry = getErrorEntry(outcome.code)
  return {
    error: outcome.messageSv ?? entry?.message_sv ?? outcome.code,
    errorCode: outcome.code,
    status: entry?.httpStatus ?? 500,
  }
}

/** A staged register row re-parsed with the register's one rule set (ASVS V4.5). */
function parseRegisterParams<S extends z.ZodTypeAny>(
  schema: S,
  params: Record<string, unknown>,
): { ok: true; data: z.output<S> } | { ok: false; result: ExecutorResult } {
  const validated = schema.safeParse(params)
  if (validated.success) return { ok: true, data: validated.data }
  const issue = validated.error.issues[0]
  const path = issue?.path?.join('.') || 'params'
  return { ok: false, result: { error: `Invalid ${path}: ${issue?.message ?? 'validation failed'}`, status: 400 } }
}

async function commitCreateArticle(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  // Defense in depth: re-validate the staged params at the commit boundary so a
  // tampered pending_operations row cannot inject unexpected fields (ASVS V4.5),
  // with the rule set the dashboard uses.
  const parsed = parseRegisterParams(CreateArticleSchema, params)
  if (!parsed.ok) return parsed.result

  // The insert the dashboard makes (lib/articles/article-commands.ts).
  const outcome = await createArticle({ supabase, companyId, userId, log }, parsed.data)
  if (!outcome.ok) return registerCommandFailure(outcome)
  if (outcome.dryRun) throw new Error('create_article: unexpected dry-run outcome')
  return { data: { article_id: outcome.data.id, article_number: outcome.data.article_number } }
}

async function commitUpdateArticle(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const { article_id: articleId, ...changes } = params
  if (typeof articleId !== 'string' || !UUID_RE.test(articleId)) {
    return { error: 'Invalid article_id: expected a UUID', status: 400 }
  }
  const parsed = parseRegisterParams(UpdateArticleSchema, changes)
  if (!parsed.ok) return parsed.result

  // The update the dashboard makes (lib/articles/article-commands.ts).
  const outcome = await updateArticle({ supabase, companyId, userId, log }, articleId, parsed.data)
  if (!outcome.ok) return registerCommandFailure(outcome)
  if (outcome.dryRun) throw new Error('update_article: unexpected dry-run outcome')
  return { data: { article_id: outcome.data.id } }
}


async function commitIgnoreTransaction(
  supabase: SupabaseClient,
  companyId: string,
  params: Record<string, unknown>,
  userId: string,
): Promise<ExecutorResult> {
  let validated
  try {
    validated = IgnoreTransactionParamsSchema.parse(params)
  } catch (err) {
    if (err instanceof z.ZodError) {
      const issue = err.issues[0]
      return { error: `Invalid ${issue?.path?.join('.') ?? 'params'}: ${issue?.message ?? 'validation failed'}`, status: 400 }
    }
    throw err
  }

  // A skattekonto row (crm#1178): the function the Avstämning page and the
  // v1 reconciliation ignore route call, so the doors refuse the same rows.
  // Idempotent, writes no verifikat, refuses a linked row (unlink first).
  if (validated.skattekonto_transaction_id) {
    try {
      const result = await setItemIgnored(
        supabase,
        companyId,
        SKATTEKONTO_ACCOUNT_KEY,
        validated.skattekonto_transaction_id,
        validated.ignored,
      )
      if (!result) return { error: 'Skattekontot finns inte för företaget.', status: 404 }
      return { data: { skattekonto_transaction_id: result.external_id, is_ignored: result.is_ignored } }
    } catch (err) {
      if (!(err instanceof SkattekontoLinkError)) throw err
      if (err.code === 'TRANSACTION_NOT_FOUND') {
        return { error: err.message, errorCode: 'NOT_FOUND', status: 404 }
      }
      if (err.code === 'ALREADY_BOOKED') {
        return { error: err.message, errorCode: 'TX_IGNORE_ALREADY_BOOKED', status: 409 }
      }
      throw err
    }
  }

  // Issue #1661: the same core the dashboard and v1 routes use, so the three
  // doors cannot drift. It refuses a booked row through all three anchors
  // (journal_entry_id, payment allocations, voucher links), is idempotent,
  // and writes no verifikat: a locked or closed period does not block it.
  const outcome = await setTransactionIgnored(
    supabase,
    companyId,
    validated.transaction_id as string,
    validated.ignored,
    { userId },
  )
  if (!outcome.ok) {
    const entry = getErrorEntry(outcome.code)
    return {
      error: entry?.message_sv ?? 'Transaktionen kunde inte ignoreras.',
      errorCode: outcome.code,
      status: outcome.status,
    }
  }

  return {
    data: {
      transaction_id: outcome.transaction_id,
      is_ignored: outcome.is_ignored,
      // false when the row was already in the requested state.
      changed: outcome.changed,
    },
  }
}

// ── Kundorder (sales orders) ────────────────────────────────────────
//
// The four executors below never touch totals, VAT or the order state
// machine themselves: they re-validate the staged params (ASVS V4.5) and
// hand them to the lib/sales-orders service the cookie routes use, so the
// MCP door and the web door produce identical rows and identical refusals.

/** Zod failure on a staged row -> 400 with the first issue named. */
function invalidStagedParams(err: unknown): ExecutorResult {
  if (err instanceof z.ZodError) {
    const issue = err.issues[0]
    return { error: `Invalid ${issue?.path?.join('.') ?? 'params'}: ${issue?.message ?? 'validation failed'}`, status: 400 }
  }
  throw err
}

const RevokeServiceAccountParamsSchema = z.object({ service_account_id: z.string().uuid() })

/**
 * revoke_service_account (gnubok_revoke_service_account): revoke one of the
 * company's service accounts, and with it every key it has (migration
 * 20261016120000). revoke_service_account is the authority: it re-checks
 * that the approver is an owner or admin, and it is executable by
 * service_role only, so the call goes through the service client on every
 * path, an approval in the app included (a session client cannot call it).
 * `userId` is the approver each commit path verified. A service account's
 * own key never manages service accounts, so its approval is handed back
 * (403, the op stays pending) for a person to give.
 */
async function commitRevokeServiceAccount(
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const parsed = RevokeServiceAccountParamsSchema.safeParse(params)
  if (!parsed.success) return invalidStagedParams(parsed.error)
  const actor = getActor()
  if (actor?.type === 'service_account') {
    const entry = getErrorEntry('SERVICE_ACCOUNT_KEY_NOT_PERMITTED')
    return {
      error: entry?.message_sv ?? 'SERVICE_ACCOUNT_KEY_NOT_PERMITTED',
      errorCode: 'SERVICE_ACCOUNT_KEY_NOT_PERMITTED',
      status: entry?.httpStatus ?? 403,
    }
  }
  const result = await revokeServiceAccount(
    createServiceClient(),
    companyId,
    { userId, actor: { type: actor?.type ?? 'user', ...(actor?.label ? { label: actor.label } : {}) } },
    parsed.data.service_account_id,
  )
  if (!result.ok) {
    const entry = getErrorEntry(result.code)
    return {
      error: entry?.message_sv ?? result.code,
      errorCode: result.code,
      status: entry?.httpStatus ?? 400,
      ...(result.details ? { data: result.details } : {}),
    }
  }
  const account = result.value
  return {
    data: {
      service_account_id: account.id,
      name: account.name,
      status: account.status,
      revoked_at: account.revoked_at,
      revoked_by: account.revoked_by,
    },
  }
}

/**
 * Map a lib/sales-orders ServiceFailure onto the ExecutorResult contract.
 * A coded failure carries the structured-error httpStatus (404/409 auto-
 * reject the op, 400 fails it) and its Swedish message, with the service's
 * details persisted so the approver sees WHICH line was refused; a raw DB
 * failure is a 500 with the driver message.
 */
function salesOrderFailure(failure: ServiceFailure): ExecutorResult {
  if ('code' in failure) {
    const entry = getErrorEntry(failure.code)
    return {
      error: entry?.message_sv ?? failure.code,
      errorCode: failure.code,
      status: entry?.httpStatus ?? 400,
      ...(failure.details ? { data: failure.details } : {}),
    }
  }
  const dbMessage =
    typeof failure.dbError === 'object' && failure.dbError !== null && 'message' in failure.dbError
      ? String((failure.dbError as { message: unknown }).message)
      : null
  return { error: dbMessage || getErrorEntry('SALES_ORDER_CREATE_FAILED')?.message_sv || 'Kundordern kunde inte sparas.', status: 500 }
}

async function commitCreateSalesOrder(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  let validated
  try {
    validated = CreateSalesOrderParamsSchema.parse(params)
  } catch (err) {
    return invalidStagedParams(err)
  }

  const result = await createSalesOrder(supabase, { companyId, userId, input: validated })
  if (!result.ok) return salesOrderFailure(result)

  const { order } = result
  return {
    data: {
      sales_order_id: order.id,
      order_number: order.order_number,
      status: order.status,
      total: order.total,
      currency: order.currency,
    },
  }
}

async function commitTransitionSalesOrder(
  supabase: SupabaseClient,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  let validated
  try {
    validated = TransitionSalesOrderParamsSchema.parse(params)
  } catch (err) {
    return invalidStagedParams(err)
  }

  // The service re-reads the order and refuses a transition the current
  // status does not allow (compare-and-set), so an order that moved between
  // staging and approval lands as SALES_ORDER_INVALID_STATE, never as a
  // silent overwrite.
  const result = await transitionSalesOrder(supabase, {
    companyId,
    orderId: validated.sales_order_id,
    action: validated.action,
  })
  if (!result.ok) return salesOrderFailure(result)

  const { order } = result
  return {
    data: {
      sales_order_id: order.id,
      order_number: order.order_number,
      status: order.status,
      action: validated.action,
    },
  }
}

async function commitRegisterSalesOrderDelivery(
  supabase: SupabaseClient,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  let validated
  try {
    validated = RegisterSalesOrderDeliveryParamsSchema.parse(params)
  } catch (err) {
    return invalidStagedParams(err)
  }

  const { sales_order_id: orderId, ...input } = validated
  const result = await registerSalesOrderDelivery(supabase, { companyId, orderId, input })
  if (!result.ok) return salesOrderFailure(result)

  const { order } = result
  return {
    data: {
      sales_order_id: order.id,
      order_number: order.order_number,
      status: order.status,
      last_delivery_date: order.last_delivery_date,
      delivery_progress: order.delivery_progress ?? null,
    },
  }
}

async function commitCreateInvoiceFromSalesOrder(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  let validated
  try {
    validated = CreateInvoiceFromSalesOrderParamsSchema.parse(params)
  } catch (err) {
    return invalidStagedParams(err)
  }

  // The service re-reads the order, re-picks the lines against the CURRENT
  // invoiced quantities and builds the draft through buildInvoiceWriteData,
  // so a line invoiced elsewhere between staging and approval is refused
  // (SALES_ORDER_OVER_INVOICED / NOTHING_TO_INVOICE) instead of double-billed.
  const { sales_order_id: orderId, ...input } = validated
  const result = await createInvoiceFromSalesOrder(supabase, { companyId, userId, orderId, input })
  if (!result.ok) return salesOrderFailure(result)

  const { invoice, order } = result

  // Same event the direct create_invoice executor emits, so extension
  // handlers (webhooks, digests) see order-born drafts too.
  const { data: completeInvoice } = await supabase
    .from('invoices')
    .select('*, customer:customers(*), items:invoice_items(*)')
    .eq('id', invoice.id)
    .single()
  // Post-commit notification only: the draft already exists, so an event
  // failure must not reject an operation whose write succeeded.
  try {
    await eventBus.emit({
      type: 'invoice.created',
      payload: { invoice: (completeInvoice ?? invoice) as Invoice, userId, companyId },
    })
  } catch {
    // Non-critical
  }

  return {
    data: {
      invoice_id: invoice.id,
      // Unnumbered draft: the F-series number is assigned on send.
      invoice_number: invoice.invoice_number ?? null,
      sales_order_id: order.id,
      order_number: order.order_number,
      order_status: order.status,
      invoicing_progress: order.invoicing_progress ?? null,
      total: invoice.total,
      currency: invoice.currency,
    },
  }
}

async function commitCreateSupplier(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  // Defense in depth: re-validate the staged params at the commit boundary
  // with the register's one rule set, so a tampered pending_operations row
  // cannot inject malformed payment-routing data (ASVS V4.5).
  const validated = CreateSupplierSchema.safeParse(params)
  if (!validated.success) {
    const issue = validated.error.issues[0]
    const path = issue?.path?.join('.') || 'params'
    return { error: `Invalid ${path}: ${issue?.message ?? 'validation failed'}`, status: 400 }
  }

  // The insert the dashboard and v1 make (lib/suppliers/create-supplier.ts).
  const outcome = await createSupplier({ supabase, companyId, userId, log }, validated.data)
  if (!outcome.ok) {
    const entry = getErrorEntry(outcome.code)
    return {
      error: outcome.messageSv ?? entry?.message_sv ?? outcome.code,
      errorCode: outcome.code,
      status: entry?.httpStatus ?? 500,
    }
  }
  if (outcome.dryRun) return { error: 'create_supplier: unexpected dry-run outcome', status: 500 }
  return { data: { supplier_id: outcome.data.id } }
}

/**
 * Executor for the staged create_dimension_value operation
 * (gnubok_create_dimension_value, dimensions PR3). Inserts a dimension value
 * (SIE #OBJEKT) into the registry. Agents never silently mint reporting
 * values: this always arrives via a human-approved pending_operation.
 *
 * Idempotent on duplicate code: a 23505 on (company_id, dimension_id, code)
 * re-reads the existing row and reports success with already_existed=true, so
 * a raced or re-committed approval never fails on "already there".
 */
async function commitCreateDimensionValue(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  // Defense in depth: re-validate the staged params at the commit boundary so
  // a tampered pending_operations row cannot inject a non-portable code or
  // malformed dates into the registry (ASVS V4.5): mirrors commitCreateSupplier.
  let validated
  try {
    validated = CreateDimensionValueParamsSchema.parse(params)
  } catch (err) {
    if (err instanceof z.ZodError) {
      const issue = err.issues[0]
      const path = issue?.path?.join('.') ?? 'params'
      return { error: `Invalid ${path}: ${issue?.message ?? 'validation failed'}`, status: 400 }
    }
    throw err
  }

  // Get-or-create the system dims (1 = kostnadsställe, 6 = projekt):
  // idempotent lazy seeding. Custom dims must already exist in the registry:
  // agents may stage new VALUES, never new dimensions.
  if (validated.sie_dim_no === 1 || validated.sie_dim_no === 6) {
    const { error: ensureError } = await supabase.rpc('ensure_company_dimensions', {
      p_company_id: companyId,
    })
    if (ensureError) {
      return { error: `Kunde inte skapa systemdimensionerna: ${ensureError.message}`, status: 500 }
    }
  }

  // The staged params address the dimension by its SIE number; the create
  // itself (dates only on an accumulating dimension, the insert, a duplicate
  // code) is createDimensionValue, the same rules the dashboard and v1 run.
  const { data: dimension, error: dimError } = await supabase
    .from('dimensions')
    .select('id, sie_dim_no, name')
    .eq('company_id', companyId)
    .eq('sie_dim_no', validated.sie_dim_no)
    .maybeSingle()

  if (dimError) return { error: dimError.message, status: 500 }
  if (!dimension) {
    return {
      error:
        `Okänd dimension ${validated.sie_dim_no}. Endast registrerade dimensioner kan få nya värden ` +
        '(1 = kostnadsställe och 6 = projekt skapas automatiskt; övriga skapas i registret).',
      status: 400,
    }
  }

  const outcome = await createDimensionValue(
    { supabase, companyId, userId, log: log.child({ operation: 'create_dimension_value' }) },
    dimension.id,
    {
      code: validated.code,
      name: validated.name,
      // optString's z.preprocess widens the inferred type; the inner schema
      // is an ISO date string.
      start_date: (validated.start_date as string | undefined) ?? null,
      end_date: (validated.end_date as string | undefined) ?? null,
    },
  )

  if (!outcome.ok) {
    if (outcome.code === 'DIMENSION_VALUE_DUPLICATE_CODE') {
      // Duplicate code: treat the existing value as success (idempotency).
      const { data: existing, error: existingError } = await supabase
        .from('dimension_values')
        .select('id, code, name, is_active')
        .eq('company_id', companyId)
        .eq('dimension_id', dimension.id)
        .eq('code', validated.code)
        .maybeSingle()
      if (existingError || !existing) {
        return { error: getErrorEntry(outcome.code)?.message_sv ?? outcome.code, errorCode: outcome.code, status: 500 }
      }
      return {
        data: {
          dimension_value_id: existing.id,
          sie_dim_no: dimension.sie_dim_no,
          dimension_name: dimension.name,
          code: existing.code,
          name: existing.name,
          is_active: existing.is_active,
          already_existed: true,
        },
      }
    }
    if (outcome.code === 'DIMENSION_VALUE_DATES_NOT_ALLOWED') {
      return {
        error: `Start-/slutdatum är inte tillåtna på dimensionen "${dimension.name}" (nollställs årligen).`,
        errorCode: outcome.code,
        status: 400,
      }
    }
    const entry = getErrorEntry(outcome.code)
    const cause = (outcome.error as { message?: unknown } | undefined)?.message
    return {
      // Never an empty string: an empty error reads as success downstream.
      error: outcome.messageSv || (typeof cause === 'string' ? cause : '') || entry?.message_sv || outcome.code,
      errorCode: outcome.code,
      status: entry?.httpStatus ?? 500,
    }
  }
  if (outcome.dryRun) return { data: outcome.preview }

  return {
    data: {
      dimension_value_id: outcome.data.id,
      sie_dim_no: dimension.sie_dim_no,
      dimension_name: dimension.name,
      code: outcome.data.code,
      name: outcome.data.name,
      is_active: outcome.data.is_active,
      already_existed: false,
    },
  }
}

/**
 * Executor for the staged retag_line_dimensions operation
 * (gnubok_tag_journal_lines, dimensions PR6). Loops the staged line_ids
 * through the retag_line_dimensions RPC: the ONE audited write path for
 * changing dimension tags on posted lines. The RPC enforces everything per
 * line at commit time (open period, company lock date, active registry
 * values, writer role, posted status) and writes an immutable
 * dimension_retag_log row before touching the line.
 *
 * Partial-success semantics: one line failing (e.g. its period was locked
 * between staging and approval) must not roll back the lines already
 * retagged: each RPC call is its own transaction. Failures are collected
 * and echoed (capped at 20) so the caller can re-stage just the failed set.
 * Only when EVERY line fails does the operation as a whole fail.
 *
 * The loop, the merge of the staged pairs into each line's current bag, and
 * the all-refused rule live in lib/dimensions/retag-service.ts. A merge
 * reads the bags at approval, not at staging, so a tag set in between is
 * kept.
 */
async function commitRetagLineDimensions(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  // Defense in depth: re-validate the staged params at the commit boundary so
  // a tampered pending_operations row cannot inject arbitrary ids or a
  // malformed bag (ASVS V4.5): mirrors commitCreateDimensionValue.
  let validated
  try {
    validated = RetagLineDimensionsParamsSchema.parse(params)
  } catch (err) {
    if (err instanceof z.ZodError) {
      const issue = err.issues[0]
      const path = issue?.path?.join('.') ?? 'params'
      return { error: `Invalid ${path}: ${issue?.message ?? 'validation failed'}`, status: 400 }
    }
    throw err
  }

  const outcome = await retagLines(
    { supabase, companyId, userId, log: log.child({ operation: 'retag_line_dimensions' }) },
    {
      line_ids: validated.line_ids,
      dimensions: validated.dimensions,
      // A row staged before the mode existed parses as 'replace' (the schema
      // default): what its approver was shown.
      mode: validated.mode,
      reason: validated.reason,
    },
  )
  // Reading the lines for a merge failed: nothing was written.
  if (!outcome.ok) throw outcome.error ?? new Error(outcome.code)
  if (outcome.dryRun) return { data: outcome.preview }

  const { retagged, unchanged, failed } = outcome.data
  // Echo at most 20 failures: enough to act on without bloating result_data
  // on a pathological 500-line all-but-one failure.
  const echoedFailures = failed.slice(0, 20)
  const refused = everyRetagRefused(outcome.data)
  if (refused) {
    return {
      error: refused.messageSv,
      errorCode: 'DIMENSION_RETAG_FAILED',
      status: 400,
      data: { failed_count: failed.length, failed: echoedFailures },
    }
  }

  return {
    data: {
      retagged,
      unchanged,
      failed_count: failed.length,
      failed: echoedFailures,
      mode: validated.mode,
      dimensions: validated.dimensions,
      ...(validated.filter_summary ? { filter_summary: validated.filter_summary } : {}),
    },
  }
}

/**
 * An approved gnubok_create_transactions row. Stored through
 * ingestTransactions, the pipeline every other door that stores a bank row
 * runs (PSD2 sync, bank-file import, v1 POST /transactions/ingest): its
 * external_id and content dedup against rows a feed or an import already
 * stored, its invoice, supplier-invoice, payment-order and ROT/RUT
 * suggestions and its collections sweep. This executor used to insert the
 * row itself, so a movement the bank feed had already stored was inserted a
 * second time when an agent typed it. What stays here is what only this door
 * does: the argument checks, the refusal of a foreign row without a rate while
 * the approver is present, and the manual kassakonto for ledger_account.
 *
 * A row staged without external_id (every row before this change, and any
 * row the agent sends without one) is stored under `mcp:<operation id>`, so
 * the row is addressable by Layer-1 dedup like any feed row.
 */
async function commitCreateTransaction(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>,
  operationId: string,
): Promise<ExecutorResult> {
  const date = params.date as string
  const amount = Number(params.amount)
  const description = (params.description as string) ?? ''
  const currency = ((params.currency as string) || 'SEK') as Currency
  const ledgerAccount = (params.ledger_account as string) || null
  const bankConnectionId = (params.bank_connection_id as string) || null
  const externalId = (params.external_id as string) || null

  if (!date || !description.trim() || !Number.isFinite(amount)) {
    return { error: 'date, description, and amount are required', status: 400 }
  }
  if (ledgerAccount && !/^19\d{2}$/.test(ledgerAccount)) {
    return { error: 'ledger_account must be a BAS 19xx cash account', status: 400 }
  }

  // A foreign-currency row must carry its SEK translation from the moment it
  // lands. The categorization path used to resolve a line amount through the
  // LENIENT resolveSekAmount() (lib/bookkeeping/currency-utils.ts), which falls
  // back to the RAW foreign number when amount_sek and exchange_rate are both
  // empty (it now refuses with TX_MISSING_SEK_VALUE). A
  // staged 1500 USD row therefore debited 1500 kr while buildCurrencyMetadata()
  // stamped the same line `currency: USD, amount_in_currency: 1500`: one line
  // asserting two different amounts. Nothing catches it, because every leg is
  // scaled by the same wrong factor so the verifikation still balances and no
  // trigger fires. Under ML 8 kap 21-23 § the beskattningsunderlag must be
  // translated at a published kurs, so the understatement lands straight in
  // rutorna 05/10 or 48 of the momsdeklaration.
  //
  // Rate is fetched for the row's OWN date (not "today"), with the supabase
  // client passed so `exchange_rates` acts as the read-through cache and as the
  // last-cached-observation fallback when Riksbanken 429s. Identical call shape
  // to lib/transactions/ingest.ts, which then reads the same rate from that
  // cache when it translates the row.
  //
  // Resolved BEFORE ensureManualCashAccount below so a refusal leaves no
  // half-created kassakonto behind (same ordering rationale as the arrival
  // number in app/api/supplier-invoices/route.ts).
  if (currency !== 'SEK') {
    const rateDate = new Date(date)
    let rateInfo: Awaited<ReturnType<typeof fetchExchangeRate>> = null
    if (!Number.isNaN(rateDate.getTime())) {
      try {
        rateInfo = await fetchExchangeRate(currency, rateDate, supabase)
      } catch {
        // fetchExchangeRate swallows its own network errors and reports null; a
        // throw can only come from a mock or a future refactor. Treat it as
        // "no rate", never as a reason to invent one.
        rateInfo = null
      }
    }
    if (!rateInfo || !Number.isFinite(rateInfo.rate) || rateInfo.rate <= 0) {
      // Riksbanken rate-limits per IP, and an outage looks the same from
      // here: the rate exists, it just could not be fetched right now. The
      // refusal below is for a rate that does not exist.
      if (isExchangeRateTemporarilyUnavailable(currency)) return exchangeRateRetryLater()
      // Refuse rather than insert with NULL. ingest.ts may store NULL because
      // it is a bulk bank feed where one unreachable rate must not abort the
      // batch, and its rows stay repairable via
      // /api/transactions/[id]/refresh-exchange-rate. Here there is exactly one
      // row and the approver is present, so storing NULL would only relocate
      // the failure to the categorization step (which refuses the row with
      // TX_MISSING_SEK_VALUE). Refusing here surfaces it while a human is
      // looking at this row.
      return {
        error:
          `Transaktionen är i ${currency} men ingen växelkurs kunde hämtas för ${date}. ` +
          `Utan kurs skulle raden bokföras som om 1 ${currency} = 1 SEK. ` +
          'Försök igen när kursen finns publicerad, eller registrera beloppet i kronor.',
        status: 400,
      }
    }
  }

  // Bind the row to a manual kassakonto when a ledger account is given, so
  // reconciliation and voucher matching resolve the real account instead of
  // falling back to 1930 (issue #1016). Find-or-create; the row's currency
  // follows this transaction. Without one, the company's default account in
  // that currency (crm#1171): a bank-feed or bank-file row is never stored
  // unbound, and an unbound one dropped out of every per-account view.
  // Ingest then settles the batch on the account's ledger number.
  const cashAccount = ledgerAccount
    ? { id: await ensureManualCashAccount(supabase, companyId, ledgerAccount, currency), ledger_account: ledgerAccount }
    : await resolveDefaultCashAccount(supabase, companyId, currency, bankConnectionId)

  // Auto-categorization stays off: the row lands uncategorized and the agent
  // books it with gnubok_categorize_transaction, as the staging promised.
  const result = await ingestTransactions(
    supabase,
    companyId,
    userId,
    [
      {
        date,
        description: description.trim(),
        amount,
        currency,
        external_id: externalId ?? `mcp:${operationId}`,
        import_source: 'mcp',
        bank_connection_id: bankConnectionId,
      },
    ],
    { settlementAccount: cashAccount?.ledger_account, skipAutoCategorization: true },
  )

  const stored = result.transaction_ids[0]
  if (stored) return { data: { transaction_id: stored, cash_account_id: cashAccount?.id ?? null } }

  const skipped = result.skipped?.[0]
  if (skipped) {
    // The movement is already stored: by external_id, or by content from a
    // bank feed or an import. A second row would invite a second booking.
    const entry = getErrorEntry('TX_CREATE_DUPLICATE')
    const named = skipped.matched_transaction_id ?? skipped.matched_external_id
    return {
      error: `${entry?.message_sv ?? 'Transaktionen finns redan.'}${named ? ` Befintlig transaktion: ${named}.` : ''}`,
      errorCode: 'TX_CREATE_DUPLICATE',
      status: entry?.httpStatus ?? 409,
      data: {
        reason: skipped.reason,
        matched_transaction_id: skipped.matched_transaction_id,
        matched_external_id: skipped.matched_external_id,
      },
    }
  }

  return { error: result.first_error?.message ?? 'The transaction could not be stored.', status: 500 }
}

async function commitCreateInvoice(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const customerId = typeof params.customer_id === 'string' ? params.customer_id : ''
  const { data: customer, error: customerError } = await supabase
    .from('customers').select('*').eq('id', customerId).eq('company_id', companyId).single()

  if (customerError || !customer) {
    return { error: 'Customer not found: they may have been deleted.', status: 404 }
  }

  // The same build the staging preview ran (buildStagedInvoice): the shared
  // buildInvoiceWriteData with every rule the web and v1 doors apply (VAT
  // gate, balance-sheet account on a VAT line, ROT/RUT, accrual, articles,
  // currency), so what the approver saw is what gets written.
  const staged = await buildStagedInvoice({ supabase, companyId, customer: customer as Customer, params })
  if (!staged.ok) {
    if ('validation' in staged) {
      const issue = staged.validation.issues[0]
      return {
        error: `Invalid ${issue?.path?.join('.') || 'params'}: ${issue?.message ?? 'validation failed'}`,
        status: 400,
      }
    }
    if ('dbError' in staged) {
      const message = (staged.dbError as { message?: string } | null)?.message
      return { error: message ?? 'Database error', status: 500 }
    }
    const entry = getErrorEntry(staged.code)
    return {
      error: entry?.message_sv ?? staged.code,
      errorCode: staged.code,
      status: entry?.httpStatus ?? 400,
      data: staged.details as Record<string, unknown> | undefined,
    }
  }
  const { isQuote, build } = staged
  const { invoiceFields } = build

  // Refuse at the approval boundary rather than store exchange_rate NULL:
  // createInvoiceJournalEntry() refuses such an invoice with
  // INVOICE_FX_RATE_MISSING anyway, by which point the invoice row (and its
  // F-series number, once sent) exists and the approver has moved on. A NULL
  // rate is booked 1:1 otherwise: 1000 EUR to 3001 as 1000 kr, understating
  // ruta 05 and ruta 10 by the whole FX difference.
  if (
    invoiceFields.currency !== 'SEK' &&
    !(typeof invoiceFields.exchange_rate === 'number' && Number.isFinite(invoiceFields.exchange_rate) && invoiceFields.exchange_rate > 0)
  ) {
    // Nothing has been inserted yet (buildStagedInvoice only reads), so a
    // temporary Riksbanken refusal leaves the operation approvable.
    if (isExchangeRateTemporarilyUnavailable(invoiceFields.currency)) return exchangeRateRetryLater()
    return {
      error:
        getErrorEntry('INVOICE_FX_RATE_MISSING')?.message_sv ??
        'Fakturan är i utländsk valuta men saknar växelkurs. Ange fakturans växelkurs innan den bokförs.',
      status: 400,
    }
  }

  // Quotes are numbered at insert from their own OF-series (see
  // generate_quote_number); ensureInvoiceNumber must never run on one.
  let quoteNumber: string | null = null
  if (isQuote) {
    const { data: allocated, error: quoteNumberError } = await supabase.rpc('generate_quote_number', {
      p_company_id: companyId,
    })
    if (quoteNumberError || !allocated) {
      return {
        error:
          getErrorEntry('INVOICE_CREATE_NUMBER_ASSIGN_FAILED')?.message_sv ??
          'Offertnumret kunde inte tilldelas.',
        errorCode: 'INVOICE_CREATE_NUMBER_ASSIGN_FAILED',
        status: 500,
      }
    }
    quoteNumber = allocated as string
  }

  // Which bank account the customer pays to; validated against the
  // company's payee accounts (same rule as the web and v1 routes).
  const payeeChoice = await resolveInvoicePayeeChoice(
    supabase,
    companyId,
    invoiceFields.currency,
    staged.params.payment_cash_account_id ?? null,
  )
  if (!payeeChoice.ok) {
    const entry = getErrorEntry(payeeChoice.code)
    return { error: entry?.message_sv ?? payeeChoice.code, status: 400, data: payeeChoice.details }
  }

  const { data: invoice, error: invoiceError } = await supabase
    .from('invoices')
    .insert({
      user_id: userId,
      company_id: companyId,
      invoice_number: quoteNumber,
      ...invoiceFields,
      // Explicit keys, not a conditional spread: the phantom-column guard
      // only reads literal payloads. NULL on non-quotes satisfies the pairing CHECK.
      quote_status: isQuote ? 'open' : null,
      paid_amount: 0,
      payment_cash_account_id: payeeChoice.fields.payment_cash_account_id,
      payment_details: payeeChoice.fields.payment_details,
    })
    .select()
    .single()

  if (invoiceError) return { error: invoiceError.message, status: 500 }

  const { error: itemsError } = await supabase
    .from('invoice_items')
    .insert(build.items.map((row) => ({ ...row, invoice_id: invoice.id })))

  if (itemsError) {
    await supabase.from('invoices').delete().eq('id', invoice.id)
    return { error: itemsError.message, status: 500 }
  }

  // invoice.created is for real invoices only: a quote is an offer, not a
  // claim, and has no downstream consumer obligation (v1 route parity).
  if (!isQuote) {
    const { data: completeInvoice } = await supabase
      .from('invoices')
      .select('*, customer:customers(*), items:invoice_items(*)')
      .eq('id', invoice.id)
      .single()

    if (completeInvoice) {
      await eventBus.emit({
        type: 'invoice.created',
        payload: { invoice: completeInvoice as Invoice, userId, companyId },
      })
    }
  }

  return {
    data: {
      invoice_id: invoice.id,
      invoice_number: invoice.invoice_number ?? quoteNumber,
      // Why the treatment is what it is (#2749, #2558): echoed so an agent
      // that auto-approved still sees what preview.vat_warnings said.
      ...(build.warnings.length > 0 ? { vat_warnings: build.warnings } : {}),
    },
  }
}

/**
 * Commit a staged gnubok_register_booked_invoice (crm#1094): a create_invoice
 * whose params carry mode 'register_booked'. registerBookedInvoice re-runs
 * every staging rule against the books as they are now, then writes the
 * invoices row and, for a partly paid invoice, its one payment row dated
 * balance_as_of; no journal entry or line.
 */
async function commitRegisterBookedInvoice(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>,
): Promise<ExecutorResult> {
  const parsed = RegisterBookedInvoiceParamsSchema.safeParse(params)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return {
      error: `Invalid ${issue?.path?.join('.') || 'params'}: ${issue?.message ?? 'validation failed'}`,
      errorCode: 'VALIDATION_ERROR',
      status: 400,
    }
  }
  const outcome = await registerBookedInvoice(supabase, companyId, userId, parsed.data)
  if (!outcome.ok) {
    const entry = getErrorEntry(outcome.code)
    return {
      error: entry?.message_sv ?? outcome.message,
      errorCode: outcome.code,
      status: entry?.httpStatus ?? 400,
      data: { message_en: outcome.message, ...(outcome.details ?? {}) },
    }
  }
  return {
    data: {
      invoice_id: outcome.invoiceId,
      invoice_number: parsed.data.invoice_number,
      status: outcome.plan.status,
      remaining_amount: outcome.plan.remainingAmount,
      journal_entry_id: outcome.plan.voucher.journalEntryId,
    },
  }
}

/**
 * Commit a staged gnubok_register_booked_supplier_invoice (crm#1094): a
 * create_supplier_invoice_from_inbox whose params carry mode
 * 'register_booked'. registerBookedSupplierInvoice re-runs every staging rule
 * against the books as they are now, then writes the supplier_invoices row
 * with the verifikat's rows and, for a partly paid invoice, its one payment
 * row dated balance_as_of; no journal entry or line.
 */
async function commitRegisterBookedSupplierInvoice(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>,
): Promise<ExecutorResult> {
  const parsed = RegisterBookedSupplierInvoiceParamsSchema.safeParse(params)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return {
      error: `Invalid ${issue?.path?.join('.') || 'params'}: ${issue?.message ?? 'validation failed'}`,
      errorCode: 'VALIDATION_ERROR',
      status: 400,
    }
  }
  const outcome = await registerBookedSupplierInvoice(supabase, companyId, userId, parsed.data)
  if (!outcome.ok) {
    const entry = getErrorEntry(outcome.code)
    return {
      error: entry?.message_sv ?? outcome.message,
      errorCode: outcome.code,
      status: entry?.httpStatus ?? 400,
      data: { message_en: outcome.message, ...(outcome.details ?? {}) },
    }
  }
  return {
    data: {
      supplier_invoice_id: outcome.supplierInvoiceId,
      // null when the supplier reuses the number: it is then the payment reference.
      supplier_invoice_number: outcome.plan.supplierInvoiceNumber,
      payment_reference: outcome.plan.paymentReference,
      arrival_number: outcome.arrivalNumber,
      status: outcome.plan.status,
      remaining_amount: outcome.plan.remainingAmount,
      journal_entry_id: outcome.plan.voucher.journalEntryId,
    },
  }
}

/**
 * Commit a staged update_invoice: rewrite a DRAFT invoice in place (header
 * fields and/or a FULL REPLACE of its line items).
 *
 * Staging is not a lock: the invoice can be sent, paid, or credited between
 * staging and approval, so the shared editable-draft predicate
 * (isEditableInvoiceDraft) is re-checked HERE, and the row update carries a
 * .eq('status','draft') guard so a concurrent send turns into a 0-row update
 * instead of rewriting a now-issued invoice.
 *
 * Totals and VAT are recomputed by buildInvoiceWriteData: the exact builder
 * the cookie PATCH route (app/api/invoices/[id]) and the v1 REST routes use,
 * so VAT gating, accrual guards, ROT/RUT compute, and currency conversion
 * cannot drift. When the staged changes carry no items, the existing rows are
 * fed back through the builder so a header-only edit (e.g. a new invoice_date
 * on a foreign-currency draft) still recomputes the SEK legs consistently.
 */
async function commitUpdateInvoice(
  supabase: SupabaseClient,
  companyId: string,
  params: Record<string, unknown>,
): Promise<ExecutorResult> {
  // Re-validate staged params at the commit boundary (defense in depth: a
  // hand-crafted pending_operations row must not reach the write below).
  let validated
  try {
    validated = UpdateInvoiceParamsSchema.parse(params)
  } catch (err) {
    if (err instanceof z.ZodError) {
      const issue = err.issues[0]
      return {
        error: `Invalid ${issue?.path?.join('.') ?? 'params'}: ${issue?.message ?? 'validation failed'}`,
        status: 400,
      }
    }
    throw err
  }

  const { invoice_id: invoiceId, changes } = validated

  const { data: existing, error: fetchError } = await supabase
    .from('invoices')
    .select(
      'id, status, invoice_number, journal_entry_id, is_self_billed, credited_invoice_id, quote_status, customer_id, document_type, invoice_date, due_date, delivery_date, currency, your_reference, our_reference, invoice_marking, notes, payment_link_url, payment_link_auto, ore_rounding, default_dimensions, deduction_personnummer_encrypted, deduction_personnummer_last4, vat_treatment_override, delivery_country',
    )
    .eq('id', invoiceId)
    .eq('company_id', companyId)
    .maybeSingle()

  if (fetchError) return { error: fetchError.message, status: 500 }
  if (!existing) return { error: 'Invoice not found: it may have been deleted.', status: 404 }

  if (!isEditableInvoiceDraft(existing)) {
    return {
      error: `Fakturan är inte längre ett redigerbart utkast (status: ${existing.status}). Skickade eller bokförda fakturor rättas med kreditfaktura.`,
      status: 409,
    }
  }

  // The customer is structural on a draft edit (never changed here): resolve
  // the EXISTING customer for VAT rules.
  const { data: customer, error: customerError } = await supabase
    .from('customers')
    .select('*')
    .eq('id', existing.customer_id)
    .eq('company_id', companyId)
    .single()

  if (customerError || !customer) {
    return { error: 'Customer not found: they may have been deleted.', status: 404 }
  }

  // Drift/tamper gate for staged article references: the FK on
  // invoice_items.article_id proves the article exists, not that it belongs
  // to THIS company, and the top-level arg guard never sees a nested
  // items[].article_id.
  if (changes.items) {
    const stagedArticleIds = Array.from(
      new Set(changes.items.map((item) => item.article_id).filter((a): a is string => !!a)),
    )
    if (stagedArticleIds.length > 0) {
      const { data: articleRows, error: articleError } = await supabase
        .from('articles')
        .select('id')
        .eq('company_id', companyId)
        .in('id', stagedArticleIds)
      if (articleError) return { error: articleError.message, status: 500 }
      const foundArticleIds = new Set((articleRows ?? []).map((a: { id: string }) => a.id))
      const missingArticleId = stagedArticleIds.find((a) => !foundArticleIds.has(a))
      if (missingArticleId) {
        return { error: `Artikel ${missingArticleId} finns inte i företaget`, status: 400 }
      }
    }
  }

  // Effective line set: FULL REPLACE when staged, otherwise the current rows
  // fed back through the builder unchanged.
  let itemsInput: InvoiceWriteItemInput[]
  if (changes.items) {
    itemsInput = changes.items as InvoiceWriteItemInput[]
  } else {
    const { data: itemRows, error: itemsFetchError } = await supabase
      .from('invoice_items')
      .select(
        'line_type, description, quantity, unit, unit_price, discount_percent, vat_rate, article_id, revenue_account, sales_order_item_id, deduction_type, labor_hours, work_type, housing_designation, apartment_number, brf_org_number, accrual_period_start, accrual_period_end, accrual_balance_account, dimensions',
      )
      .eq('invoice_id', invoiceId)
      .order('sort_order', { ascending: true })
    if (itemsFetchError) return { error: itemsFetchError.message, status: 500 }
    itemsInput = (itemRows ?? []) as InvoiceWriteItemInput[]
  }
  if (itemsInput.length === 0) {
    return { error: 'Fakturan saknar rader: minst en rad krävs.', status: 400 }
  }

  // ROT/RUT claim info lives per line, not on the header: derive the
  // invoice-level inputs the builder's presence checks expect from the first
  // deduction line (per-line values win in the item mapping regardless).
  const firstDeduction = itemsInput.find((item) => item.deduction_type)

  const input: InvoiceWriteInput = {
    customer_id: existing.customer_id,
    invoice_date: changes.invoice_date ?? existing.invoice_date,
    due_date: changes.due_date ?? existing.due_date,
    delivery_date:
      changes.delivery_date !== undefined ? changes.delivery_date : existing.delivery_date,
    currency: existing.currency as Currency,
    your_reference: changes.your_reference ?? existing.your_reference ?? undefined,
    our_reference: changes.our_reference ?? existing.our_reference ?? undefined,
    invoice_marking: changes.invoice_marking ?? existing.invoice_marking ?? undefined,
    notes: changes.notes ?? existing.notes ?? undefined,
    // Not editable through this operation: fed back so the builder echoes the
    // stored values instead of clearing them.
    payment_link_url: existing.payment_link_url ?? undefined,
    payment_link_auto: existing.payment_link_auto ?? undefined,
    ore_rounding: existing.ore_rounding ?? undefined,
    // Omitted = the builder leaves the column alone; null clears it.
    qr_mode: changes.qr_mode,
    deduction_housing_designation: firstDeduction?.housing_designation ?? undefined,
    deduction_apartment_number: firstDeduction?.apartment_number ?? undefined,
    deduction_brf_org_number: firstDeduction?.brf_org_number ?? undefined,
    default_dimensions:
      changes.default_dimensions ??
      ((existing.default_dimensions as Record<string, string> | null) ?? {}),
    items: itemsInput,
  }

  const build = await buildInvoiceWriteData({
    supabase,
    companyId,
    customer: customer as Customer,
    documentType: (existing.document_type || 'invoice') as InvoiceDocumentType,
    input,
    // The stored personnummer exists only as ciphertext: an edit that carries
    // deduction lines but no plaintext keeps the stored value.
    existingPersonnummer: existing.deduction_personnummer_encrypted
      ? {
          encrypted: existing.deduction_personnummer_encrypted,
          last4: existing.deduction_personnummer_last4 ?? null,
        }
      : null,
    // A draft that stated its own VAT treatment (#2906) keeps it: this
    // operation does not carry the fields.
    existingVatOverride: {
      vat_treatment: existing.vat_treatment_override ?? null,
      delivery_country: existing.delivery_country ?? null,
    },
  })
  if (!build.ok) {
    if ('dbError' in build) {
      const message = (build.dbError as { message?: string } | null)?.message
      return { error: message ?? 'Database error', status: 500 }
    }
    const entry = getErrorEntry(build.code)
    return {
      error: entry?.message_sv ?? build.code,
      status: entry?.httpStatus ?? 400,
      data: build.details as Record<string, unknown> | undefined,
    }
  }

  // invoice_number and status are intentionally NOT in build.invoiceFields:
  // editing never (re)allocates a number nor changes lifecycle state.
  const { data: updated, error: updateError } = await supabase
    .from('invoices')
    .update({ ...build.invoiceFields, updated_at: new Date().toISOString() })
    .eq('id', invoiceId)
    .eq('company_id', companyId)
    .eq('status', 'draft')
    .select('id')

  if (updateError) return { error: updateError.message, status: 500 }
  if (!updated || updated.length === 0) {
    return {
      error: 'Fakturan är inte längre ett utkast: den har skickats eller bokförts efter att ändringen förbereddes.',
      status: 409,
    }
  }

  const replaced = await replaceInvoiceItems(supabase, invoiceId, build.items)
  if (!replaced.ok) {
    if (replaced.stage === 'guard') {
      return { error: replaced.messageSv, errorCode: replaced.code, status: 409 }
    }
    return {
      error: `Fakturaraderna kunde inte skrivas om (${replaced.stage}): ${replaced.error.message}`,
      status: 500,
    }
  }

  return {
    data: {
      invoice_id: invoiceId,
      invoice_number: existing.invoice_number ?? null,
      subtotal: build.invoiceFields.subtotal,
      vat_amount: build.invoiceFields.vat_amount,
      total: build.invoiceFields.total,
      item_count: build.items.length,
      items_replaced: Boolean(changes.items),
      // Same non-blocking VAT-treatment warnings as every other write path.
      ...(build.warnings.length > 0 ? { vat_warnings: build.warnings } : {}),
    },
  }
}

async function commitMarkInvoicePaid(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const invoiceId = params.invoice_id as string
  const paymentDate = (params.payment_date as string) || todayIsoStockholm()

  const { data: invoice, error: invoiceError } = await supabase
    .from('invoices')
    .select('*, customer:customers(*), items:invoice_items(*)')
    .eq('id', invoiceId)
    .eq('company_id', companyId)
    .single()

  if (invoiceError || !invoice) return { error: 'Invoice not found', status: 404 }
  if (invoice.credited_invoice_id) {
    return { error: 'Kreditfakturor kan inte markeras som betalda.', status: 409 }
  }
  // Parity with the dashboard mark-paid route: a quote is an offer, not a
  // claim. Proformas keep working (a prepayment record with no verifikat).
  if (invoice.document_type === 'quote') {
    const entry = getErrorEntry('INVOICE_QUOTE_NOT_PAYABLE')
    // 409 like the credit-note guard above: the dispatcher records it as
    // rejected (a state refusal), not failed (an execution error).
    return { error: entry?.message_sv ?? 'Only invoices can be paid.', errorCode: 'INVOICE_QUOTE_NOT_PAYABLE', status: 409 }
  }
  if (!isMatchableInvoiceStatus(invoice.status)) {
    return { error: 'Invoice can only be marked as paid when status is sent, overdue or partially paid', status: 409 }
  }

  // Duplicate-payment guard: parity with the web mark-paid route, which the
  // agent path otherwise bypassed. If an unlinked inbound bank transaction
  // already looks like this invoice's payment, booking a parallel payment
  // voucher here creates exactly the orphan that later double-counts the
  // receipt. Fail closed; the agent re-stages with allow_duplicate=true (after
  // the user confirms) or, better, matches the transaction to the invoice
  // instead. Fail-open on a detection error so it never blocks a real payment.
  if (params.allow_duplicate !== true) {
    const customerName = (invoice as { customer?: { name?: string } }).customer?.name
    if (customerName) {
      const remainingAmount =
        (invoice as { remaining_amount?: number }).remaining_amount ?? invoice.total
      let candidates: Awaited<ReturnType<typeof findDuplicatePaymentCandidatesForInvoice>> = []
      try {
        candidates = await findDuplicatePaymentCandidatesForInvoice(supabase, {
          companyId,
          invoice: {
            invoice_number: invoice.invoice_number,
            customer_name: customerName,
            currency: invoice.currency ?? null,
            total: invoice.total ?? null,
            total_sek: invoice.total_sek ?? null,
            exchange_rate: invoice.exchange_rate ?? null,
          },
          // remaining_amount is stored in the invoice currency; the lookup
          // converts it before banding kronor bank rows.
          paymentAmount: remainingAmount,
          paymentDate,
        })
      } catch (err) {
        log.warn('duplicate-payment detection failed (continuing)', err)
      }
      if (candidates.length > 0) {
        // Reason-aware wording: a row that is already a verifikat must not be
        // "matched" (that books the money twice); it must be corrected.
        const alreadyBooked = candidates.some((c) => c.match_reason === 'already_booked')
        return {
          error: alreadyBooked
            ? `Möjlig dubbelbokning: banktransaktionen som ser ut att vara betalningen för faktura ` +
              `${invoice.invoice_number} är redan bokförd som en egen verifikation. Bokför inte betalningen ` +
              `igen: rätta dubbelbokföringen i stället (vänd en av verifikationerna med storno och koppla underlaget ` +
              `till den som blir kvar). Kör om med allow_duplicate=true bara om det verkligen är en separat betalning.`
            : `Möjlig dubbelbetalning: en obokförd banktransaktion ser ut att vara betalningen för faktura ` +
              `${invoice.invoice_number}. Matcha banktransaktionen mot fakturan (gnubok_match_transaction_to_invoice) ` +
              `i stället för att bokföra en separat betalning. Om det verkligen rör sig om en annan betalning, ` +
              `kör om med allow_duplicate=true.`,
          status: 409,
        }
      }
    }
  } else {
    // allow_duplicate=true bypassed the duplicate-payment guard. The decision
    // to book a payment over a possible existing one must leave a durable
    // behandlingshistorik record (BFNAR 2013:2 p. 9.16) so an auditor can see why
    // the duplicate was allowed. Re-detect to capture the dismissed candidate;
    // best-effort, never blocks the payment. Payload stays PII-safe
    // (ids/amounts/dates only: no customer or merchant name).
    const customerName = (invoice as { customer?: { name?: string } }).customer?.name
    if (customerName) {
      try {
        const remainingAmount =
          (invoice as { remaining_amount?: number }).remaining_amount ?? invoice.total
        const dismissed = await findDuplicatePaymentCandidatesForInvoice(supabase, {
          companyId,
          invoice: {
            invoice_number: invoice.invoice_number,
            customer_name: customerName,
            currency: invoice.currency ?? null,
            total: invoice.total ?? null,
            total_sek: invoice.total_sek ?? null,
            exchange_rate: invoice.exchange_rate ?? null,
          },
          paymentAmount: remainingAmount,
          paymentDate,
        })
        if (dismissed.length > 0) {
          await appendProcessingHistory({
            companyId,
            correlationId: invoiceId,
            aggregateType: 'System',
            aggregateId: invoiceId,
            eventType: 'InvoiceDuplicatePaymentDismissed',
            payload: {
              invoice_id: invoiceId,
              payment_date: paymentDate,
              dismissed_transaction_ids: dismissed.map((c) => c.id),
              candidate_count: dismissed.length,
              via: 'allow_duplicate',
            },
            actor: { type: 'user', id: userId },
            occurredAt: new Date(),
          })
        }
      } catch (logErr) {
        log.warn('failed to record duplicate-payment-dismissal behandlingshistorik', logErr)
      }
    }
  }

  const { accountingMethod, entityType } = await loadBookingContext(supabase, companyId)

  // Settle the full outstanding balance through settleInvoicePayment, the
  // write path the dashboard, v1 and the Stripe sync share: journal entry
  // routed on the invoice's own booking state (cash entry only for a
  // never-booked kontantmetod invoice, else clearing 1510), the
  // invoice_payments row, the CAS-guarded status update that makulerar the
  // voucher on a lost race, and invoice.paid. Prefer remaining_amount; for
  // legacy rows where it was never written, derive it from total - paid_amount
  // rather than the full total (which would double-count a prior partial).
  const inv = invoice as { remaining_amount?: number | null; paid_amount?: number | null }
  const paymentAmount = inv.remaining_amount ?? (invoice.total - (inv.paid_amount ?? 0))
  // Debit the bank account the invoice asked to be paid to (1930 when none
  // was chosen): an agent marking a 1931-invoice paid must not land it on 1930.
  const settlementAccountNumber = await resolveInvoiceSettlementAccount(supabase, companyId, invoice as Invoice)
  const settled = await settleInvoicePayment(supabase, companyId, userId, {
    invoice: invoice as Invoice,
    paymentAmountInInvoiceCurrency: paymentAmount,
    paymentDate,
    accountingMethod,
    entityType,
    settlementAccountNumber,
    paymentSource: 'manual',
  })

  if (!settled.ok) {
    switch (settled.code) {
      case 'BOOKKEEPING_ERROR':
        // As before the shared path: an engine refusal (locked period, an
        // account outside the chart) propagates to the dispatcher.
        throw settled.error
      case 'UPDATE_FAILED':
        return { error: 'Failed to update invoice status', status: 500 }
      case 'INVOICE_PAID_RACE':
        return {
          error: 'Invoice can only be marked as paid from a payable status (sent, overdue or partially paid)',
          status: 409,
        }
      case 'INVOICE_PAID_NOT_PAYABLE':
        return { error: 'Kreditfakturor kan inte markeras som betalda.', status: 409 }
      case 'INVOICE_PAID_BOOK_FAILED':
        if (settled.details.reason === 'payment_row_insert_failed') {
          // Raw driver text stays server-side; the user gets the outcome only.
          log.error('mark_invoice_paid: invoice_payments insert failed', undefined, {
            invoiceId,
            companyId,
            error: settled.details.error,
          })
          return {
            error:
              'Betalningen kunde inte registreras i reskontran. ' +
              'Verifikationen har makulerats och fakturan har inte markerats som betald.',
            status: 500,
          }
        }
        // 422 so the dispatcher records a refusal: nothing was posted.
        return {
          error:
            settled.details.reason === 'no_journal_entry_created'
              ? 'Betalningen kunde inte bokföras (ingen verifikation skapades: t.ex. stängd räkenskapsperiod). ' +
                'Fakturan har inte markerats som betald.'
              : `Betalningen kunde inte bokföras: ${getErrorMessage({ message: String(settled.details.reason ?? '') }, { context: 'invoice' })} ` +
                'Fakturan har inte markerats som betald.',
          status: 422,
        }
      default:
        return {
          error: getErrorEntry(settled.code)?.message_sv ?? settled.code,
          errorCode: settled.code,
          status: getErrorEntry(settled.code)?.httpStatus ?? 400,
        }
    }
  }

  const { newStatus, newRemaining, journalEntryId } = settled
  return { data: { status: newStatus, remaining_amount: newRemaining, journal_entry_id: journalEntryId } }
}

async function commitSendInvoice(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>,
  userEmail?: string
): Promise<ExecutorResult> {
  const invoiceId = params.invoice_id as string

  const emailService = await getEmailService()
  if (!emailService.isConfigured()) {
    return { error: 'Email service not configured', status: 500 }
  }

  const { data: invoice, error: invoiceError } = await supabase
    .from('invoices')
    .select('*, customer:customers(*), items:invoice_items(*)')
    .eq('id', invoiceId)
    .eq('company_id', companyId)
    .single()

  if (invoiceError || !invoice) return { error: 'Invoice not found', status: 404 }
  if (invoice.credited_invoice_id) {
    return {
      error: 'Credit notes must be issued through the invoice send flow',
      status: 409,
    }
  }
  // partially_paid/credited imply the invoice was already issued too: the
  // status flip below would regress them to 'sent' (PR #666 review, ASVS V2.3).
  if (['sent', 'paid', 'overdue', 'partially_paid', 'credited'].includes(invoice.status)) {
    return { error: 'Invoice has already been sent', status: 409 }
  }
  // A cancelled invoice keeps its F-series number for ML 17 kap 24§ compliance
  // but is not a valid faktura: sending it would silently re-activate it (the
  // status flip below has no guard) and deliver a "MAKULERAD" PDF as if live.
  // Mirrors the send route's guard (audit C17, this agent path lacked it).
  if (invoice.status === 'cancelled') {
    return {
      error:
        getErrorEntry('INVOICE_SEND_CANCELLED')?.message_sv ??
        'Makulerade fakturor kan inte skickas. Skapa en ny faktura istället.',
      status: 400,
    }
  }

  // The customer was deleted while the draft pointed at it (crm#263).
  if (invoiceLacksCustomer(invoice)) return customerMissingResult()
  const customer = invoice.customer as Customer
  if (!customer.email?.trim()) return { error: 'Customer has no email address', status: 400 }

  const { data: company, error: companyError } = await supabase
    .from('company_settings').select('*').eq('company_id', companyId).single()

  if (companyError || !company) return { error: 'Company settings missing', status: 500 }

  const paymentAccountRequired = invoiceRequiresPaymentAccount(invoice as Invoice)
  // Freeze the chosen bank account's payee at issue (no-op without a choice).
  const payeeSnapshot = await snapshotInvoicePayee(supabase, companyId, invoice as Invoice)
  if (!payeeSnapshot.ok) {
    return {
      error: getErrorEntry(payeeSnapshot.code)?.message_sv ?? 'Bankkontot på fakturan kan inte längre användas.',
      status: 400,
    }
  }
  ;(invoice as Invoice).payment_details = payeeSnapshot.payee
  if (!hasRequiredInvoicePaymentAccount(company as CompanySettings, invoice as Invoice)) {
    return {
      error: describeMissingInvoicePaymentAccount((invoice as Invoice).currency).sv,
      status: 400,
    }
  }

  if (!hasRequiredSellerVatNumber(company as CompanySettings, invoice as Invoice)) {
    return {
      error:
        getErrorEntry('INVOICE_SEND_VAT_NUMBER_MISSING')?.message_sv
        ?? 'Momsregistreringsnummer saknas i företagsinställningarna.',
      status: 400,
    }
  }

  const recipients = resolveInvoiceEmailRecipients({
    to: customer.email,
    configuredCc: company.invoice_email_cc_addresses,
    configuredBcc: company.invoice_email_bcc_addresses,
    customerCc: customer.invoice_email_cc_addresses,
    customerBcc: customer.invoice_email_bcc_addresses,
  })
  if (exceedsInvoiceEmailRecipientLimit(recipients)) {
    return {
      error:
        getErrorEntry('INVOICE_SEND_TOO_MANY_RECIPIENTS')?.message_sv
        ?? `Ett fakturautskick får inte ha ${invoiceEmailRecipientCount(recipients)} mottagare.`,
      status: 400,
    }
  }

  const items = (invoice.items as InvoiceItem[]).sort(
    (a: InvoiceItem, b: InvoiceItem) => a.sort_order - b.sort_order
  )

  let originalInvoiceNumber: string | undefined
  if (invoice.credited_invoice_id) {
    const { data: orig } = await supabase
      .from('invoices').select('invoice_number').eq('id', invoice.credited_invoice_id).single()
    if (orig) originalInvoiceNumber = orig.invoice_number
  }

  // Preflight render: validate the PDF pipeline BEFORE consuming an F-series
  // number, so a render failure can't leave a numbered-but-never-issued
  // invoice (an F-series gap if the draft is later abandoned). Skipped when
  // the row is already numbered (retry path): we'd render twice for no gain.
  // Mirrors the send route (audit C17, this agent path assigned the number
  // first and rendered unguarded).
  const isFreshAllocation = !invoice.invoice_number
  if (isFreshAllocation) {
    try {
      await renderInvoicePdfBuffer({
        invoice: { ...(invoice as Invoice), invoice_number: 'F-PREVIEW' },
        customer,
        items,
        company: company as CompanySettings,
        originalInvoiceNumber,
        paymentAccountRequired,
      })
    } catch (err) {
      log.error('preflight PDF render failed before invoice number assignment (agent send)', err as Error, {
        companyId,
        userId,
        invoiceId,
      })
      return {
        error:
          getErrorEntry('INVOICE_SEND_PDF_RENDER_FAILED')?.message_sv ??
          'Fakturans PDF kunde inte skapas. Kontrollera fakturarader och kunduppgifter och försök igen.',
        status: 500,
      }
    }
  }

  let deliveryId: string
  try {
    deliveryId = await reserveInvoiceDelivery({
      supabase,
      companyId,
      userId,
      invoiceId,
    })
  } catch (err) {
    log.error('failed to reserve invoice delivery before agent number assignment', err as Error, {
      companyId,
      userId,
      invoiceId,
    })
    return { error: 'Utskicksinformationen kunde inte sparas. Ingen e-post skickades.', status: 500 }
  }

  try {
    await ensureInvoiceNumber(supabase, companyId, invoice as Invoice)
  } catch (err) {
    if (err instanceof InvoiceNumberSeriesBehindError) {
      return { error: err.message, errorCode: err.code, status: 409 }
    }
    return { error: `Failed to assign invoice number: ${err instanceof Error ? err.message : 'unknown'}`, status: 500 }
  }

  // Auto-create an online payment link (extension-provided, e.g. Stripe) now
  // that the number exists, so the email button and PDF QR carry it: the same
  // shared step the dashboard send, the v1 send and the recurring auto-send
  // run. A failure never blocks the send: the faktura is legally valid
  // without a link, so it degrades to a warning, as on the dashboard.
  const { failure: paymentLinkFailure } = await applyPaymentLinkToInvoice(
    supabase,
    companyId,
    userId,
    invoice as Invoice,
    log,
  )
  if (paymentLinkFailure) {
    log.warn('payment link creation failed on agent send', { invoiceId, reason: paymentLinkFailure })
  }

  // Override `status` to 'sent' on the in-memory copy. The DB flip happens
  // when the invoice is issued, right before the email; rendering with the
  // stale 'draft' status would stamp the customer's PDF with "UTKAST".
  const renderableInvoice = { ...(invoice as Invoice), status: 'sent' as const }
  const { buffer: pdfBuffer } = await renderInvoicePdfBuffer({
    invoice: renderableInvoice,
    customer,
    items,
    company: company as CompanySettings,
    originalInvoiceNumber,
    paymentAccountRequired,
  })

  const isCreditNote = !!invoice.credited_invoice_id
  const filename = invoicePdfFilename({
    companyName: company.company_name,
    customerName: customer.name,
    invoiceNumber: invoice.invoice_number,
    invoiceId: invoice.id,
    invoiceDate: invoice.invoice_date,
    documentType: invoice.document_type,
    isCreditNote,
  })

  // Issue BEFORE delivery, fail closed: status sent + the verifikat through
  // the one issue step the dashboard send, mark-sent and the recurring
  // auto-send share. A refused verifikat (a required dimension, an archived
  // dimension value, a locked period) leaves the invoice in draft and sends
  // nothing; the compare-and-set stops a concurrent issuer before it emails.
  const issued = await markInvoiceSentAndBook({
    supabase,
    companyId,
    userId,
    invoice: invoice as IssuableInvoice,
    settings: company as CompanySettings,
    log,
  })
  if (!issued.ok) {
    if (issued.errorCode === 'INVOICE_MARK_SENT_RACE') {
      return { error: 'Invoice has already been sent', status: 409 }
    }
    // The engine's own refusal: the dispatcher maps it with its Swedish text.
    if (isBookkeepingError(issued.bookingError)) throw issued.bookingError
    return {
      error: issued.reason ?? getErrorEntry(issued.errorCode)?.message_sv ?? 'Fakturan kunde inte bokföras.',
      errorCode: issued.errorCode,
      status: getErrorEntry(issued.errorCode)?.httpStatus ?? 500,
    }
  }
  const journalEntryId = issued.journalEntryId
  const isRealInvoice = !invoice.document_type || invoice.document_type === 'invoice'

  // The email did not go out after the invoice was issued. With nothing
  // booked nothing irreversible happened: the draft is restored and the old
  // error returned. A posted verifikat is never undone: the invoice stays
  // issued, finished like mark-sent (PDF archived as underlag), and the op
  // lands in failed_partial carrying the verifikat id.
  const issuedButNotDelivered = async (whenNothingBooked: ExecutorResult): Promise<ExecutorResult> => {
    if (!journalEntryId && (await restoreUnbookedDraft(supabase, companyId, invoiceId, log))) {
      return whenNothingBooked
    }
    if (isRealInvoice) {
      await archiveIssuedInvoicePdf({
        supabase,
        companyId,
        userId,
        invoice: invoice as IssuableInvoice,
        settings: company as CompanySettings,
        journalEntryId,
        log,
      })
    }
    await eventBus.emit({
      type: 'invoice.sent',
      payload: { invoice: { ...(invoice as Invoice), status: 'sent' }, userId, companyId },
    })
    const entry = getErrorEntry('INVOICE_SEND_ISSUED_NOT_DELIVERED')
    return {
      error: entry?.message_sv ?? 'Fakturan är utfärdad men e-postmeddelandet kunde inte skickas.',
      errorCode: 'INVOICE_SEND_ISSUED_NOT_DELIVERED',
      status: entry?.httpStatus ?? 502,
      ...(journalEntryId ? { partialPostedIds: { journal_entry_id: journalEntryId } } : {}),
    }
  }

  const replyTo = resolveInvoiceReplyTo(company as CompanySettings, userEmail)
  const emailData = { invoice: renderableInvoice, customer, company: company as CompanySettings, replyTo }
  const subject = generateInvoiceEmailSubject(emailData)
  const html = generateInvoiceEmailHtml(emailData)
  const text = generateInvoiceEmailText(emailData)
  let result
  try {
    result = await sendTrackedInvoiceEmail({
      supabase,
      emailService,
      companyId,
      userId,
      invoiceId,
      deliveryId,
      to: recipients.to,
      cc: recipients.cc,
      bcc: recipients.bcc,
      subject,
      html,
      text,
      replyTo,
      fromName: company.company_name,
      from: await resolveInvoiceSender(supabase, companyId, company.company_name),
      filename,
      pdfBuffer,
    })
  } catch (err) {
    log.error('failed to persist invoice delivery snapshot before agent send', err as Error, {
      companyId,
      userId,
      invoiceId,
    })
    return issuedButNotDelivered({
      error: 'Utskicksinformationen kunde inte sparas. Ingen e-post skickades.',
      status: 500,
    })
  }

  if (result.trackingWarning) {
    log.warn('agent invoice delivery snapshot requires reconciliation', {
      companyId,
      userId,
      invoiceId,
      deliveryId: result.deliveryId,
      warning: result.trackingWarning,
    })
  }

  if (!result.success) {
    return issuedButNotDelivered({ error: `Failed to send email: ${result.error}`, status: 500 })
  }

  if (isRealInvoice && journalEntryId) {
    try {
      await linkToJournalEntry(supabase, companyId, result.documentId, journalEntryId)
    } catch { /* non-blocking */ }
  }

  await eventBus.emit({
    type: 'invoice.sent',
    payload: { invoice: { ...(invoice as Invoice), status: 'sent' }, userId, companyId },
  })

  const warnings = [
    // The raw provider/DB reason is logged above; the agent-facing text stays Swedish.
    ...(paymentLinkFailure
      ? ['Betalningslänken kunde inte skapas. Fakturan skickades utan betalningslänk.']
      : []),
    ...(result.trackingWarning ? ['Delivery history requires reconciliation.'] : []),
    ...issued.partialFailures.map((failure) => failure.reason),
  ]
  return {
    data: {
      message: `Invoice ${invoice.invoice_number} sent to ${customer.email}`,
      ...(warnings.length > 0 ? { warning: warnings.join(' ') } : {}),
    },
  }
}

async function commitMarkInvoiceSent(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const invoiceId = params.invoice_id as string

  const { data: invoice, error: invoiceError } = await supabase
    .from('invoices')
    .select('*, customer:customers(*), items:invoice_items(*)')
    .eq('id', invoiceId)
    .eq('company_id', companyId)
    .single()

  if (invoiceError || !invoice) return { error: 'Invoice not found', status: 404 }
  if (invoice.credited_invoice_id) {
    return {
      error: 'Credit notes must be issued through the invoice send flow',
      status: 409,
    }
  }
  if (invoice.status !== 'draft') return { error: 'Only draft invoices can be marked as sent', status: 409 }
  // Before the number below is taken (crm#263): the draft stays deletable.
  if (invoiceLacksCustomer(invoice)) return customerMissingResult()

  // In full: the PDF archived as underlag renders from the company settings.
  const { data: settings, error: settingsError } = await supabase
    .from('company_settings')
    .select('*')
    .eq('company_id', companyId)
    .single()

  if (settingsError || !settings) return { error: 'Company settings missing', status: 500 }

  // The dashboard's issue step (issueAndBookInvoice): payee frozen, payment-
  // account and VAT-number guards, the number, status sent + the verifikat
  // (fail closed: a refused verifikat, such as a required dimension, an
  // archived dimension value or a locked period, leaves the invoice in draft),
  // then the PDF archived as underlag, the manual delivery recorded and
  // invoice.sent emitted.
  const issued = await issueAndBookInvoice({
    supabase,
    companyId,
    userId,
    invoice: invoice as IssuableInvoice,
    settings: settings as CompanySettings,
    log,
  })
  if (!issued.ok) {
    switch (issued.errorCode) {
      case 'INVOICE_CUSTOMER_MISSING':
        return customerMissingResult()
      case 'INVOICE_SEND_PAYMENT_ACCOUNT_MISSING':
        return { error: describeMissingInvoicePaymentAccount((invoice as Invoice).currency).sv, status: 400 }
      case 'INVOICE_SEND_VAT_NUMBER_MISSING':
        return {
          error:
            getErrorEntry('INVOICE_SEND_VAT_NUMBER_MISSING')?.message_sv
            ?? 'Momsregistreringsnummer saknas i företagsinställningarna.',
          status: 400,
        }
      case 'INVOICE_NUMBER_SERIES_BEHIND':
        return {
          error: issued.messageSv ?? getErrorEntry(issued.errorCode)?.message_sv ?? issued.errorCode,
          errorCode: issued.errorCode,
          status: 409,
        }
      case 'INVOICE_CREATE_NUMBER_ASSIGN_FAILED':
        return { error: 'Failed to assign invoice number', status: 500 }
      case 'INVOICE_MARK_SENT_RACE':
        return { error: 'Only draft invoices can be marked as sent', status: 409 }
      case 'INVOICE_MARK_SENT_STATUS_FAILED':
        return { error: 'Failed to update invoice status', status: 500 }
      case 'INVOICE_MARK_SENT_BOOK_FAILED':
        // The engine's own refusal: the dispatcher maps it with its Swedish text.
        if (isBookkeepingError(issued.bookingError)) throw issued.bookingError
        return {
          error: issued.reason ?? getErrorEntry(issued.errorCode)?.message_sv ?? 'Fakturan kunde inte bokföras.',
          errorCode: issued.errorCode,
          status: getErrorEntry(issued.errorCode)?.httpStatus ?? 500,
        }
      default: {
        // A payee that can no longer be used, a repair-required link, and
        // the other registered refusals.
        const entry = getErrorEntry(issued.errorCode)
        return {
          error: issued.messageSv ?? entry?.message_sv ?? issued.errorCode,
          errorCode: issued.errorCode,
          status: entry?.httpStatus ?? 400,
        }
      }
    }
  }

  const warnings = issued.partialFailures.map((failure) => failure.reason)
  return {
    data: {
      status: 'sent',
      journal_entry_id: issued.journalEntryId,
      ...(warnings.length > 0 ? { warning: warnings.join(' ') } : {}),
    },
  }
}

async function commitMatchTransactionInvoice(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const transactionId = params.transaction_id as string
  const invoiceId = params.invoice_id as string

  const { data: transaction, error: txError } = await supabase
    .from('transactions').select('*').eq('id', transactionId).eq('company_id', companyId).single()

  if (txError || !transaction) return { error: 'Transaction not found', status: 404 }
  if (transaction.amount <= 0) return { error: 'Only income transactions can be matched', status: 400 }
  if (transaction.invoice_id) return { error: 'Transaction already linked to an invoice', status: 409 }

  const { data: invoice, error: invError } = await supabase
    .from('invoices')
    .select('*, customer:customers(*), items:invoice_items(*)')
    .eq('id', invoiceId)
    .eq('company_id', companyId)
    .single()

  if (invError || !invoice) return { error: 'Invoice not found', status: 404 }
  if (invoice.credited_invoice_id) {
    return { error: 'Kreditfakturor kan inte registreras som betalda.', status: 409 }
  }
  // Parity with the dashboard match route (MATCH_INVOICE_NOT_INVOICE_TYPE):
  // proformas, delivery notes and quotes carry no receivable to settle.
  if (invoice.document_type && invoice.document_type !== 'invoice') {
    const entry = getErrorEntry('MATCH_INVOICE_NOT_INVOICE_TYPE')
    return {
      error: entry?.message_sv ?? 'Only invoices can be matched to a transaction.',
      errorCode: 'MATCH_INVOICE_NOT_INVOICE_TYPE',
      // 409 like the credit-note guard above: the dispatcher records it as
      // rejected (a state refusal), not failed (an execution error).
      status: 409,
    }
  }
  if (!isMatchableInvoiceStatus(invoice.status)) {
    return { error: 'Invoice is not in a matchable state', status: 409 }
  }

  // Soft-duplicate guard: parity with the dashboard and v1 match routes
  // (MATCH_INVOICE_POSSIBLE_DUPLICATE), which this path bypassed. A manual
  // verifikation that already books this receipt means the approved match
  // would double-book it. Runs BEFORE the irreversible storno below, and
  // re-binds force to the candidate detected NOW: an approval staged before
  // the manual voucher was posted cannot slip through (issue #2294).
  const duplicate = await guardDuplicatePaymentVoucher(
    supabase,
    companyId,
    transaction,
    {
      force: params.force === true,
      expected_journal_entry_id:
        typeof params.expected_journal_entry_id === 'string' ? params.expected_journal_entry_id : undefined,
    },
    { onDetectError: (err) => log.warn('match_transaction_invoice: duplicate detection failed (continuing)', err) },
  )
  if (duplicate.status === 'blocked') {
    const entry = getErrorEntry('MATCH_INVOICE_POSSIBLE_DUPLICATE')
    return {
      error: `${entry?.message_sv ?? 'Det finns redan en bokförd verifikation på samma belopp och datum.'} (verifikat ${duplicate.candidate.voucher_label}, ${duplicate.candidate.entry_date})`,
      errorCode: 'MATCH_INVOICE_POSSIBLE_DUPLICATE',
      status: 409,
      data: { candidate: duplicate.candidate },
    }
  }
  if (duplicate.status === 'mismatch') {
    const entry = getErrorEntry('MATCH_INVOICE_FORCE_CANDIDATE_MISMATCH')
    return {
      error: entry?.message_sv ?? 'Verifikationen som dubblettkontrollen visade matchar inte längre.',
      errorCode: 'MATCH_INVOICE_FORCE_CANDIDATE_MISMATCH',
      status: 409,
      data: {
        expected_journal_entry_id: duplicate.expected_journal_entry_id,
        detected_journal_entry_id: duplicate.detected_journal_entry_id,
      },
    }
  }

  // FX resolution (paidAmount in the INVOICE's currency) + overshoot guard +
  // paid/remaining math, through the one helper the staging tools run too, so
  // a match refused here is refused when it is staged (crm#253). This agent
  // path previously had NO overshoot guard, so a 1500 payment on a 1000
  // invoice was silently accepted (paid_amount > total, AR over-credited).
  // Runs BEFORE the storno + JE below, so a rejected match leaves the
  // transaction untouched and never burns a voucher number.
  // overpayment_account: where the user chose to book an excess of a krona
  // or more (2420, or 3740 under its cap). The plan re-checks it against the
  // amounts as they are now, and the builders book exactly what it allows.
  const matchPlan = await planTransactionInvoiceMatch(supabase, transaction, invoice, {
    overpaymentAccount: typeof params.overpayment_account === 'string' ? params.overpayment_account : undefined,
  })
  if (!matchPlan.ok) {
    return {
      error: getErrorEntry(matchPlan.code)?.message_sv ?? matchPlan.code,
      errorCode: matchPlan.code,
      status: 400,
      // The amounts the stage-time refusal names, so an op staged before that
      // guard (or whose invoice changed since) is just as actionable here.
      ...(matchPlan.code === 'MATCH_AMOUNT_EXCEEDS_REMAINING' || matchPlan.code === 'MATCH_OVERPAYMENT_ROUNDING_CAP'
        ? { data: { currency: matchPlan.currency, ...matchPlan.details } }
        : {}),
    }
  }
  // The approver saw one excess amount: book that one or nothing. A payment
  // applied to the invoice since staging would otherwise grow the excess
  // booked on 2420 past what was approved.
  if (
    matchPlan.overpayment &&
    roundOre(Number(params.overpayment_amount)) !== matchPlan.overpayment.amount
  ) {
    return {
      error:
        getErrorEntry('MATCH_OVERPAYMENT_CHANGED')?.message_sv ??
        'Fakturans återstående belopp har ändrats sedan matchningen förbereddes.',
      errorCode: 'MATCH_OVERPAYMENT_CHANGED',
      status: 409,
      data: { staged_excess: params.overpayment_amount ?? null, current_excess: matchPlan.overpayment.amount },
    }
  }
  const { fx } = matchPlan
  const overpaymentAccount = matchPlan.overpayment?.account
  const { newPaidAmount, newRemaining, isFullyPaid, newStatus } = matchPlan.plan
  const paidAt = isFullyPaid ? paidAtFromDate(transaction.date) : null

  // Read-only prevalidation, deliberately hoisted ABOVE the irreversible
  // storno below (issue #842): resolveSettlementAccount can throw
  // (BookkeepingDatabaseError on a failed cash_accounts lookup), and a throw
  // here must reject the op with NOTHING posted. Behavior-preserving on the
  // happy path: these are pure reads.
  const { accountingMethod, entityType } = await loadBookingContext(supabase, companyId)

  // Route on invoice state, not the company's current setting. Mirror of
  // the match-invoice route fix: see that handler for the full rationale.
  const invoiceAlreadyBooked = !!(invoice as { journal_entry_id?: string | null }).journal_entry_id
  const useCashEntry = !invoiceAlreadyBooked && accountingMethod === 'cash' && isFullyPaid

  // Reject cash-method partials and part-paid completions on never-booked
  // invoices BEFORE the irreversible storno below. The old fallback booked an
  // accrual-style clearing entry against an EMPTY 1510 (negative receivable,
  // no revenue, no moms: bokslutsmetoden reports moms at payment, per
  // installment), and the cash builder books the FULL invoice, so
  // neither shape is bookable here. Mirrors the dashboard and v1 match routes.
  const cashBlock = cashPartialBlockReason({
    invoiceAlreadyBooked,
    accountingMethod,
    priorPaidAmount: (invoice as { paid_amount?: number | null }).paid_amount,
    paysRemainingInFull: isFullyPaid,
  })
  if (cashBlock) {
    return {
      error:
        getErrorEntry('INVOICE_PAID_CASH_PARTIAL_UNSUPPORTED')?.message_sv ??
        'Kontantmetoden kan inte bokföra delbetalningar av en obokförd faktura automatiskt.',
      status: 400,
    }
  }

  // Debit the cash account THIS transaction actually belongs to, never a
  // hardcoded 1930: cash_account_id -> cash_accounts.ledger_account is the
  // only source of truth for which bank/cash account a real, matched
  // transaction settled into. Mirrors the match-invoice route fix.
  const paymentAccount = await resolveSettlementAccount(supabase, companyId, transaction.cash_account_id, log)

  // A payment date outside an open period leaves the entry builders below with
  // nothing to book, and the invoice used to be marked paid with no verifikat.
  // Refuse here, before the irreversible storno, as the match routes do.
  const fiscalPeriodId = await findFiscalPeriod(supabase, companyId, transaction.date)
  if (!fiscalPeriodId) {
    return {
      error:
        getErrorEntry('INVOICE_PAID_NO_FISCAL_PERIOD')?.message_sv ??
        'Ingen öppen räkenskapsperiod för betalningsdatumet.',
      status: 400,
    }
  }

  // From here on the executor posts irreversible vouchers. Track their ids so
  // a later failure can land the op in 'failed_partial' carrying them
  // (issue #842) instead of a clean-looking 'rejected'.
  const postedIds: Record<string, string> = {}

  if (transaction.journal_entry_id) {
    const reversal = await reverseEntry(supabase, companyId, userId, transaction.journal_entry_id)
    postedIds.reversal_journal_entry_id = reversal.id
    await supabase.from('transactions').update({ journal_entry_id: null }).eq('id', transactionId)
  }

  let journalEntryId: string | null = null
  try {
    if (useCashEntry) {
      const je = await createInvoiceCashEntry(
        supabase, companyId, userId, invoice as Invoice, transaction.date, entityType, invoice.customer?.name,
        paymentAccount, transaction, overpaymentAccount,
      )
      journalEntryId = je?.id ?? null
    } else {
      // Clearing entry against 1510, built by the SAME shared helper the
      // dashboard and v1 routes use, so all three produce byte-identical
      // lines: bank leg = the actual SEK that hit the account, 1510 credited
      // at the invoice's booking rate, and a 3960/7960 FX-diff line (or a
      // 3740 öresavrundning line on pure SEK) making the verifikat balance.
      // The old createInvoicePaymentJournalEntry(paidAmount) shape could not
      // carry either residual, so öre-settled and cross-currency matches
      // left 1510 unclean. The open period was checked before the storno.
      // The invoice's dimension bag rides every leg, FX result lines included
      // (the builder stamps it), exactly as the match routes book it.
      const { description, lines: clearingLines } = buildInvoiceMatchClearingLines(
        {
          amount: transaction.amount,
          amount_sek: transaction.amount_sek ?? null,
          currency: transaction.currency,
          exchange_rate: transaction.exchange_rate ?? null,
        },
        {
          currency: invoice.currency,
          exchange_rate: invoice.exchange_rate ?? null,
          remaining_amount: invoice.remaining_amount ?? null,
          total: invoice.total,
          paid_amount: invoice.paid_amount ?? null,
          invoice_number: invoice.invoice_number,
          customer: invoice.customer,
          default_dimensions: (invoice as { default_dimensions?: unknown }).default_dimensions,
        },
        fx.required ? fx.paidInInvoiceCurrency : undefined,
        paymentAccount,
        overpaymentAccount,
      )
      const je = await createJournalEntry(supabase, companyId, userId, {
        fiscal_period_id: fiscalPeriodId,
        entry_date: transaction.date,
        description,
        source_type: 'invoice_paid',
        source_id: invoice.id,
        bank_booking_context: [bankBookingContext(transaction, paymentAccount)],
        lines: clearingLines,
      })
      journalEntryId = je?.id ?? null
    }
  } catch (err) {
    // Recoverable: the dispatcher releases the op back to 'pending' and this
    // executor is re-entrant past the storno (the transaction was unlinked
    // above, so a retry does not post a second storno). Keep that path even
    // when a reversal voucher was already posted.
    if (err instanceof AccountsNotInChartError) throw err
    if (isBookkeepingError(err)) {
      // A reversal voucher already posted makes this a partial commit, not a
      // clean failure: surface the storno id (issue #842).
      if (Object.keys(postedIds).length > 0) {
        throw new PartialCommitError(
          `match_transaction_invoice failed after posting a reversal voucher: ${err instanceof Error ? err.message : 'journal entry creation failed'}`,
          postedIds,
          err,
        )
      }
      throw err
    }
    log.error('Failed to create match journal entry:', err)
  }
  // Fail closed, as the match routes do: the invoice is never marked paid
  // without its payment verifikat. A storno posted above is reported as a
  // partial commit rather than hidden behind a clean-looking refusal.
  if (!journalEntryId) {
    return {
      error:
        getErrorEntry('MATCH_INVOICE_RECORD_PAYMENT_FAILED')?.message_sv ??
        'Kunde inte registrera fakturabetalningen.',
      status: 500,
      ...(Object.keys(postedIds).length > 0 ? { partialPostedIds: postedIds } : {}),
    }
  }
  postedIds.payment_journal_entry_id = journalEntryId

  const { data: updatedRows, error: updateInvError } = await supabase
    .from('invoices')
    .update({
      status: newStatus,
      paid_at: paidAt,
      paid_amount: newPaidAmount,
      remaining_amount: newRemaining,
    })
    .eq('id', invoiceId)
    .in('status', [...MATCHABLE_INVOICE_STATUSES])
    .select('id')

  if (updateInvError) {
    return {
      error: 'Failed to update invoice status',
      status: 500,
      ...(Object.keys(postedIds).length > 0 ? { partialPostedIds: postedIds } : {}),
    }
  }
  if (!updatedRows || updatedRows.length === 0) {
    return {
      error: 'Invoice has already been fully paid or is no longer matchable',
      status: 409,
      ...(Object.keys(postedIds).length > 0 ? { partialPostedIds: postedIds } : {}),
    }
  }

  // No cash-method note here anymore: pure kontantmetoden partials are now
  // rejected above, and for an invoice booked at send the clearing entry
  // handles a partial correctly, so the note would be misleading.
  // The AR sub-ledger row goes through the single writer
  // (lib/invoices/invoice-payment-row.ts), which owns the amount definition:
  // applied to the invoice, never the cash received (#2250). Not fatal here,
  // exactly like the fire-and-forget insert it replaces: the voucher and the
  // invoice update are already committed. The failure is logged now, so the
  // row the kontantmetod cut-off would otherwise miss can be added.
  const recorded = await recordInvoicePaymentRow(supabase, {
    userId,
    companyId,
    invoice: {
      id: invoiceId,
      currency: invoice.currency,
      exchange_rate: invoice.exchange_rate,
      paid_amount: invoice.paid_amount,
    },
    paymentDate: transaction.date,
    newPaidAmount,
    journalEntryId,
    transactionId,
    exchangeRate: fx.required ? fx.rate : invoice.exchange_rate,
    source: 'bank',
  })
  if (!recorded.ok) {
    log.error('match_transaction_invoice: invoice_payments insert failed', undefined, {
      invoiceId,
      transactionId,
      companyId,
      error: recorded.error,
    })
  }

  // The override was acted on: durable behandlingshistorik record (BFNAR
  // 2013:2 p. 9.16), same event the categorize guard writes.
  if (duplicate.status === 'overridden') {
    await recordDuplicateCandidateOverride(
      companyId,
      transactionId,
      duplicate.candidate,
      { actor: { type: 'user', id: userId }, via: 'pending_operation_force' },
      (err) => log.warn('match_transaction_invoice: failed to record override behandlingshistorik', err),
    )
  }

  // The invoice is now settled, so every OTHER transaction still carrying a
  // suggestion pointer at it is dead: retire them (issue #1259). This
  // operation's own row is cleared by the update just below.
  if (isFullyPaid) {
    await clearSettledInvoiceSuggestions(supabase, companyId, 'invoice', invoiceId, {
      exceptTransactionId: transactionId,
    })
  }

  await supabase
    .from('transactions')
    .update({
      invoice_id: invoiceId,
      potential_invoice_id: null,
      journal_entry_id: journalEntryId,
      is_business: true,
      category: 'income_services',
    })
    .eq('id', transactionId)

  const settledInvoice = {
    ...(invoice as Invoice),
    status: newStatus,
    paid_at: paidAt,
    paid_amount: newPaidAmount,
    remaining_amount: newRemaining,
  } as Invoice
  try {
    await eventBus.emit({
      type: 'invoice.match_confirmed',
      payload: {
        invoice: settledInvoice,
        transaction: {
          ...(transaction as Transaction),
          invoice_id: invoiceId,
          potential_invoice_id: null,
          journal_entry_id: journalEntryId,
          is_business: true,
          category: 'income_services',
        } as Transaction,
        userId,
        companyId,
      },
    })
  } catch { /* non-critical */ }
  // A match that settles the invoice in full is its invoice.paid transition,
  // exactly as on the dashboard and v1 match routes.
  await emitInvoicePaidIfSettled({
    newStatus,
    invoice: settledInvoice,
    paymentAmount: roundOre(newPaidAmount - (invoice.paid_amount ?? 0)),
    paymentDate: transaction.date,
    userId,
    companyId,
  })

  return {
    data: {
      invoice_status: newStatus,
      paid_amount: newPaidAmount,
      journal_entry_id: journalEntryId,
      ...(matchPlan.overpayment ? { overpayment: matchPlan.overpayment } : {}),
    },
  }
}

type VoucherLinkOutcome =
  | { ok: true; result: LinkInvoiceToVoucherResult | LinkSupplierInvoiceToVoucherResult }
  | { ok: false; code: string }

/**
 * Map a voucher-link outcome (customer or supplier invoice) to the executor
 * result. 404/409 are auto-rejected by the dispatcher (the user can re-stage
 * with adjusted inputs); 400 surfaces as a normal failure so the UI can
 * explain what went wrong.
 */
function voucherLinkOutcomeToResult(outcome: VoucherLinkOutcome): ExecutorResult {
  if (!outcome.ok) {
    const entry = getErrorEntry(outcome.code)
    return {
      error: entry?.message_en ?? outcome.code,
      status: entry?.httpStatus ?? 500,
    }
  }

  return {
    data: {
      invoice_status: outcome.result.invoiceStatus,
      paid_amount: outcome.result.paidAmount,
      remaining_amount: outcome.result.remainingAmount,
      payment_amount: outcome.result.paymentAmount,
      payment_id: outcome.result.paymentId,
      journal_entry_id: outcome.result.journalEntryId,
      reconciled_transaction_id: outcome.result.reconciledTransactionId,
    },
  }
}

async function commitLinkInvoiceVoucher(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const invoiceId = params.invoice_id as string | undefined
  const journalEntryId = params.journal_entry_id as string | undefined
  const notes = (params.notes as string | undefined) ?? undefined

  if (!invoiceId || !journalEntryId) {
    return { error: 'invoice_id and journal_entry_id are required', status: 400 }
  }

  // Only a faktura carries a receivable to settle (parity with the dashboard
  // link route and the match executors); the RPC validates status only.
  const { data: docRow } = await supabase
    .from('invoices')
    .select('document_type')
    .eq('id', invoiceId)
    .eq('company_id', companyId)
    .maybeSingle()
  const docType = (docRow as { document_type?: string | null } | null)?.document_type
  if (docType && docType !== 'invoice') {
    const entry = getErrorEntry('MATCH_INVOICE_NOT_INVOICE_TYPE')
    return {
      error: entry?.message_sv ?? 'Only invoices can be linked to a payment voucher.',
      errorCode: 'MATCH_INVOICE_NOT_INVOICE_TYPE',
      status: 409,
    }
  }

  const outcome = await linkInvoiceToVoucher(supabase, userId, companyId, {
    invoiceId,
    journalEntryId,
    notes,
  })

  return voucherLinkOutcomeToResult(outcome)
}

async function commitLinkSupplierInvoiceVoucher(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const supplierInvoiceId = params.supplier_invoice_id as string | undefined
  const journalEntryId = params.journal_entry_id as string | undefined
  const notes = (params.notes as string | undefined) ?? undefined

  if (!supplierInvoiceId || !journalEntryId) {
    return { error: 'supplier_invoice_id and journal_entry_id are required', status: 400 }
  }
  // The staged share of the verifikat. A value that is not a number is refused
  // here: read as "no share stated" it would settle another amount than the
  // one the approver was shown.
  if (params.amount != null && typeof params.amount !== 'number') {
    return { error: 'amount must be a number', status: 400 }
  }
  const amount = (params.amount as number | null | undefined) ?? undefined

  const outcome = await linkSupplierInvoiceToVoucher(supabase, userId, companyId, {
    supplierInvoiceId,
    journalEntryId,
    notes,
    amount,
  })

  return voucherLinkOutcomeToResult(outcome)
}

// ── Stream 1 Phase 1 + follow-up executors ───────────────────────

/**
 * Close / lock / unlock share one shape: require fiscal_period_id, run the
 * period-service transition, answer with the period id plus the timestamp
 * the transition set (closed_at or locked_at), and turn any throw into a
 * 400 with the service's message.
 */
async function runPeriodTransition(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>,
  transition: (supabase: SupabaseClient, companyId: string, userId: string, id: string) => Promise<FiscalPeriod>,
  timestampKey: 'closed_at' | 'locked_at',
  fallback: string
): Promise<ExecutorResult> {
  const id = params.fiscal_period_id as string
  if (!id) return { error: 'fiscal_period_id is required', status: 400 }
  try {
    const period = await transition(supabase, companyId, userId, id)
    return { data: { period_id: period.id, [timestampKey]: period[timestampKey] } }
  } catch (err) {
    // period-service's refusals carry their codes (an SIE import still holding
    // the year, a period that is not locked yet), so the approval answers the
    // same code as the dashboard and v1 instead of UNKNOWN_ERROR.
    const classified = classifyError(err).code
    const code = classified === 'UNKNOWN_ERROR' ? null : classified
    return {
      error: err instanceof Error ? err.message : fallback,
      status: code ? (getErrorEntry(code)?.httpStatus ?? 400) : 400,
      ...(code ? { errorCode: code } : {}),
    }
  }
}

async function commitClosePeriod(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  return runPeriodTransition(supabase, userId, companyId, params, closePeriod, 'closed_at', 'Close failed')
}

async function commitLockPeriod(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  return runPeriodTransition(supabase, userId, companyId, params, lockPeriod, 'locked_at', 'Lock failed')
}

async function commitUncategorizeTransaction(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const txId = params.transaction_id as string
  const journalEntryId = params.journal_entry_id as string
  if (!txId || !journalEntryId) return { error: 'transaction_id and journal_entry_id are required', status: 400 }

  try {
    await reverseEntry(supabase, companyId, userId, journalEntryId)
  } catch (err) {
    return failUnlessBookkeepingError(err, 'Reversal failed', 500)
  }

  const { error: updateError } = await supabase
    .from('transactions')
    .update({ is_business: null, category: null, journal_entry_id: null })
    .eq('id', txId)
    .eq('company_id', companyId)

  if (updateError) return { error: 'Failed to reset transaction', status: 500 }

  return { data: { transaction_id: txId, reversed_journal_entry_id: journalEntryId } }
}

/**
 * A refusal of the shared link rules (lib/documents/link-document.ts), in the
 * Swedish the Granskning panel shows. Both link executors use it, and the
 * rules themselves are the ones v1 and the dashboard run: a bulk call is
 * exactly N single calls, and no executor keeps a copy of a legally motivated
 * guard that silently stays behind when the shared one is hardened.
 */
function documentLinkRefusalResult(refusal: LinkDocumentRefusal): { error: string; status: number; errorCode: string } {
  switch (refusal.code) {
    case 'DOC_LINK_ALREADY_LINKED':
      return {
        error: refusal.details.line_change
          ? 'Bilagan är redan kopplad till en rad på verifikationen och kopplingen kan inte ändras (BFL 5 kap 6 §).'
          : documentHeldElsewhereReasonSv(refusal.details.holder),
        status: 409,
        errorCode: refusal.code,
      }
    case 'PERIOD_LOCKED':
      return { error: 'Verifikationens period är låst: bilagan kan inte länkas.', status: 409, errorCode: refusal.code }
    case 'NOT_FOUND':
      return {
        error:
          refusal.details.resource === 'document'
            ? 'Bilagan hittades inte.'
            : refusal.details.resource === 'journal_entry'
              ? 'Verifikationen hittades inte.'
              : 'Raden finns inte på verifikationen.',
        status: 404,
        errorCode: refusal.code,
      }
  }
}

/** The immutability trigger refused the write, typed by linkToJournalEntry or raw. */
function isDocumentLinkConflict(err: unknown): boolean {
  if (err instanceof DocumentAlreadyLinkedError) return true
  return isDocumentImmutabilityRefusal(err instanceof Error ? err.message : String(err ?? ''))
}

/**
 * Shared failure mapping for both link executors. A locked period is the one
 * case worth its own sentence: it is recoverable by unlocking, unlike the rest,
 * and the raw trigger text is English database prose. Everything else goes
 * through getErrorMessage so nothing reaches the Granskning panel untranslated.
 */
function documentLinkFailureMessage(err: unknown): string {
  if (isPeriodLockRefusal(err)) {
    return 'Verifikationens period är låst: bilagan kan inte länkas.'
  }
  // The precheck names the holder; this is the race it cannot see (a link
  // set between the precheck and the write) or a line-level link that would
  // change. Both are the immutability trigger refusing, never a server fault.
  if (isDocumentLinkConflict(err)) {
    return 'Bilagan är redan kopplad till en verifikation och kopplingen kan inte ändras (BFL 5 kap 6 §).'
  }
  // No ErrorContext value covers document attachments, and journal_entry would
  // phrase the fallback as a verifikat problem when the failure is the link.
  // Omitting it keeps the generic Swedish fallback, which is accurate here.
  return getErrorMessage(err)
}

async function commitLinkDocumentToVoucher(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const documentId = params.document_id as string
  const journalEntryId = params.journal_entry_id as string
  const journalEntryLineId = params.journal_entry_line_id as string | undefined
  if (!documentId || !journalEntryId) {
    return { error: 'document_id and journal_entry_id are required', status: 400 }
  }

  try {
    // Staged as a copy (crm#1171 item 9): staging saw the document held by,
    // or proposed for, another verifikat, so this one gets a byte-identical
    // copy whatever is approved first. The document itself never moves.
    if (params.copy === true) {
      const copied = await linkDocumentCopyToVoucher(supabase, companyId, userId, {
        document_id: documentId,
        journal_entry_id: journalEntryId,
        journal_entry_line_id: journalEntryLineId ?? null,
      })
      if (!copied.ok) return documentLinkRefusalResult(copied)
      return {
        data: {
          document_id: copied.document.id,
          file_name: copied.document.file_name,
          journal_entry_id: copied.document.journal_entry_id,
          journal_entry_line_id: copied.document.journal_entry_line_id ?? null,
          copy_of_document_id: documentId,
        },
      }
    }
    const outcome = await linkDocumentToVoucher(
      supabase,
      companyId,
      { document_id: documentId, journal_entry_id: journalEntryId, journal_entry_line_id: journalEntryLineId ?? null },
      { expectInboxItem: true },
    )
    if (!outcome.ok) return documentLinkRefusalResult(outcome)
    if (outcome.dryRun) throw new Error('link_document_to_voucher: unexpected dry-run outcome')
    const updated = outcome.document
    return {
      data: {
        document_id: updated.id,
        file_name: updated.file_name,
        journal_entry_id: updated.journal_entry_id,
        journal_entry_line_id: updated.journal_entry_line_id ?? null,
      },
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err ?? '')
    const isLocked = /locked\/closed fiscal period|Bokföringen är låst/i.test(msg)
    const status = isLocked || isDocumentLinkConflict(err) ? 409 : 500
    return { error: documentLinkFailureMessage(err), status }
  }
}

async function commitLinkDocumentsToVouchers(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const links = params.links as Array<{
    document_id: string; journal_entry_id: string; journal_entry_line_id: string | null
    /** Link a byte-identical copy; the document itself stays where it is (crm#1207). */
    copy?: boolean
  }> | undefined
  if (!Array.isArray(links) || links.length === 0) {
    return { error: 'links is required (non-empty)', status: 400 }
  }

  const linked: Array<{ document_id: string; journal_entry_id: string; copy_of_document_id?: string }> = []
  const skipped: Array<{ document_id: string; journal_entry_id: string; reason: string }> = []

  // Sequential, not Promise.all: each row re-validates against the current DB
  // state (a prior row in the SAME batch can change a doc's journal_entry_id,
  // and the WORM guard must see that), and goes through the SAME
  // linkDocumentToVoucher as the single-document executor, so a bulk call
  // enforces identical invariants to N individual calls rather than a
  // parallel reimplementation of them.
  for (const link of links) {
    const documentId = link.document_id
    const journalEntryId = link.journal_entry_id
    if (!documentId || !journalEntryId) {
      skipped.push({ document_id: documentId ?? '(saknas)', journal_entry_id: journalEntryId ?? '(saknas)', reason: 'Raden saknar dokument-id eller verifikations-id.' })
      continue
    }

    try {
      if (link.copy === true) {
        const copied = await linkDocumentCopyToVoucher(supabase, companyId, userId, {
          document_id: documentId,
          journal_entry_id: journalEntryId,
          journal_entry_line_id: link.journal_entry_line_id ?? null,
        })
        if (!copied.ok) {
          skipped.push({ document_id: documentId, journal_entry_id: journalEntryId, reason: documentLinkRefusalResult(copied).error })
          continue
        }
        linked.push({ document_id: copied.document.id, journal_entry_id: journalEntryId, copy_of_document_id: documentId })
        continue
      }
      const outcome = await linkDocumentToVoucher(
        supabase,
        companyId,
        { document_id: documentId, journal_entry_id: journalEntryId, journal_entry_line_id: link.journal_entry_line_id ?? null },
        { expectInboxItem: true },
      )
      if (!outcome.ok) {
        skipped.push({ document_id: documentId, journal_entry_id: journalEntryId, reason: documentLinkRefusalResult(outcome).error })
        continue
      }
      if (outcome.dryRun) throw new Error('link_documents_to_vouchers: unexpected dry-run outcome')
      const updated = outcome.document
      linked.push({ document_id: updated.id, journal_entry_id: updated.journal_entry_id as string })
    } catch (err) {
      // Same mapping as the single executor, including its locked-period
      // sentence: skipped reasons land in result_data and are rendered in the
      // Granskning panel, so none of them may reach the user as raw English
      // database prose.
      skipped.push({ document_id: documentId, journal_entry_id: journalEntryId, reason: documentLinkFailureMessage(err) })
    }
  }

  // Nothing linked is a failure, not a partial success. Recording it as
  // `committed` would leave an approval-gated operation on
  // räkenskapsinformation sitting in the audit trail asserting a run that
  // changed nothing, and the single-document executor returns 409 for exactly
  // these conditions (locked period, WORM guard, missing document). A batch
  // must not be the weaker path.
  if (linked.length === 0) {
    return {
      error: `Inga bilagor kunde länkas (${skipped.length} hoppades över). Första orsak: ${skipped[0]?.reason ?? 'okänd'}`,
      status: 409,
    }
  }

  log.info('link_documents_to_vouchers committed', {
    companyId,
    operationType: 'link_documents_to_vouchers',
    requested: links.length,
    linkedCount: linked.length,
    skippedCount: skipped.length,
  })

  return {
    data: {
      linked_count: linked.length,
      skipped_count: skipped.length,
      linked,
      skipped,
    },
  }
}

async function commitRunYearEnd(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const id = params.fiscal_period_id as string
  if (!id) return { error: 'fiscal_period_id is required', status: 400 }

  try {
    const result = await executeYearEndClosing(supabase, companyId, userId, id)
    return {
      data: {
        closing_entry_id: result.closingEntry?.id ?? null,
        next_period_id: result.nextPeriod?.id ?? null,
        opening_balance_entry_id: result.openingBalanceEntry?.id ?? null,
      },
    }
  } catch (err) {
    return failUnlessBookkeepingError(err, 'Year-end failed', 400)
  }
}

// Unreachable while isKontantmetodCutoffSuspended() is true (#3440): the
// dispatcher refuses post_kontantmetod_cutoff before the claim, so a refused
// op stays pending. A refusal in here would run after the claim and consume it.
async function commitPostKontantmetodCutoff(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>,
): Promise<ExecutorResult> {
  const fiscalPeriodId = params.fiscal_period_id as string
  const nextFiscalPeriodId = params.next_fiscal_period_id as string
  const stagedPeriodEnd = params.period_end as string
  const stagedEntityType = params.entity_type as EntityType
  const stagedFingerprint = params.preview_fingerprint as string
  if (
    !fiscalPeriodId || !nextFiscalPeriodId ||
    !stagedPeriodEnd || !stagedEntityType || !stagedFingerprint
  ) {
    return { error: 'Invalid staged kontantmetod cut-off parameters', status: 400 }
  }

  const [{ data: period }, { data: settings }] = await Promise.all([
    supabase
      .from('fiscal_periods')
      .select('id, period_start, period_end, is_closed, locked_at')
      .eq('id', fiscalPeriodId)
      .eq('company_id', companyId)
      .maybeSingle(),
    supabase
      .from('company_settings')
      .select('accounting_method, entity_type')
      .eq('company_id', companyId)
      .maybeSingle(),
  ])

  if (!period) return { error: 'Fiscal period not found', status: 404 }
  if (period.is_closed || period.locked_at) {
    return { error: 'Räkenskapsperioden är stängd eller låst', status: 409 }
  }
  if (period.period_end >= getSwedishLocalDate()) {
    return { error: 'Bokslutsavgränsningen kan bokföras först efter periodens slut', status: 409 }
  }
  if (period.period_end !== stagedPeriodEnd || settings?.entity_type !== stagedEntityType) {
    return { error: 'Period- eller företagsuppgifter har ändrats sedan förhandsgranskningen', status: 409 }
  }
  if (settings?.accounting_method !== 'cash') {
    return { error: 'Företaget använder inte kontantmetoden', status: 409 }
  }

  const { data: nextPeriod } = await supabase
    .from('fiscal_periods')
    .select('id, period_start, period_end, is_closed, locked_at')
    .eq('id', nextFiscalPeriodId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (!nextPeriod) return { error: 'Nästa räkenskapsår hittades inte', status: 409 }

  try {
    const assessment = await assessKontantmetodCutoff(
      supabase,
      companyId,
      period,
      nextFiscalPeriodId,
      parseEntityType(settings.entity_type),
    )

    if (assessment.postings.complete || hasIncompleteKontantmetodCutoffPair(
      assessment.postings,
      assessment.lines,
    )) {
      return {
        error:
          'Kontantmetodens bokslutsavgränsning är redan bokförd eller delvis bokförd för perioden',
        status: 409,
      }
    }
    const currentFingerprint = cutoffPreviewFingerprint({
      collection: assessment.collection,
      lines: assessment.lines,
      entityType: parseEntityType(settings.entity_type),
      periodEnd: period.period_end,
    })
    if (currentFingerprint !== stagedFingerprint) {
      return {
        error:
          'Reskontran har ändrats sedan förhandsgranskningen. Skapa en ny förhandsgranskning innan du bokför.',
        status: 409,
      }
    }

    const result = await postKontantmetodCutoff(supabase, companyId, userId, {
      fiscalPeriodId,
      nextFiscalPeriodId,
      periodEnd: period.period_end,
      receivables: assessment.collection.receivables,
      payables: assessment.collection.payables,
      entityType: parseEntityType(settings.entity_type),
      unknownVatTreatment: assessment.collection.unknownVatTreatment,
      strayVatOnZeroRate: assessment.collection.strayVatOnZeroRate,
    })

    return {
      data: {
        receivable_entry_id: result.receivableEntry?.id ?? null,
        receivable_reversal_entry_id: result.receivableReversal?.id ?? null,
        payable_entry_id: result.payableEntry?.id ?? null,
        payable_reversal_entry_id: result.payableReversal?.id ?? null,
      },
    }
  } catch (err) {
    if (err instanceof KontantmetodCutoffPartialError) {
      throw new PartialCommitError(err.message, err.postedIds, err.cause)
    }
    return failUnlessBookkeepingError(err, 'Kontantmetodens bokslutsavgränsning misslyckades', 400)
  }
}

async function commitSetOpeningBalances(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const closedId = params.closed_period_id as string
  const nextId = params.next_period_id as string
  if (!closedId || !nextId) return { error: 'closed_period_id and next_period_id are required', status: 400 }

  try {
    const entry = await generateOpeningBalances(supabase, companyId, userId, closedId, nextId)
    return { data: { opening_balance_entry_id: entry.id } }
  } catch (err) {
    // The year already has an IB: refused before anything was posted, so the
    // op is rejected with the code the staging tool and create_voucher use.
    if (err instanceof OpeningBalanceExistsError) {
      return { error: err.message, errorCode: OPENING_BALANCE_EXISTS_CODE, status: 409 }
    }
    return failUnlessBookkeepingError(err, 'Opening balances failed', 400)
  }
}

async function commitRunCurrencyRevaluation(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const id = params.fiscal_period_id as string
  const closingDate = params.closing_date as string
  if (!id || !closingDate) return { error: 'fiscal_period_id and closing_date are required', status: 400 }

  try {
    const result = await executeCurrencyRevaluation(supabase, companyId, closingDate, id, userId)
    return {
      data: result
        ? { entry_id: result.entry.id, items_revalued: result.preview.items.length }
        : { entry_id: null, items_revalued: 0, message: 'No foreign-currency items to revalue' },
    }
  } catch (err) {
    return failUnlessBookkeepingError(err, 'Revaluation failed', 400)
  }
}

async function commitPostAnnualDepreciation(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const fiscalPeriodId = params.fiscal_period_id as string
  if (!fiscalPeriodId) return { error: 'fiscal_period_id is required', status: 400 }
  const assetIds = Array.isArray(params.asset_ids) ? (params.asset_ids as string[]) : undefined

  try {
    const { commitAnnualPostings } = await import('@/lib/bokslut/assets/depreciation-engine')
    const { posted, skipped } = await commitAnnualPostings(supabase, companyId, userId, fiscalPeriodId, {
      assetIds,
    })
    return {
      data: {
        posted_count: posted.length,
        skipped_count: skipped.length,
        posted: posted.map((p) => ({
          asset_id: p.assetId,
          journal_entry_id: p.entry.id,
          voucher_number: p.entry.voucher_number,
          schedule_id: p.scheduleId,
        })),
        skipped,
      },
    }
  } catch (err) {
    return failUnlessBookkeepingError(err, 'Depreciation posting failed', 400)
  }
}

// ── Anläggningsregister ──────────────────────────────────────────

function invalidAssetParams(err: z.ZodError): ExecutorResult {
  const issue = err.issues[0]
  const path = issue?.path?.join('.') || 'params'
  return { error: `Invalid ${path}: ${issue?.message ?? 'validation failed'}`, status: 400 }
}

async function commitCreateAsset(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  // Re-validate at the commit boundary: a tampered pending_operations row
  // must not reach the register with fields the staging tool never accepted.
  const parsed = CreateAssetSchema.safeParse(params)
  if (!parsed.success) return invalidAssetParams(parsed.error)
  const gate = await checkCreateAssetGates(supabase, companyId, parsed.data)
  if (gate) return { error: gate.message_en, errorCode: gate.code, status: gate.status }
  try {
    const asset = await createFixedAsset(supabase, companyId, userId, parsed.data)
    return { data: { asset_id: asset.id, ...assetView(asset, false) } }
  } catch (err) {
    return failUnlessBookkeepingError(err, 'Asset creation failed', 400)
  }
}

async function commitUpdateAsset(
  supabase: SupabaseClient,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const assetId = params.asset_id
  if (typeof assetId !== 'string' || !assetId) return { error: 'asset_id is required', status: 400 }
  const parsed = UpdateAssetSchema.safeParse(params.changes ?? {})
  if (!parsed.success) return invalidAssetParams(parsed.error)
  if (Object.keys(parsed.data).length === 0) return { error: 'changes must contain at least one field', status: 400 }
  const existing = await getFixedAsset(supabase, companyId, assetId)
  if (!existing) return { error: 'Asset not found', errorCode: 'ASSET_NOT_FOUND', status: 404 }
  const gate = await checkUpdateAssetGates(supabase, companyId, parsed.data, existing)
  if (gate) return { error: gate.message_en, errorCode: gate.code, status: gate.status }
  try {
    const asset = await updateFixedAsset(supabase, companyId, assetId, parsed.data)
    const posted = await hasPostedDepreciation(supabase, companyId, assetId)
    return { data: { asset_id: asset.id, ...assetView(asset, posted) } }
  } catch (err) {
    if (err instanceof AssetCorrectionBlockedError) {
      return { error: err.message, errorCode: err.code, status: 409 }
    }
    return failUnlessBookkeepingError(err, 'Asset update failed', 400)
  }
}

async function commitDisposeAsset(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const { asset_id: assetId, ...rest } = params
  if (typeof assetId !== 'string' || !assetId) return { error: 'asset_id is required', status: 400 }
  const parsed = DisposeAssetSchema.safeParse(rest)
  if (!parsed.success) return invalidAssetParams(parsed.error)
  try {
    const result = await disposeFixedAsset(supabase, companyId, userId, assetId, parsed.data)
    return {
      data: {
        asset_id: result.asset.id,
        disposed_at: result.asset.disposed_at,
        disposal_type: result.asset.disposal_type ?? parsed.data.disposal_type,
        disposal_journal_entry_id: result.disposal_entry?.id ?? null,
        voucher_number: result.disposal_entry?.voucher_number ?? null,
        gain_or_loss: result.gain_or_loss,
      },
    }
  } catch (err) {
    // The typed asset errors carry a registry code; surface it so the caller
    // can branch (404 not found, 409 already disposed / blocked, 422 missing
    // jämkning data or confirmation) instead of parsing prose.
    const code = (err as { code?: unknown }).code
    if (typeof code === 'string' && code.startsWith('ASSET_')) {
      const status = code === 'ASSET_NOT_FOUND' ? 404 : code.endsWith('_REQUIRED') ? 422 : 409
      return { error: (err instanceof Error && err.message) || code, errorCode: code, status }
    }
    return failUnlessBookkeepingError(err, 'Asset disposal failed', 400)
  }
}

async function commitExplainVoucherGap(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  // The write every door shares (series A-Z, range order, 1-500 characters,
  // the company's year, insert only). Rows staged before it in the same
  // params shape commit through it too; an invalid one is refused with its
  // code instead of a raw database 500.
  const result = await saveVoucherGapExplanation(supabase, companyId, userId, voucherGapExplanationFromParams(params))
  if (!result.ok) {
    return {
      error: getErrorEntry(result.code)?.message_sv ?? result.code,
      errorCode: result.code,
      status: result.status,
    }
  }
  return { data: { explanation_id: result.data.id } }
}

async function commitApproveSupplierInvoice(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const id = params.supplier_invoice_id as string
  if (!id) return { error: 'supplier_invoice_id is required', status: 400 }

  // The approving person attests: the company's attest policy (who may
  // attest, four eyes, any or all) is applied to them, in the same service
  // as the dashboard and v1 (lib/supplier-invoices/attest-service.ts).
  // Staged operations can be committed twice (retry, two approvers): the
  // service's optimistic guard sets approved_at and emits the event once.
  const outcome = await approveSupplierInvoice(
    { supabase, companyId, userId, log: createLogger('pending-operations/approve-supplier-invoice') },
    { invoiceId: id, source: 'mcp' },
  )
  if (!outcome.ok) {
    const entry = getErrorEntry(outcome.code)
    if (outcome.code === 'SI_APPROVE_NOT_REGISTERED' && (outcome.details as { reason?: string } | undefined)?.reason === 'race') {
      return { error: 'Fakturan godkändes av någon annan medan operationen väntade', status: 409 }
    }
    return { error: entry?.message_sv ?? outcome.code, status: entry?.httpStatus ?? 400, errorCode: outcome.code }
  }
  if (outcome.dryRun) return { data: outcome.preview }
  const { invoice, approved, attest } = outcome.data
  return {
    data: {
      supplier_invoice_id: id,
      status: invoice.status,
      approved_at: invoice.approved_at ?? null,
      attested: approved || !!invoice.approved_at,
      attest_remaining_user_ids: attest.remaining,
    },
  }
}

/**
 * Swedish detail for a Postgres not_null_violation (23502) or check_violation
 * (23514) on the supplier_invoices INSERT, naming the column or constraint
 * from the pg message. Null for every other code so the caller keeps its
 * generic handling; the pg `details` (which echoes the failing row) is never
 * forwarded.
 */
function describeSupplierInvoiceInputViolation(
  pgErr: { code?: string; message?: string } | null,
): string | null {
  if (!pgErr?.code) return null
  const message = pgErr.message ?? ''
  if (pgErr.code === '23502') {
    const column = message.match(/column "([^"]+)"/)?.[1] ?? 'okänd kolumn'
    return `Fältet ${column} saknas och får inte vara tomt (23502).`
  }
  if (pgErr.code === '23514') {
    const constraint = message.match(/constraint "([^"]+)"/)?.[1] ?? 'okänt villkor'
    return `Ett värde bryter mot villkoret ${constraint} (23514).`
  }
  return null
}

async function commitCreateSupplierInvoiceFromInbox(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const inboxItemId = params.inbox_item_id as string
  const supplierId = params.supplier_id as string
  const documentId = (params.document_id as string | null) ?? null
  const supplierInvoiceNumber = params.supplier_invoice_number as string
  const invoiceDate = params.invoice_date as string
  const dueDate = (params.due_date as string | null) ?? null
  const currency = (params.currency as string) || 'SEK'
  const vatTreatment = (params.vat_treatment as string) || 'standard_25'
  const notes = (params.notes as string | null) ?? null
  // Absent on ops staged before the MCP door carried it: null, as before.
  const paymentReference =
    typeof params.payment_reference === 'string' ? params.payment_reference.trim() || null : null
  const rawItems = (params.items as Array<Record<string, unknown>> | undefined) ?? []
  // Dimensions PR7: resolved at staging time; coerce is the drift/tamper gate.
  const defaultDimensions = coerceDimensionsBag(params.default_dimensions)

  // due_date is NOT NULL on supplier_invoices: a null here used to reach the
  // INSERT and surface as a bare 500 (feedback 395405). Staging defaults it
  // now; this guard catches a stale or tampered op before an ankomstnummer
  // is burnt. A blank number is refused the same way: the column refuses it
  // (supplier_invoices_number_not_blank), and this door still needs one.
  if (
    !inboxItemId ||
    !supplierId ||
    typeof supplierInvoiceNumber !== 'string' ||
    !supplierInvoiceNumber.trim() ||
    !invoiceDate ||
    !dueDate ||
    rawItems.length === 0
  ) {
    return {
      error: 'inbox_item_id, supplier_id, supplier_invoice_number, invoice_date, due_date, and items are required',
      errorCode: 'SI_CREATE_INVALID_INPUT',
      status: 400,
    }
  }

  // Reject tampered financial fields: Number(x) || 0 silently turns string
  // junk and undefined into a zero-value invoice. Require a finite number on
  // every monetary field, including the optional exchange_rate when present.
  const finite = (raw: unknown): number | null =>
    typeof raw === 'number' && Number.isFinite(raw) ? raw : null
  const subtotal = finite(params.subtotal)
  const vatAmount = finite(params.vat_amount)
  const total = finite(params.total)
  if (subtotal === null || vatAmount === null || total === null) {
    return {
      error: 'subtotal, vat_amount, and total must be finite numbers',
      status: 400,
    }
  }
  const exchangeRate = params.exchange_rate === null || params.exchange_rate === undefined
    ? null
    : finite(params.exchange_rate)
  if (params.exchange_rate !== null && params.exchange_rate !== undefined && exchangeRate === null) {
    return { error: 'exchange_rate must be a finite number when provided', status: 400 }
  }

  // Every item carries its own account, under the rule the create routes
  // hold (CreateSupplierInvoiceItemSchema: four digits). Staging resolves
  // and checks it, so a miss here is a stale or tampered op: refuse it
  // before an ankomstnummer is drawn instead of guessing one.
  if (rawItems.some((item) => typeof item.account_number !== 'string' || !ACCOUNT_NUMBER_RE.test(item.account_number))) {
    const entry = getErrorEntry('SI_CREATE_ITEM_ACCOUNT_MISSING')
    return {
      error: entry?.message_sv ?? 'En eller flera fakturarader saknar konto.',
      errorCode: 'SI_CREATE_ITEM_ACCOUNT_MISSING',
      status: entry?.httpStatus ?? 400,
    }
  }

  // Särskild löneskatt (SLP): staged params must respect the same rule the
  // create routes enforce; the 7533/2514 pair is only lawful on 741x pension
  // premiums, so a flag on any other account is tampered or mis-staged.
  const slpInvalid = rawItems.some(
    (item) => item.apply_slp === true && !isSlpPensionAccount(String(item.account_number ?? '')),
  )
  if (slpInvalid) {
    return {
      error:
        getErrorEntry('SI_CREATE_SLP_INVALID_ACCOUNT')?.message_sv ??
        'Särskild löneskatt kan bara läggas till på rader med pensionskonto 7410-7419.',
      status: 400,
    }
  }

  // Idempotency: a re-fired commit (e.g. retry, double-click on the approval
  // UI, racy MCP call) must not create a second leverantörsfaktura for the
  // same inbox row. The DB FK on invoice_inbox_items.created_supplier_invoice_id
  // is the source of truth.
  const { data: inbox, error: inboxErr } = await supabase
    .from('invoice_inbox_items')
    .select('id, document_id, created_supplier_invoice_id, status, kind_hint, extracted_data')
    .eq('id', inboxItemId)
    .eq('company_id', companyId)
    .single()

  if (inboxErr || !inbox) return { error: 'Inbox item not found', status: 404 }
  if (inbox.created_supplier_invoice_id) {
    return {
      data: {
        supplier_invoice_id: inbox.created_supplier_invoice_id,
        inbox_item_id: inboxItemId,
        idempotent: true,
      },
    }
  }

  // A credit note is never a payable of its own (issue #2980): an operation
  // staged before the item read as one, or with negative amounts, is refused
  // here; the credit goes through gnubok_credit_supplier_invoice.
  if (resolveInboxKind(inbox) === 'credit_note' || total < 0 || subtotal < 0) {
    const entry = getErrorEntry('INBOX_ITEM_IS_CREDIT_NOTE')
    return {
      error: entry?.message_sv ?? 'Posten är en kreditfaktura.',
      errorCode: 'INBOX_ITEM_IS_CREDIT_NOTE',
      status: entry?.httpStatus ?? 409,
    }
  }

  // Defense in depth: the staging-time supplier lookup may be stale by the
  // time the human approves. RLS would block a cross-company supplier too,
  // but a 404 here is a cleaner error than an RLS denial later.
  const { data: supplier, error: supplierErr } = await supabase
    .from('suppliers')
    .select('id, name, org_number, supplier_type')
    .eq('id', supplierId)
    .eq('company_id', companyId)
    .single()

  if (supplierErr || !supplier) return { error: 'Supplier not found', status: 404 }

  // Fourth and last supplier-invoice write path to adopt the shared resolver
  // (POST /api/supplier-invoices, POST /api/v1/.../supplier-invoices and the
  // inbox convert route went first). It took `params.exchange_rate` verbatim
  // with no fetch, so an inbox conversion whose staging-time lookup failed
  // (the MCP tool stages `exchange_rate: null` + `exchange_rate_source:
  // 'lookup_failed'` in that case) persisted a foreign invoice with
  // exchange_rate = NULL. createSupplierInvoiceRegistrationEntry then refuses
  // it with SI_FX_RATE_MISSING further down, after the ankomstnummer has
  // already been burnt, and a NULL rate that does reach a lenient reader
  // understates the fiktiv moms on 2614/2645, i.e. rutorna 20-24 + 30-32.
  //
  // Sharing the resolver is what keeps the four paths in agreement: the
  // currency policy, the SEK arithmetic and the refusal are defined once. A
  // caller-supplied positive rate is still trusted verbatim, which is what
  // makes the approved preview number the number written; only a missing rate
  // triggers the Riksbanken fetch, anchored on invoice_date with the supabase
  // client passed so `exchange_rates` serves as the read-through cache.
  //
  // Resolved BEFORE get_next_arrival_number so a refusal never burns an
  // ankomstnummer: same ordering as app/api/supplier-invoices/route.ts.
  const fx = await resolveSupplierInvoiceExchangeRate(supabase, {
    currency,
    invoiceDate,
    suppliedRate: exchangeRate,
  })
  if (!fx.ok) {
    // Resolved before the ankomstnummer is drawn (see above), so a temporary
    // Riksbanken refusal leaves the operation approvable.
    if (fx.temporary) return exchangeRateRetryLater()
    return {
      error:
        getErrorEntry('SI_FX_RATE_MISSING')?.message_sv ??
        'Leverantörsfakturan är i utländsk valuta men saknar växelkurs. Ange fakturans växelkurs innan den bokförs.',
      status: 400,
    }
  }

  // Booking mode for the registration verifikat, and the VAT registration
  // the item rows depend on: read once, before an ankomstnummer is drawn.
  const { data: settings } = await supabase
    .from('company_settings')
    .select('accounting_method, defer_invoice_booking, vat_registered')
    .eq('company_id', companyId)
    .single()

  const reverseCharge = vatTreatment === 'reverse_charge'
  // Icke momsregistrerad (feedback seq 708521): the seller's moms is part of
  // the cost, never 2641. Staging folds it into the lines; an op staged
  // before that fix (net lines plus 25 %) or a tampered one is folded here
  // too, so no op can book input VAT the company can never reclaim.
  const vatIsCost = sellerVatIsCost(settings?.vat_registered, reverseCharge)
  // Treatments under which no seller VAT may reach the books: reverse charge
  // (the buyer self-assesses on 2614/2645) and exempt / export, where the
  // supplier charged no Swedish moms at all so there is nothing deductible
  // (issue #2553). Both take the same header and item treatment below.
  const noDeductibleSellerVat = !vatIsCost && (reverseCharge || !treatmentDeductsInputVat(vatTreatment))

  // RC invariant: a reverse-charge supplier invoice never shows output VAT
  // from the supplier. Zero any per-line VAT that slipped through staging so
  // the registration JE's 2614/2645 self-assessed leg lines up with rutor
  // 20-24 / 48 instead of double-counting input VAT into 2641. Tampered
  // params can't smuggle non-zero VAT into the items table.
  //
  // Exempt and export invoices take the same zeroing (issue #2553): the
  // supplier charged no Swedish moms, so a rate that came from OCR, from a
  // stale staged op or from the column's own 0.25 default has nothing to
  // deduct behind it. The engine refuses to book 2641 for these treatments
  // either way; storing 0 keeps the row honest about what the underlag says.
  const itemRows = rawItems.map((item, idx) => {
    // Normalize percent-shaped rates (25 -> 0.25) and snap to the statutory
    // set: rows staged before the issue #310 fix (or tampered params) carry
    // percent integers, and inserting one books 2500 % VAT downstream.
    const vatRate = noDeductibleSellerVat ? 0 : (typeof item.vat_rate === 'number' ? normalizeVatRateToDecimal(item.vat_rate) : 0)
    const vatAmt = noDeductibleSellerVat ? 0 : (typeof item.vat_amount === 'number' && Number.isFinite(item.vat_amount) ? item.vat_amount : 0)
    return {
      sort_order: idx,
      description: String(item.description ?? `Position ${idx + 1}`),
      quantity: typeof item.quantity === 'number' && Number.isFinite(item.quantity) ? item.quantity : 1,
      unit: (item.unit as string | undefined) ?? 'st',
      unit_price: typeof item.unit_price === 'number' && Number.isFinite(item.unit_price) ? item.unit_price : 0,
      line_total: typeof item.line_total === 'number' && Number.isFinite(item.line_total) ? item.line_total : 0,
      account_number: item.account_number as string,
      vat_code: null,
      vat_rate: vatRate,
      vat_amount: vatAmt,
      // For reverse charge the buyer self-assesses VAT; carry an explicit
      // statutory rate when staged, else null (engine defaults to 25%).
      reverse_charge_rate: reverseCharge
        ? ([0.06, 0.12, 0.25].includes(Number(item.reverse_charge_rate)) ? Number(item.reverse_charge_rate) : null)
        : null,
      // Särskild löneskatt (SLP): booking injects the self-balancing
      // 7533/2514 pair for this line. Validated above (741x accounts only).
      apply_slp: item.apply_slp === true,
      dimensions: coerceDimensionsBag(item.dimensions) ?? {},
    }
  })
  const items = vatIsCost ? foldSellerVatIntoCost(itemRows).lines : itemRows

  // Omvänd skattskyldighet: the registration entry credits 2440 with the sum
  // of the line nets (the fiktiv 2614/2645 pair nets to zero), so that sum is
  // the only payable the reskontra can carry. Staging registers the net since
  // feedback seq 366701, but an op staged before that fix, or a tampered one,
  // still carries the document's gross (919.20 + 229.80 = 1149.00 on the
  // reported invoice) and would leave remaining_amount 1149 against 919.20 in
  // the GL: never trust a staged header under reverse charge. VAT the seller
  // charged on a reverse-charge invoice is not deductible and is not booked.
  // An exempt or export op is the same shape: the items below carry no VAT,
  // so a staged header that still carries some would leave the reskontra
  // above what the registration entry credits on 2440. A non-registered
  // company's rows carry the seller's moms as cost, so their sum is its
  // payable for the same reason.
  const headerFromItems = noDeductibleSellerVat || vatIsCost
  const itemNetSum = items.reduce((sum, item) => sum + item.line_total, 0)
  const subtotalRounded = headerFromItems ? roundOre(itemNetSum) : Math.round(subtotal * 100) / 100
  const vatAmountRounded = headerFromItems ? 0 : Math.round(vatAmount * 100) / 100
  const totalRounded = headerFromItems ? subtotalRounded : Math.round(total * 100) / 100
  // Fed the already-rounded figures so a SEK invoice (rate 1) gets
  // total_sek === total to the öre instead of the two roundings disagreeing on
  // an exact-half value. The old `exchangeRate ? … : null` guard left all three
  // SEK columns NULL on every ordinary Swedish invoice, which is what blanked
  // the SEK-reporting readers (the KPI "Största leverantörer" panel among them).
  const {
    subtotal_sek: subtotalSek,
    vat_amount_sek: vatAmountSek,
    total_sek: totalSek,
  } = supplierInvoiceSekAmounts(fx.rate, {
    subtotal: subtotalRounded,
    vatAmount: vatAmountRounded,
    total: totalRounded,
  })

  // Hard gate (feedback seq 983757): the registration verifikat credits 2440
  // with the item rows plus their VAT, while the reskontra row keeps the
  // staged total. Where the header is the document's own total (not derived
  // from the items above), the two must agree within öresavrundning and
  // per-line VAT rounding (supplierInvoiceTotalsTolerance), or the books
  // carry a leverantörsskuld the supplier never billed. Staging refuses
  // the mismatch since the same fix; this catches an op staged before it, or
  // a tampered one, before an ankomstnummer is drawn.
  if (!headerFromItems) {
    const gap = supplierInvoiceTotalsGap(totalRounded, items)
    if (exceedsSupplierInvoiceTotalsTolerance(gap, items.length)) {
      const entry = getErrorEntry('SI_CREATE_TOTALS_MISMATCH')
      log.warn('Refused a staged inbox supplier invoice whose lines do not add up to its total', {
        companyId,
        inboxItemId,
        gap,
      })
      return {
        error:
          `${entry?.message_sv ?? 'Fakturaraderna inklusive moms stämmer inte med fakturans totalbelopp.'} `
          + `Raderna inklusive moms: ${supplierInvoiceLinesInclVat(items)}, totalbelopp: ${totalRounded}.`,
        errorCode: 'SI_CREATE_TOTALS_MISMATCH',
        status: entry?.httpStatus ?? 400,
      }
    }
  }

  // The model's original reading of the underlag, taken before anything is written.
  const extractionSnapshot = await snapshotInboxExtraction(supabase, companyId, {
    id: inboxItemId,
    document_id: (inbox.document_id as string | null) ?? documentId,
    extracted_data: inbox.extracted_data,
  })

  // What the invoice states it is paid to, read from the item's extraction
  // the same way as the dashboard and v1 doors, and compared with the
  // supplier card before the card is touched (lib/payments/payee-alerts.ts).
  // Never the staged supplier_payment_details (ops staged before accounted#15):
  // that held only what the card lacked, so an account that differs from the
  // card was dropped and its payment went to the card's account unchecked.
  const paymentDetails = inboxStatedPaymentDetails(inbox.extracted_data)
  const payeeAssessment = await assessRegisteredPayee(supabase, companyId, supplierId, paymentDetails)
  if (payeeAssessment.alert) {
    log.info('Inbox invoice states bank details the supplier card lacks', { companyId, supplierId, alert: payeeAssessment.alert })
  }

  const { data: arrivalNum, error: arrivalErr } = await supabase
    .rpc('get_next_arrival_number', { p_company_id: companyId })

  if (arrivalErr) {
    return { error: `Failed to generate arrival number: ${arrivalErr.message}`, status: 500 }
  }

  const { data: invoice, error: invoiceErr } = await supabase
    .from('supplier_invoices')
    .insert({
      user_id: userId,
      company_id: companyId,
      supplier_id: supplierId,
      arrival_number: arrivalNum,
      supplier_invoice_number: supplierInvoiceNumber,
      invoice_date: invoiceDate,
      due_date: dueDate,
      status: 'registered',
      currency: fx.rate.currency,
      exchange_rate: fx.rate.exchangeRate,
      // Which day's kurs the SEK amounts were translated at: the audit trail
      // that makes them verifiable under BFL 5 kap.
      exchange_rate_date: fx.rate.exchangeRateDate,
      vat_treatment: vatTreatment,
      reverse_charge: reverseCharge,
      paid_with_private_funds: false,
      subtotal: subtotalRounded,
      subtotal_sek: subtotalSek,
      vat_amount: vatAmountRounded,
      vat_amount_sek: vatAmountSek,
      total: totalRounded,
      total_sek: totalSek,
      paid_amount: 0,
      remaining_amount: totalRounded,
      document_id: documentId,
      // The OCR the extraction read (feedback seq 869949): a betalfil
      // references the payment by it.
      payment_reference: paymentReference,
      // What the document itself says to pay to, validated.
      payee_bankgiro: payeeAssessment.stated.payee_bankgiro,
      payee_plusgiro: payeeAssessment.stated.payee_plusgiro,
      payee_iban: payeeAssessment.stated.payee_iban,
      payee_bic: payeeAssessment.stated.payee_bic,
      notes,
      default_dimensions: defaultDimensions ?? {},
    })
    .select()
    .single()

  if (invoiceErr || !invoice) {
    const pgErr = invoiceErr as { code?: string; message?: string } | null
    const isDuplicate = pgErr?.code === '23505'
    if (isDuplicate) {
      // Generic 409: supplier_invoice_number alone is already in the staged
      // params the caller submitted; we just don't echo back the supplier's
      // name or row id. The UI surface uses the supplier-side ledger, not
      // this error.
      log.warn('Duplicate supplier invoice number on inbox conversion', {
        companyId,
        supplierId,
        supplierInvoiceNumber,
      })
      return {
        error: `Leverantörsfaktura ${supplierInvoiceNumber} finns redan registrerad.`,
        status: 409,
      }
    }
    // 23502 / 23514 are input problems, not infrastructure: the staged params
    // carried a null or an out-of-range value that the column refused. Name
    // the column or constraint so the caller can fix the extraction and
    // re-stage, instead of reading "Failed to create supplier invoice" and
    // retrying the identical op (feedback 395405: two retries on a null
    // due_date, both logged only server-side).
    const invalidInput = describeSupplierInvoiceInputViolation(pgErr)
    if (invalidInput) {
      log.warn('Supplier invoice insert from inbox refused by a column constraint', {
        companyId,
        inboxItemId,
        supplierId,
        code: pgErr?.code,
        error: pgErr?.message ?? 'unknown',
      })
      return {
        error: `${getErrorEntry('SI_CREATE_INVALID_INPUT')?.message_sv ?? 'Ogiltig kombination av fakturafält.'} ${invalidInput}`,
        errorCode: 'SI_CREATE_INVALID_INPUT',
        status: 400,
      }
    }
    log.error('Failed to insert supplier invoice from inbox', {
      companyId,
      inboxItemId,
      supplierId,
      error: pgErr?.message ?? 'unknown',
    })
    return { error: 'Failed to create supplier invoice', status: 500 }
  }

  const itemInserts = items.map((item) => ({ supplier_invoice_id: invoice.id, ...item }))

  const { error: itemsErr } = await supabase
    .from('supplier_invoice_items')
    .insert(itemInserts)

  if (itemsErr) {
    // Roll back the parent to avoid orphan supplier_invoices rows. Without
    // line items the registration JE can't be built and the invoice would
    // be invisible in the supplier ledger anyway.
    await supabase.from('supplier_invoices').delete().eq('id', invoice.id).eq('company_id', companyId)
    log.error('Failed to insert supplier invoice items, rolled back parent', {
      companyId,
      invoiceId: invoice.id,
      error: itemsErr.message,
    })
    return { error: 'Failed to insert supplier invoice items', status: 500 }
  }

  let registrationJournalEntryId: string | null = null

  // #967: deferred companies register WITHOUT booking (same gate as
  // POST /api/supplier-invoices); ekonomi books later via the Bokför step.
  if (booksInvoicesOnIssue(settings)) {
    try {
      const journalEntry = await createSupplierInvoiceRegistrationEntry(
        supabase,
        companyId,
        userId,
        invoice as SupplierInvoice,
        itemInserts as unknown as SupplierInvoiceItem[],
        supplier.supplier_type,
        supplier.name,
      )

      if (journalEntry) {
        registrationJournalEntryId = journalEntry.id
        await supabase
          .from('supplier_invoices')
          .update({ registration_journal_entry_id: journalEntry.id })
          .eq('id', invoice.id)

        // Attach the OCR'd source document to the verifikat so the
        // registration JE has its underlag per BFL 5 kap 6 §. Linking failure
        // is non-fatal: the JE is already posted and immutable; we log and
        // continue so the supplier invoice stays usable.
        if (documentId) {
          try {
            await linkToJournalEntry(supabase, companyId, documentId, journalEntry.id)
          } catch (linkErr) {
            log.warn('Failed to link inbox document to registration JE', {
              documentId,
              journalEntryId: journalEntry.id,
              error: linkErr instanceof Error ? linkErr.message : String(linkErr),
            })
          }
        }
      } else {
        // createSupplierInvoiceRegistrationEntry returns null ONLY when no
        // fiscal period covers invoice_date (every other failure throws into
        // the catch below). Without this branch the inbox item gets linked to
        // an unbooked supplier invoice: the same 2440/2641 orphan the catch
        // guards against. Roll back (items first, see FK note below) and return
        // an actionable error instead of silently "succeeding".
        await supabase
          .from('supplier_invoice_items')
          .delete()
          .eq('supplier_invoice_id', invoice.id)
        await supabase
          .from('supplier_invoices')
          .delete()
          .eq('id', invoice.id)
          .eq('company_id', companyId)
        return {
          error:
            'Det finns inget räkenskapsår som täcker fakturadatumet. Lägg upp räkenskapsåret först, eller ändra fakturadatumet.',
          status: 400,
        }
      }
    } catch (err) {
      // Roll back: orphan supplier_invoices row without its registration JE
      // understates leverantörsskuld (2440) + ingående moms (2641) on the
      // momsdeklaration. Items must be deleted BEFORE the parent: the FK
      // on supplier_invoice_items.supplier_invoice_id is ON DELETE NO ACTION
      // (default), so a parent-first delete would be silently blocked and
      // leave the doomed invoice in the supplier ledger.
      await supabase
        .from('supplier_invoice_items')
        .delete()
        .eq('supplier_invoice_id', invoice.id)
      const { error: parentDeleteErr } = await supabase
        .from('supplier_invoices')
        .delete()
        .eq('id', invoice.id)
        .eq('company_id', companyId)
      if (parentDeleteErr) {
        // Hard inconsistency: items gone but parent stuck. Log loudly so an
        // operator can clean up; this should not happen in practice.
        log.error('Rollback partial: parent supplier_invoices delete failed after JE failure', {
          companyId,
          invoiceId: invoice.id,
          parentDeleteError: parentDeleteErr.message,
          originalError: err instanceof Error ? err.message : String(err),
        })
      }
      if (isBookkeepingError(err)) throw err
      log.error('Failed to create registration journal entry; supplier invoice rolled back', {
        companyId,
        inboxItemId,
        invoiceId: invoice.id,
        error: err instanceof Error ? err.message : 'unknown',
      })
      return {
        error: 'Failed to create registration journal entry',
        status: 500,
      }
    }
  }

  // Terminal state for the inbox row: created_supplier_invoice_id is the
  // dedup key for next time this inbox item is touched, and it's what the UI
  // and list_unmatched_documents use to drop the row out of "needs action".
  // Do NOT write status here: the status CHECK only allows received|error
  // (migration 20260504180000); writing 'confirmed' makes Postgres reject the
  // whole UPDATE, so the link column never lands and the item stays unresolved.
  const { error: linkInboxErr } = await supabase
    .from('invoice_inbox_items')
    .update({ created_supplier_invoice_id: invoice.id })
    .eq('id', inboxItemId)
    .eq('company_id', companyId)

  if (linkInboxErr) {
    log.warn('Failed to link inbox item to new supplier invoice (invoice still created)', {
      inboxItemId,
      supplierInvoiceId: invoice.id,
      error: linkInboxErr.message,
    })
  }
  // The same item staged twice: this operation is 'committing', so only its
  // still-pending twins are rejected (crm#1074).
  await rejectSupersededInboxConversions(supabase, companyId, inboxItemId, invoice.id as string)

  // The same details written to the card now, after approval and once the
  // invoice exists, and only into columns the supplier still lacks; never
  // when the invoice names an account the card does not have (a person
  // approves that one first). Never throws.
  if (paymentDetails && payeeAssessment.backfill) {
    await backfillSupplierPaymentDetails(supabase, companyId, supplierId, paymentDetails)
  }

  await recordInboxDecision(supabase, extractionSnapshot, {
    supplier_invoice_id: invoice.id as string,
    journal_entry_id: registrationJournalEntryId,
    fields: {
      supplier_name: (supplier.name as string | null) ?? null,
      supplier_org_number: (supplier.org_number as string | null) ?? null,
      invoice_number: supplierInvoiceNumber,
      invoice_date: invoiceDate,
      due_date: dueDate,
      payment_reference: paymentReference,
      currency,
      total,
      vat_amount: vatAmount,
      accounts: resultAccounts(items.map((line) => line.account_number)),
    },
    lines: await loadEntryLines(supabase, companyId, registrationJournalEntryId),
  }, userId, [
    // The item was not converted yet, and the payee was compared with the supplier card.
    checkPassed('already_booked'),
    payeeAssessment.alert ? checkWarned('payee_alert', payeeAlertWarning(payeeAssessment.alert).code) : checkPassed('payee_alert'),
  ])

  try {
    await eventBus.emit({
      type: 'supplier_invoice.registered',
      payload: { supplierInvoice: invoice as SupplierInvoice, companyId, userId },
    })
  } catch { /* non-blocking */ }

  return {
    data: {
      supplier_invoice_id: invoice.id,
      inbox_item_id: inboxItemId,
      registration_journal_entry_id: registrationJournalEntryId,
      arrival_number: arrivalNum,
      // Why a payment of it waits, as the dashboard and v1 doors say it.
      ...(payeeAssessment.alert ? { warnings: [payeeAlertWarning(payeeAssessment.alert)] } : {}),
    },
  }
}

async function commitCreditSupplierInvoice(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const id = params.supplier_invoice_id as string
  if (!id) return { error: 'supplier_invoice_id is required', status: 400 }

  // The same service as the dashboard and v1 routes (issue #2980): the MCP
  // copy of this flow never stopped periodisering schedules or carried the
  // reverse-charge rate and SLP flag onto the credit note. Only the inputs
  // gnubok_credit_supplier_invoice stages are passed on.
  const parsed = CreditSupplierInvoiceInputSchema.safeParse({
    ...(typeof params.inbox_item_id === 'string' ? { inbox_item_id: params.inbox_item_id } : {}),
  })
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Invalid params', errorCode: 'VALIDATION_ERROR', status: 400 }
  }
  const outcome = await creditSupplierInvoice(
    { supabase, companyId, userId, log: log.child({ operation: 'credit_supplier_invoice' }) },
    id,
    parsed.data,
  )
  if (!outcome.ok) {
    if (outcome.error) throw outcome.error
    const entry = getErrorEntry(outcome.code)
    return {
      error: outcome.messageSv || entry?.message_sv || outcome.code,
      errorCode: outcome.code,
      status: entry?.httpStatus ?? 400,
      // The figures the remediations point at (both totals of a partial
      // credit note, rows_payable_sek and invoice_payable_sek of rows that
      // do not add up) reach the approver as they reach the routes' callers.
      data: outcome.details,
    }
  }
  if (outcome.dryRun) return { data: outcome.preview }
  return {
    data: {
      credit_note_id: outcome.data.credit_note.id,
      journal_entry_id: outcome.data.journal_entry_id,
      document_id: outcome.data.document_id,
      inbox_item_id: outcome.data.inbox_item_id,
      ...(outcome.warnings && outcome.warnings.length > 0 ? { warnings: outcome.warnings } : {}),
    },
  }
}

async function commitCreditInvoice(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const id = params.invoice_id as string
  const reason = params.reason as string | undefined
  if (!id) return { error: 'invoice_id is required', status: 400 }

  // The credit every door runs (lib/invoices/credit-invoice.ts): the guards,
  // today's period before anything is written, the mirrored credit note, the
  // reversing verifikat and only then the original flipped to 'credited'.
  const result = await creditInvoice({ supabase, companyId, userId, log }, id, { reason })
  if (!result.ok) {
    if (result.code === 'UNKNOWN_ERROR') {
      throw result.error instanceof Error ? result.error : new Error('credit_invoice failed')
    }
    const entry = getErrorEntry(result.code)
    const reasons = (result.failures ?? []).map((failure) => failure.reason)
    const message = reasons.length > 0 ? reasons.join(' ') : (entry?.message_sv ?? result.code)
    // A verifikat posted but a later step (its link, the original's flip, the
    // schedules) did not finish: land in failed_partial with the ids. A
    // re-staged credit completes it (issueCreditNote is idempotent).
    if (result.postedIds) {
      return {
        error: message,
        errorCode: result.code,
        status: entry?.httpStatus ?? 500,
        partialPostedIds: result.postedIds,
      }
    }
    // The original was credited (or deleted) since staging: the staged op no
    // longer fits, so the dispatcher auto-rejects it.
    const status =
      result.code === 'INVOICE_CREDIT_ORIGINAL_NOT_FOUND' ? 404
        : result.code === 'INVOICE_CREDIT_ALREADY_CREDITED' ? 409
          : (entry?.httpStatus ?? 400)
    return {
      error: message,
      errorCode: result.code,
      status,
      ...(result.details ? { data: result.details } : {}),
    }
  }
  if (result.dryRun) return { error: 'credit_invoice does not commit a dry run', status: 400 }

  return {
    data: {
      credit_note_id: result.creditNoteId,
      journal_entry_id: result.journalEntryId,
      // accounted#45: the deferred original was booked first, on its own date.
      ...(result.originalJournalEntryId ? { original_journal_entry_id: result.originalJournalEntryId } : {}),
    },
  }
}

/**
 * delete_draft_invoice: remove a DRAFT customer invoice via the shared
 * deleteDraftInvoice service (also behind the cookie and v1 DELETE routes).
 * Unnumbered draft: hard delete + invoice.draft_deleted audit event.
 * Numbered draft: makulering (status 'cancelled', F-series number retained).
 * The service re-validates status at commit time with TOCTOU write guards,
 * so a draft that was sent between staging and approval is refused (409 ->
 * auto-reject), never cancelled. expected_invoice_number (staged alongside
 * invoice_id) additionally pins the approved OUTCOME: an unnumbered draft
 * that was finalized between staging and approval is refused too, instead of
 * silently switching from the approved hard delete to a makulering.
 */
async function commitDeleteDraftInvoice(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const invoiceId = params.invoice_id as string
  if (!invoiceId) return { error: 'invoice_id is required', status: 400 }

  const result = await deleteDraftInvoice({
    supabase,
    companyId,
    userId,
    invoiceId,
    // Only pin when the staging tool recorded an expectation; absent means an
    // op staged before the pin existed, which keeps legacy semantics.
    ...('expected_invoice_number' in params
      ? { expectedInvoiceNumber: params.expected_invoice_number as string | null }
      : {}),
  })

  if (!result.ok) {
    switch (result.code) {
      case 'INVOICE_NOT_FOUND':
        return { error: 'Invoice not found', errorCode: 'INVOICE_NOT_FOUND', status: 404 }
      case 'INVOICE_DELETE_NOT_DRAFT':
        return {
          error: `Only draft invoices can be deleted (status: ${result.currentStatus}). Issued invoices are immutable: use gnubok_credit_invoice instead.`,
          errorCode: 'INVOICE_DELETE_NOT_DRAFT',
          status: 409,
        }
      case 'INVOICE_CANCEL_RACE':
        return {
          error:
            result.currentInvoiceNumber != null
              ? `Invoice changed after staging: the draft was finalized and now carries number ${result.currentInvoiceNumber}, so the approved hard delete no longer applies. Stage the deletion again to makulera it instead.`
              : 'Invoice was finalized or modified concurrently and could not be removed. Re-read it and stage again if it is still a draft.',
          errorCode: 'INVOICE_CANCEL_RACE',
          status: 409,
        }
      case 'INVOICE_DELETE_FAILED':
        return {
          error: `Failed to remove draft invoice: ${result.cause.message}`,
          errorCode: 'INVOICE_DELETE_FAILED',
          status: 500,
        }
    }
  }

  return {
    data:
      result.outcome === 'deleted'
        ? { invoice_id: invoiceId, deleted: true }
        : { invoice_id: invoiceId, cancelled: true, invoice_number: result.invoiceNumber },
  }
}

async function commitConvertInvoice(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const id = params.invoice_id as string
  if (!id) return { error: 'invoice_id is required', status: 400 }

  // target 'order': shared with POST /api/invoices/[id]/convert-to-order,
  // proforma or quote to a draft kundorder. Staged under the same operation
  // type as the invoice conversion; the target rides in the params.
  if (params.target === 'order') {
    const converted = await convertToSalesOrder(supabase, { companyId, userId, invoiceId: id })
    if (!converted.ok) return salesOrderFailure(converted)
    return { data: { sales_order_id: converted.order.id, order_number: converted.order.order_number } }
  }

  // Shared with POST /api/invoices/[id]/convert: proforma or quote to
  // invoice, F-number allocated last, source cancelled (proforma) or
  // accepted (quote). percent / amount bill a part of a quote (crm#1196),
  // resolved again here against the invoices that exist at approval.
  const part = ConvertQuotePartSchema.safeParse({
    ...(params.percent !== undefined ? { percent: params.percent } : {}),
    ...(params.amount !== undefined ? { amount: params.amount } : {}),
  })
  if (!part.success) {
    return { error: 'percent must be above 0 and at most 100, amount above 0, and not both', errorCode: 'VALIDATION_ERROR', status: 400 }
  }
  const result = await convertToInvoice({
    supabase,
    userId,
    companyId,
    sourceId: id,
    part:
      part.data.percent !== undefined
        ? { percent: part.data.percent }
        : part.data.amount !== undefined
          ? { amount: part.data.amount }
          : null,
  })

  if (!result.ok) {
    if (result.code === 'INVOICE_CONVERT_FAILED') {
      return { error: result.cause.message, errorCode: result.code, status: 500 }
    }
    if (result.code === 'INVOICE_NUMBER_SERIES_BEHIND') {
      return { error: result.messageSv, errorCode: result.code, status: 409 }
    }
    const entry = getErrorEntry(result.code)
    return {
      error: entry?.message_sv ?? result.code,
      errorCode: result.code,
      status: entry?.httpStatus ?? 400,
    }
  }

  return { data: { invoice_id: result.invoice.id, invoice_number: result.invoice.invoice_number } }
}

async function commitImportSie(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const fileContent = params.file_content as string
  const filename = params.filename as string
  const mappings = params.mappings as AccountMapping[] | undefined
  // An absent flag takes the job's default (import everything), the same
  // schema the staging tool resolves through; rows staged before stored
  // explicit booleans (Boolean(undefined) = false) and commit as approved.
  const flags = SIEImportFlagsSchema.safeParse({
    createFiscalPeriod: params.create_fiscal_period,
    importOpeningBalances: params.import_opening_balances,
    importTransactions: params.import_transactions,
    // Operations staged before this param existed keep the file's account
    // names, matching the UI default.
    updateAccountNames: params.update_account_names,
  })
  if (!flags.success) {
    return { error: 'create_fiscal_period, import_opening_balances, import_transactions and update_account_names must be booleans', status: 400 }
  }
  const { createFiscalPeriod, importOpeningBalances, importTransactions, updateAccountNames } = flags.data
  const voucherSeries = params.voucher_series as string | undefined
  // Optional IB-voucher series (issue #1882). Absent on operations staged
  // before the param existed: the SIE job then defaults to a series
  // the file's own vouchers do not use. Type-checked, not cast: staged
  // params are caller-supplied JSON.
  const openingBalanceSeries =
    typeof params.opening_balance_series === 'string' ? params.opening_balance_series : undefined
  // Only a literal true confirms another organisation's file: submitSIEJob
  // checks the file's #ORGNR again at approval.
  const confirmOrgNumberMismatch = params.confirm_org_number_mismatch === true

  if (!fileContent || !filename || !Array.isArray(mappings)) {
    return { error: 'file_content, filename, and mappings are required', status: 400 }
  }

  const job = await submitSIEJob(supabase,companyId,userId,fileContent,mappings,{
    filename,createFiscalPeriod,importOpeningBalances,importTransactions,voucherSeries,openingBalanceSeries,updateAccountNames,
    confirmOrgNumberMismatch,
  })
  // The approval commits submission. The durable execution has its own status.
  return {data:{import_id:job.id,operation_id:job.id,state:job.job_state,accepted:true,
    status_tool:'gnubok_sie_import_status',fiscal_period_id:job.fiscal_period_id}}

}

// ── Phase 4: arbitrary-line bookkeeping primitives ───────────────

/**
 * Normalize raw JSON line input from pending_operations.params into the
 * engine's typed line shape. Trusts shape because the MCP tool already
 * validates via Zod before staging: defensive coercion only.
 */
function normalizeVoucherLines(raw: unknown): CreateJournalEntryLineInput[] {
  if (!Array.isArray(raw)) return []
  return raw.map((l) => {
    const line = l as Record<string, unknown>
    return {
      account_number: String(line.account_number),
      debit_amount: Number(line.debit_amount) || 0,
      credit_amount: Number(line.credit_amount) || 0,
      line_description: line.line_description ? String(line.line_description) : undefined,
      currency: line.currency ? String(line.currency) : undefined,
      amount_in_currency: line.amount_in_currency !== undefined ? Number(line.amount_in_currency) : undefined,
      exchange_rate: line.exchange_rate !== undefined ? Number(line.exchange_rate) : undefined,
      tax_code: line.tax_code ? String(line.tax_code) : undefined,
      // Boundary-validated with the same constraints as the Zod line schema:
      // staged payloads must not bypass API-layer validation (SOC 2 PI1.1).
      dimensions: coerceDimensionsBag(line.dimensions),
      cost_center: line.cost_center ? String(line.cost_center) : undefined,
      project: line.project ? String(line.project) : undefined,
    }
  })
}

async function commitCreateVoucher(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>,
  opts: CommitOptions = {}
): Promise<ExecutorResult> {
  const entryDate = params.entry_date as string
  const description = params.description as string
  const lines = normalizeVoucherLines(params.lines)

  if (!entryDate || !description || lines.length < 2) {
    return { error: 'entry_date, description, and at least two lines are required', status: 400 }
  }

  // Re-validate balance defensively. The MCP tool already checks before
  // staging, but a tampered or hand-inserted pending_operations row would
  // bypass that gate. createDraftEntry runs the same check internally: this
  // is for a cleaner 400 + Swedish error before reaching the engine.
  const balance = validateBalance(lines)
  if (!balance.valid) {
    return {
      error: `Verifikationen balanserar inte: debet ${balance.totalDebit} SEK, kredit ${balance.totalCredit} SEK.`,
      status: 400,
    }
  }

  // Resolve fiscal period: prefer explicit, fall back to date lookup so the
  // caller can post a voucher without first calling list_fiscal_periods.
  let fiscalPeriodId = params.fiscal_period_id as string | undefined
  if (!fiscalPeriodId) {
    const resolved = await findFiscalPeriod(supabase, companyId, entryDate)
    if (!resolved) {
      return {
        error: `Ingen öppen räkenskapsperiod täcker datumet ${entryDate}. Öppna en period eller välj ett annat datum.`,
        status: 400,
      }
    }
    fiscalPeriodId = resolved
  }

  // source_type is derived here: never trust params.source_type. The MCP tool
  // stages a typed boolean (is_opening_balance), not a raw source_type string,
  // so a tampered or future direct-staging path can't inject
  // 'bank'/'invoice'/etc. and corrupt audit attribution. The default is
  // 'manual'. We only upgrade to 'opening_balance' after independently
  // re-validating the entry genuinely looks like an ingående balans: this
  // matters because bank reconciliation excludes an IB from the period movement
  // ONLY when source_type='opening_balance' (lib/reconciliation/bank-reconciliation.ts);
  // a mislabelled 'manual' IB shows up as a phantom reconciliation difference.
  let sourceType: JournalEntrySourceType = 'manual'
  if (params.is_opening_balance === true) {
    // Constraint 1: every line must be a balance-sheet account (BAS class 1 or
    // 2). Mirrors the canonical opening-balance flow which rejects P&L accounts
    // (app/api/import/opening-balance/execute/route.ts). Inlined to avoid
    // coupling this executor to the SIE-import module.
    const nonBalanceSheet = lines
      .map((l) => l.account_number)
      .filter((num) => {
        const cls = parseInt(num.charAt(0), 10)
        return !(cls === 1 || cls === 2)
      })
    if (nonBalanceSheet.length > 0) {
      return {
        error:
          `Ingående balans får bara innehålla balanskonton (klass 1-2). ` +
          `Dessa konton hör inte hemma i en IB: ${[...new Set(nonBalanceSheet)].join(', ')}. ` +
          `Bokför resultatkonton som en vanlig verifikation utan is_opening_balance.`,
        status: 400,
      }
    }

    // Constraint 2: the entry must be dated on the fiscal period's first day:
    // an IB opens the period (same as the canonical flow, which dates the entry
    // on period.period_start). We fetch period_start here because the resolved
    // fiscalPeriodId may have come from either the explicit param or a date
    // lookup; either way the date must line up exactly.
    const { data: period, error: periodErr } = await supabase
      .from('fiscal_periods')
      .select('period_start, name')
      .eq('id', fiscalPeriodId)
      .eq('company_id', companyId)
      .maybeSingle()
    if (periodErr || !period) {
      return { error: 'Räkenskapsperioden hittades inte.', status: 404 }
    }
    if (entryDate !== period.period_start) {
      return {
        error:
          `En ingående balans måste dateras på räkenskapsårets första dag ` +
          `(${period.period_start}). Angivet datum: ${entryDate}. ` +
          `Ändra datumet eller bokför som en vanlig verifikation utan is_opening_balance.`,
        status: 400,
      }
    }

    // Constraint 3: one IB per year (agent feedback seqs 892914, 897234,
    // 897844). A second opening_balance voucher on the same date is read by
    // every report as the IB plus a movement of the same balances, so the
    // year's balances count twice. The staging tool refuses this too; this is
    // the authoritative check, since another IB can be posted between staging
    // and approval. Fails closed when the check itself cannot run.
    let existingIb: ExistingOpeningBalance | null
    try {
      existingIb = await findExistingOpeningBalance(supabase, companyId, fiscalPeriodId)
    } catch (err) {
      log.warn('create_voucher: existing-IB check failed, refusing the IB', {
        fiscalPeriodId,
        error: err instanceof Error ? err.message : String(err),
      })
      return {
        error: 'Det gick inte att kontrollera om räkenskapsåret redan har en ingående balans. Försök igen.',
        status: 500,
      }
    }
    if (existingIb) {
      return {
        error: existingOpeningBalanceMessage(existingIb),
        errorCode: OPENING_BALANCE_EXISTS_CODE,
        status: 409,
      }
    }

    sourceType = 'opening_balance'
  }

  // Optional inbox booking (gnubok_create_voucher with inbox_item_id, the
  // book-direct flow for kvitton). Staging checked the item, but another
  // booking can land between staging and approval: approving a second staged
  // voucher for an item already booked posted a duplicate verifikat
  // (accounted#14). Refused here before anything is posted.
  // A pointer at a reversed verifikat is stale and is replaced (exactly that
  // value); before, such an approval posted a verifikat with no underlag.
  const inboxItemId = params.inbox_item_id as string | undefined
  let replacesEntryId: string | null = null
  if (inboxItemId) {
    const booking = await readInboxItemBookingState(supabase, companyId, inboxItemId)
    if (booking.state === 'error') {
      return { error: 'Det gick inte att läsa underlaget. Försök igen.', status: 500 }
    }
    if (booking.state === 'missing') {
      return { error: `Inbox item ${inboxItemId} not found for this company.`, status: 404 }
    }
    if (booking.state === 'booked') {
      return {
        error: getErrorEntry('INBOX_ITEM_ALREADY_BOOKED')?.message_sv ?? 'Underlaget är redan bokfört.',
        errorCode: 'INBOX_ITEM_ALREADY_BOOKED',
        status: 409,
        data: {
          ...(booking.journal_entry_id ? { journal_entry_id: booking.journal_entry_id } : {}),
          ...(booking.supplier_invoice_id ? { supplier_invoice_id: booking.supplier_invoice_id } : {}),
        },
      }
    }
    replacesEntryId = booking.replaces
  }

  try {
    const entry = await createJournalEntry(
      supabase,
      companyId,
      userId,
      {
        fiscal_period_id: fiscalPeriodId,
        entry_date: entryDate,
        description,
        source_type: sourceType,
        voucher_series: (params.voucher_series as string) || undefined,
        notes: (params.notes as string) || undefined,
        lines,
      },
      // commit_method records HOW it was committed, not who staged it.
      // Web routes pass 'user_accept'/'bulk_accept'; the MCP approve path
      // passes 'api_key'/'agent' so agent-relayed acknowledgments are
      // distinguishable in the immutable layer. The DB CHECK constraint
      // rejects anything else (migrations 20260420120001, 20260618120001).
      opts.commitMethod ?? 'user_accept'
    )

    // Claim the inbox item for this verifikat. Two approvals of different
    // staged ops for the same item can both pass the read above; the
    // compare-and-set lets one keep its verifikat and reverses the other's
    // (storno), so the books never hold the underlag twice. Before the IB
    // link and the document attach: a loser must leave neither behind.
    if (inboxItemId) {
      const claim = await claimInboxItemOrReverseEntry(supabase, companyId, userId, inboxItemId, entry.id, {
        expected: replacesEntryId,
      })
      if (claim.status !== 'claimed') {
        // Posted, then reversed: the voucher number is used, so the op lands
        // in failed_partial carrying the id instead of passing as rejected.
        return {
          error:
            claim.status === 'taken'
              ? 'Underlaget bokfördes samtidigt i en annan verifikation. Verifikationen som skapades här har återförts med en storno.'
              : `Verifikationen kunde inte kopplas till underlaget och har återförts med en storno: ${claim.error.message}`,
          ...(claim.status === 'taken' ? { errorCode: 'INBOX_ITEM_ALREADY_BOOKED' } : {}),
          status: claim.status === 'taken' ? 409 : 500,
          partialPostedIds: { journal_entry_id: entry.id },
        }
      }
    }

    // An IB points its year at itself, like every other IB writer: the
    // correction tools read the pointer, and an IB without one could only be
    // stornoed. The verifikat is posted either way; a failed link is logged.
    if (sourceType === 'opening_balance') {
      const linkError = await linkOpeningBalance(supabase, companyId, fiscalPeriodId, entry.id)
      if (linkError) {
        log.error('audit: create_voucher opening balance posted but the period link failed', {
          audit: true,
          event: 'opening_balance.link_failed',
          companyId,
          fiscalPeriodId,
          entryId: entry.id,
          reason: linkError.message,
        })
      }
    }

    // The OCR document goes onto the verifikat once the claim above is won;
    // a loser returned before this, so it can never shift the winner's
    // underlag. The verifikat is posted and immutable either way: a failed
    // attach is logged, not rolled back.
    const documentId = params.document_id as string | undefined
    if (inboxItemId && documentId) {
      try {
        await linkToJournalEntry(supabase, companyId, documentId, entry.id)
      } catch (linkDocErr) {
        log.warn('Failed to attach inbox document to new voucher', {
          documentId,
          journalEntryId: entry.id,
          error: linkDocErr instanceof Error ? linkDocErr.message : String(linkDocErr),
        })
      }
    }

    return {
      data: {
        journal_entry_id: entry.id,
        voucher_number: entry.voucher_number,
        voucher_series: entry.voucher_series,
        fiscal_period_id: fiscalPeriodId,
        // inbox_linked stays in the result for callers that read it; a
        // committed op with an inbox item has always claimed it now.
        ...(inboxItemId ? { inbox_item_id: inboxItemId, inbox_linked: true } : {}),
      },
    }
  } catch (err) {
    return failUnlessBookkeepingError(err, 'Failed to create voucher', 500)
  }
}

async function commitCorrectEntry(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const entryId = params.entry_id as string
  const lines = normalizeVoucherLines(params.lines)

  if (!entryId || lines.length < 2) {
    return { error: 'entry_id and at least two lines are required', status: 400 }
  }

  // Pre-flight: verify the original is posted and its period is not locked.
  // Falling into correctEntry without this returns a less helpful DB error and
  // half-creates the storno before rolling back; surfacing the Swedish message
  // here matches the period_locked UX everywhere else in the app.
  //
  // Period lock check is two-layer (matches the DB triggers): per-period
  // (is_closed / locked_at) AND company-wide (bookkeeping_locked_through).
  // The staging tool uses resolvePeriodStatusForDate; we reuse it here so the
  // commit-time gate matches the staging-time signal.
  const { data: original, error: origErr } = await supabase
    .from('journal_entries')
    .select('id, status, entry_date, fiscal_period_id, fiscal_periods!journal_entries_fiscal_period_id_fkey!inner(is_closed, locked_at)')
    .eq('id', entryId)
    .eq('company_id', companyId)
    .maybeSingle()

  if (origErr || !original) {
    return { error: 'Verifikationen hittades inte.', status: 404 }
  }
  if (original.status !== 'posted') {
    return {
      error: `Endast bokförda verifikationer kan rättas. Aktuell status: ${original.status}. Drafts redigeras direkt.`,
      status: 409,
    }
  }
  const period = original.fiscal_periods as { is_closed?: boolean; locked_at?: string | null } | { is_closed?: boolean; locked_at?: string | null }[] | null
  const periodRow = Array.isArray(period) ? period[0] : period
  if (periodRow?.is_closed || periodRow?.locked_at) {
    return {
      error: 'Räkenskapsperioden är låst. Öppna perioden eller använd omprövning för redan inlämnade momsdeklarationer.',
      status: 409,
    }
  }
  // resolvePeriodStatusForDate also covers the company-wide bookkeeping_locked_through
  // gate. A DB blip here would otherwise propagate as a 500 with a raw Postgres
  // message; wrap so the caller sees a clean Swedish 500 instead, consistent with
  // the staging-side log-and-degrade behaviour in stagePendingOperation.
  try {
    const periodStatus = await resolvePeriodStatusForDate(supabase, companyId, original.entry_date)
    if (periodStatus.status === 'locked' || periodStatus.status === 'closed') {
      return {
        error: 'Räkenskapsperioden är låst. Öppna perioden eller använd omprövning för redan inlämnade momsdeklarationer.',
        status: 409,
      }
    }
  } catch (err) {
    return {
      error: `Kunde inte verifiera periodstatus: ${err instanceof Error ? err.message : 'okänt fel'}`,
      status: 500,
    }
  }

  try {
    // correctEntry() posts both the storno and the corrected entry into the
    // SAME fiscal_period_id and entry_date as the original (see
    // lib/core/bookkeeping/storno-service.ts:99,102,195,198). So a rättelse
    // made in May 2026 for a December 2025 voucher correctly lands in 2025,
    // keeping that period's balances consistent. The is_closed pre-flight
    // above is what blocks corrections to already-locked periods.
    const result = await correctEntry(supabase, companyId, userId, entryId, lines, {
      // Staged by the MCP tool when the agent explicitly overrode the
      // chain-depth guard; the guard re-checks here so a stale approval of a
      // chain that grew deeper in the meantime still stops.
      allowDeepChain: params.allow_deep_chain === true,
      // The corrected entry's text when the agent gave one; rows staged
      // without it keep correctEntry's "Rättelse: <original text>".
      description: typeof params.description === 'string' ? params.description : undefined,
    })
    return {
      data: {
        original_entry_id: entryId,
        storno_entry_id: result.reversal.id,
        corrected_entry_id: result.corrected.id,
        storno_voucher_number: result.reversal.voucher_number,
        corrected_voucher_number: result.corrected.voucher_number,
      },
    }
  } catch (err) {
    return failUnlessBookkeepingError(err, 'Failed to correct entry', 500)
  }
}

async function commitReverseEntry(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const entryId = params.entry_id as string
  const reversalDate = typeof params.reversal_date === 'string' ? params.reversal_date : undefined

  if (!entryId) {
    return { error: 'entry_id is required', status: 400 }
  }

  // Pre-flight matches commitCorrectEntry: posted + period not closed. Surfaces
  // Swedish messages before reverseEntry() throws less helpful errors. Period
  // lock check is two-layer (per-period + company-wide bookkeeping_locked_through)
  // via resolvePeriodStatusForDate, matching the staging-time signal.
  const { data: original, error: origErr } = await supabase
    .from('journal_entries')
    .select('id, status, entry_date, fiscal_period_id, fiscal_periods!journal_entries_fiscal_period_id_fkey!inner(is_closed, locked_at)')
    .eq('id', entryId)
    .eq('company_id', companyId)
    .maybeSingle()

  if (origErr || !original) {
    return { error: 'Verifikationen hittades inte.', status: 404 }
  }
  if (original.status !== 'posted') {
    return {
      error: `Endast bokförda verifikationer kan makuleras. Aktuell status: ${original.status}.`,
      status: 409,
    }
  }
  const period = original.fiscal_periods as { is_closed?: boolean; locked_at?: string | null } | { is_closed?: boolean; locked_at?: string | null }[] | null
  const periodRow = Array.isArray(period) ? period[0] : period
  if (periodRow?.is_closed || periodRow?.locked_at) {
    return {
      error: 'Räkenskapsperioden är låst. Öppna perioden eller använd omprövning för redan inlämnade momsdeklarationer.',
      status: 409,
    }
  }
  try {
    const periodStatus = await resolvePeriodStatusForDate(supabase, companyId, original.entry_date)
    if (periodStatus.status === 'locked' || periodStatus.status === 'closed') {
      return {
        error: 'Räkenskapsperioden är låst. Öppna perioden eller använd omprövning för redan inlämnade momsdeklarationer.',
        status: 409,
      }
    }
  } catch (err) {
    return {
      error: `Kunde inte verifiera periodstatus: ${err instanceof Error ? err.message : 'okänt fel'}`,
      status: 500,
    }
  }

  try {
    const reversal = await reverseEntry(supabase, companyId, userId, entryId, reversalDate, {
      allowDeepChain: params.allow_deep_chain === true,
    })
    // Invariant per BFL 5 kap 5§: the storno must land in the same fiscal period
    // as the original entry. reverseEntry() at lib/bookkeeping/engine.ts:492 uses
    // original.fiscal_period_id, but assert it here so a future engine change that
    // breaks this invariant fails fast instead of silently shifting period attribution.
    if (reversal.fiscal_period_id !== original.fiscal_period_id) {
      return {
        error: `BFL invariant broken: storno period ${reversal.fiscal_period_id} differs from original ${original.fiscal_period_id}.`,
        status: 500,
      }
    }
    return {
      data: {
        original_entry_id: entryId,
        reversal_entry_id: reversal.id,
        reversal_voucher_number: reversal.voucher_number,
        reversal_voucher_series: reversal.voucher_series,
        fiscal_period_id: reversal.fiscal_period_id,
      },
    }
  } catch (err) {
    return failUnlessBookkeepingError(err, 'Failed to reverse entry', 500)
  }
}

// ── Payroll executors ────────────────────────────────────────────

async function commitCreateSalaryRun(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const periodYear = params.period_year as number
  const periodMonth = params.period_month as number
  const paymentDate = params.payment_date as string
  // Staged by the tool after resolving the avvikelseperiod; absent on
  // operations staged before the columns existed (falls back to the setting).
  const deviationPeriodStart = (params.deviation_period_start as string | null | undefined) ?? undefined
  const deviationPeriodEnd = (params.deviation_period_end as string | null | undefined) ?? undefined
  // The series the approver saw at staging. Absent on operations staged
  // before it was staged: the service then resolves the company's salary
  // series, the same rule.
  const voucherSeries =
    typeof params.voucher_series === 'string' && /^[A-Z]$/.test(params.voucher_series)
      ? params.voucher_series
      : undefined
  if (
    !Number.isInteger(periodYear) ||
    !Number.isInteger(periodMonth) ||
    typeof paymentDate !== 'string'
  ) {
    return { error: 'period_year, period_month, payment_date are required', status: 400 }
  }

  try {
    const { createSalaryRunWithEmployees } = await import('@/lib/salary/create-run')
    const { SalaryDeviationPeriodError } = await import('@/lib/salary/deviation-period')
    try {
      const { run, employeeCount, deviationWindow } = await createSalaryRunWithEmployees(
        supabase,
        companyId,
        userId,
        { periodYear, periodMonth, paymentDate, deviationPeriodStart, deviationPeriodEnd, voucherSeries },
      )
      return {
        data: {
          salary_run_id: (run as { id?: string }).id,
          employee_count: employeeCount,
          period: `${periodYear}-${String(periodMonth).padStart(2, '0')}`,
          deviation_period_start: deviationWindow.start,
          deviation_period_end: deviationWindow.end,
        },
      }
    } catch (err) {
      if (err instanceof SalaryDeviationPeriodError) {
        return {
          error: err.message,
          status: err.code === 'SALARY_RUN_DEVIATION_PERIOD_OVERLAP' ? 409 : 400,
        }
      }
      throw err
    }
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : 'Failed to create salary run',
      status: 500,
    }
  }
}

async function commitLogMileageTrip(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  try {
    const { createTrip } = await import('@/lib/mileage/mileage-service')
    const trip = await createTrip(supabase, companyId, userId, {
      trip_date: params.trip_date as string,
      vehicle_type: params.vehicle_type as never,
      vehicle_registration: (params.vehicle_registration as string) || null,
      odometer_start: (params.odometer_start as number) ?? null,
      odometer_end: (params.odometer_end as number) ?? null,
      distance_km: params.distance_km as number,
      from_location: params.from_location as string,
      to_location: params.to_location as string,
      purpose: params.purpose as string,
      visited: (params.visited as string) || null,
      is_round_trip: params.is_round_trip === true,
      employee_id: (params.employee_id as string) || null,
      notes: (params.notes as string) || null,
      created_via: 'mcp',
    })
    return {
      data: {
        mileage_trip_id: trip.id,
        trip_date: trip.trip_date,
        distance_km: trip.distance_km,
        status: trip.status,
      },
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to log mileage trip'
    // Input-validation failures from the service are permanent for these
    // params: 400 so agents fix the arguments instead of retrying blindly.
    const isValidation = /registreringsnummer|hittades inte/i.test(message)
    return { error: message, status: isValidation ? 400 : 500 }
  }
}

async function commitBookMileagePeriod(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  try {
    const { bookMileagePeriod } = await import('@/lib/mileage/mileage-service')
    const result = await bookMileagePeriod(supabase, companyId, userId, {
      from: params.from as string,
      to: params.to as string,
      entryDate: params.entry_date as string,
      counterAccount: (params.counter_account as string) || null,
      employeeId: (params.employee_id as string) || undefined,
      createdVia: 'mcp',
      // Staged approvals freeze the trip set: what was previewed is exactly
      // what may be booked; drift fails the commit instead of booking blind.
      expectedTripIds: Array.isArray(params.trip_ids)
        ? (params.trip_ids as string[])
        : undefined,
    })
    if (!result.ok) {
      if (result.code === 'NO_TRIPS') {
        return { error: 'No unbooked trips in the selected period', status: 400 }
      }
      if (result.code === 'MIXED_EMPLOYEES') {
        return { error: 'The period spans several employees; book per employee via employee_id', status: 400 }
      }
      if (result.code === 'PERIOD_NOT_OPEN') {
        return { error: 'The entry date falls in a closed or locked period', status: 400 }
      }
      if (result.code === 'COUNTER_ACCOUNT_NOT_ALLOWED') {
        return {
          error: `counter_account must be ${result.allowed.join(' or ')} for these trips; stage it again`,
          status: 400,
        }
      }
      if (result.code === 'TRIPS_CHANGED' || result.code === 'CLAIM_LOST') {
        return {
          error: 'The körjournal changed since this booking was staged; stage it again to get a fresh preview',
          status: 409,
        }
      }
      return {
        error: `Voucher ${result.journalEntryId} was created but trips could not all be linked; review the körjournal before booking again`,
        status: 500,
      }
    }
    return {
      data: {
        journal_entry_id: result.journalEntryId,
        voucher: `${result.voucherSeries ?? ''}${result.voucherNumber ?? ''}`,
        trip_count: result.tripCount,
        total_amount: result.totalAmount,
        summaries: result.summaries,
      },
    }
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : 'Failed to book mileage period',
      status: 500,
    }
  }
}

async function commitGenerateAgi(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const salaryRunId = params.salary_run_id as string
  if (!salaryRunId) return { error: 'salary_run_id is required', status: 400 }

  try {
    const { generateAgiDeclaration } = await import('@/lib/salary/agi/generate-declaration')
    const { randomUUID } = await import('node:crypto')
    const result = await generateAgiDeclaration({
      supabase,
      companyId,
      userId,
      userEmail: null,
      salaryRunId,
      log: createLogger('commit/generate_agi'),
      requestId: randomUUID(),
    })
    if (!result.ok) {
      // generateAgiDeclaration already names what is missing (details.message
      // from assertRequiredCompanyData); the bare code dropped it and the
      // agent could not tell what to fill in (feedback seq 414922).
      const details =
        typeof result.details === 'object' && result.details !== null
          ? (result.details as { message?: unknown; missing_fields?: unknown })
          : {}
      const detailMessage = typeof details.message === 'string' ? details.message : null
      const missingFields = Array.isArray(details.missing_fields)
        ? details.missing_fields.filter((f): f is string => typeof f === 'string')
        : []
      const hint =
        result.code === 'AGI_INCOMPLETE_DATA'
          ? ' Telefon och e-post sätts med gnubok_update_company_settings (sökbart via gnubok_search_tools) eller under Inställningar i webbappen; organisationsnummer ändras under Inställningar i webbappen.'
          : ''
      return {
        error: `AGI-generering misslyckades: ${result.code}${detailMessage ? `: ${detailMessage}` : ''}${hint}`,
        errorCode: result.code,
        status: result.status ?? 500,
        ...(missingFields.length > 0 ? { data: { missing_fields: missingFields } } : {}),
      }
    }
    const period = `${result.periodYear}-${String(result.periodMonth).padStart(2, '0')}`
    return {
      data: {
        agi_declaration_id: result.agiDeclarationId,
        period,
        employee_count: result.employeeCount,
        is_correction: result.isCorrection,
        download_url: `/api/salary/runs/${salaryRunId}/agi/xml`,
      },
    }
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : 'Failed to generate AGI',
      status: 500,
    }
  }
}

async function commitUpdatePayslipLine(
  supabase: SupabaseClient,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const salaryRunId = params.salary_run_id as string
  const lineId = params.salary_line_item_id as string
  const patch = params.patch as Record<string, unknown> | undefined
  if (!salaryRunId || !lineId || !patch || Object.keys(patch).length === 0) {
    return { error: 'salary_run_id, salary_line_item_id and patch are required', status: 400 }
  }

  try {
    const { updatePayslipLine } = await import('@/lib/salary/payslip-lines')
    const result = await updatePayslipLine(supabase, {
      companyId,
      salaryRunId,
      lineId,
      patch: patch as never,
    })
    if (!result.ok) {
      const entry = getErrorEntry(result.code)
      return {
        error: entry?.message_sv ?? `Kunde inte uppdatera lönebeskedsraden: ${result.code}`,
        status: entry?.httpStatus ?? 500,
      }
    }
    return {
      data: {
        salary_line_item_id: lineId,
        salary_run_id: salaryRunId,
        item_type: result.data.item_type,
        description: result.data.description,
        amount: result.data.amount,
      },
    }
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : 'Failed to update payslip line',
      status: 500,
    }
  }
}

async function commitSetRunSalary(
  supabase: SupabaseClient,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const salaryRunId = params.salary_run_id as string
  const employeeId = params.employee_id as string
  const monthlySalary = params.monthly_salary as number | undefined
  const hoursWorked = params.hours_worked as number | undefined
  const hasMonthly = typeof monthlySalary === 'number'
  const hasHours = typeof hoursWorked === 'number'
  if (!salaryRunId || !employeeId || hasMonthly === hasHours) {
    return {
      error: 'salary_run_id, employee_id and exactly one of monthly_salary / hours_worked are required',
      status: 400,
    }
  }

  try {
    const { setRunEmployeeSalary } = await import('@/lib/salary/run-employees')
    const result = await setRunEmployeeSalary(supabase, {
      companyId,
      salaryRunId,
      employeeId,
      ...(hasMonthly ? { monthlySalary } : { hoursWorked }),
    })
    if (!result.ok) {
      const entry = getErrorEntry(result.code)
      return {
        error: entry?.message_sv ?? `Kunde inte sätta månadens lön: ${result.code}`,
        status: entry?.httpStatus ?? 500,
      }
    }
    return {
      data: {
        salary_run_id: salaryRunId,
        salary_run_employee_id: result.data.salary_run_employee_id,
        employee_id: result.data.employee_id,
        previous_monthly_salary: result.data.previous_monthly_salary,
        monthly_salary: result.data.monthly_salary,
        previous_hours_worked: result.data.previous_hours_worked,
        hours_worked: result.data.hours_worked,
      },
    }
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : 'Failed to set run salary',
      status: 500,
    }
  }
}

async function commitUpdateSalaryRun(
  supabase: SupabaseClient,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const salaryRunId = params.salary_run_id as string
  const patch = params.patch as Record<string, unknown> | null | undefined
  if (!salaryRunId || !patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { error: 'salary_run_id and patch are required', status: 400 }
  }

  try {
    const { updateDraftSalaryRun } = await import('@/lib/salary/update-run')
    const result = await updateDraftSalaryRun(supabase, {
      companyId,
      salaryRunId,
      patch: patch as never,
    })
    if (!result.ok) {
      const entry = getErrorEntry(result.code)
      return {
        error: entry?.message_sv ?? `Kunde inte uppdatera lönekörningen: ${result.code}`,
        status: entry?.httpStatus ?? 500,
      }
    }
    return {
      data: {
        salary_run_id: result.data.salary_run_id,
        payment_date: result.data.payment_date,
        voucher_series: result.data.voucher_series,
        notes: result.data.notes,
        changes: result.data.changes,
      },
    }
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : 'Failed to update salary run',
      status: 500,
    }
  }
}

async function commitCreateEmployee(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  try {
    const { createEmployee } = await import('@/lib/salary/employee-commands')
    const result = await createEmployee(supabase, {
      companyId,
      userId,
      input: params as never,
    })
    if (!result.ok) {
      const entry = getErrorEntry(result.code)
      const detailMessage =
        (result.details?.message as string | undefined) ?? entry?.message_sv
      return {
        error: detailMessage ?? `Kunde inte skapa anställd: ${result.code}`,
        status: entry?.httpStatus ?? 500,
      }
    }
    // The summary only: result_data is stored, and the row carries bank and
    // contact details nobody reading the operation needs.
    const { row: _row, ...summary } = result.data
    return { data: summary }
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : 'Failed to create employee',
      status: 500,
    }
  }
}

async function commitUpdateEmployee(
  supabase: SupabaseClient,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const employeeId = params.employee_id as string
  const patch = params.patch as Record<string, unknown> | undefined
  if (!employeeId || !patch) {
    return { error: 'employee_id and patch are required', status: 400 }
  }

  try {
    const { updateEmployee } = await import('@/lib/salary/employee-commands')
    const result = await updateEmployee(supabase, { companyId, employeeId, patch })
    if (!result.ok) {
      const entry = getErrorEntry(result.code)
      const detailMessage =
        (result.details?.message as string | undefined) ?? entry?.message_sv
      return {
        error: detailMessage ?? `Kunde inte uppdatera anställd: ${result.code}`,
        status: entry?.httpStatus ?? 500,
      }
    }
    // The summary only, as for create.
    const { row: _row, previous: _previous, changes: _changes, ...summary } = result.data
    return { data: summary }
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : 'Failed to update employee',
      status: 500,
    }
  }
}

/**
 * The run a register lock names, as a sentence to append to the registry
 * message: the MCP caller only sees `error`, and needs the run id to revert
 * it to draft or make a correction run. Undefined for every other code.
 */
function registerLockDetail(result: { code: string; details?: Record<string, unknown> }): string | undefined {
  if (result.code !== 'SALARY_REGISTER_DATES_LOCKED_BY_RUN' || !result.details) return undefined
  const d = result.details
  const period = `${d.period_year}-${String(d.period_month).padStart(2, '0')}`
  const dates = Array.isArray(d.locked_dates) ? (d.locked_dates as string[]) : []
  const span = dates.length > 1 ? `${dates[0]} till ${dates[dates.length - 1]}` : (dates[0] ?? '')
  return `Lönekörning ${d.salary_run_id} (${period}, ${d.status}) läser ${dates.length} av datumen: ${span}.`
}

async function commitRegisterAbsence(
  supabase: SupabaseClient,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const employeeId = params.employee_id as string
  const from = params.from as string
  const to = params.to as string
  const absenceType = params.absence_type as string
  if (!employeeId || !from || !to || !absenceType) {
    return { error: 'employee_id, from, to and absence_type are required', status: 400 }
  }

  try {
    const { upsertAbsenceRange } = await import('@/lib/salary/absence')
    const result = await upsertAbsenceRange(supabase, {
      companyId,
      employeeId,
      from,
      to,
      absenceType,
      hoursPerDay: (params.hours_per_day as number | undefined) ?? 8,
      notes: (params.notes as string | null | undefined) ?? null,
      includeWeekends: (params.include_weekends as boolean | undefined) ?? false,
    })
    if (!result.ok) {
      // The user-facing message is generic Swedish; without this log the
      // underlying PG error (e.g. the franvaro audit-trigger RLS denial that
      // caused five untraceable 500s, feedback 2026-08-13) leaves no trace.
      // pgDetails, not details: `details` is the logger record's own field
      // for non-object args and would be swallowed by the pretty emitter.
      createLogger('commit/register_absence').error('register_absence commit failed', {
        code: result.code,
        pgDetails: result.details,
        employeeId,
        absenceType,
        from,
        to,
      })
      const entry = getErrorEntry(result.code)
      return {
        error: [entry?.message_sv ?? `Kunde inte registrera frånvaron: ${result.code}`, registerLockDetail(result)]
          .filter(Boolean)
          .join(' '),
        errorCode: result.code,
        status: entry?.httpStatus ?? 500,
      }
    }
    return {
      data: {
        employee_id: employeeId,
        absence_type: absenceType,
        from,
        to,
        day_count: result.data.count,
      },
    }
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : 'Failed to register absence',
      status: 500,
    }
  }
}

async function commitBookSalaryRun(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const salaryRunId = params.salary_run_id as string
  if (!salaryRunId) return { error: 'salary_run_id is required', status: 400 }

  try {
    const { advanceAndBookSalaryRun } = await import('@/lib/salary/book-run')
    const result = await advanceAndBookSalaryRun(supabase, {
      companyId,
      userId,
      salaryRunId,
      log: createLogger('commit/book_salary_run'),
    })
    if (!result.ok) {
      const entry = getErrorEntry(result.code)
      const detail =
        (result.details?.reason as string | undefined) ??
        (Array.isArray(result.details?.employees)
          ? `Saknar beräkning: ${(result.details.employees as string[]).join(', ')}`
          : undefined)
      return {
        error: [entry?.message_sv ?? `Kunde inte bokföra lönekörningen: ${result.code}`, detail]
          .filter(Boolean)
          .join(' '),
        // The agent branches on the code: SALARY_RUN_BOOKING_IN_PROGRESS
        // means wait and re-read the run, not approve again at once. That
        // refusal posted nothing, so the op stays pending for a later
        // approval instead of being auto-rejected as a 409.
        errorCode: result.code,
        status: entry?.httpStatus ?? 500,
        ...(result.code === 'SALARY_RUN_BOOKING_IN_PROGRESS' ? { returnToPending: true } : {}),
      }
    }
    const run = result.data.run as { period_year?: number; period_month?: number; status?: string }
    return {
      data: {
        salary_run_id: salaryRunId,
        status: run.status ?? 'booked',
        period: run.period_year
          ? `${run.period_year}-${String(run.period_month).padStart(2, '0')}`
          : undefined,
        journal_entry_ids: result.data.entryIds,
        nollkorning: result.data.nollkorning,
        warnings: result.data.warnings,
      },
    }
  } catch (err) {
    // Posted vouchers of the run that the booking would not post
    // (SalaryRunPartiallyBookedError): the Swedish message names them, and a
    // retry cannot succeed until they are reversed, so it is not a 500.
    if ((err as { code?: unknown } | null)?.code === 'SALARY_RUN_PARTIALLY_BOOKED') {
      return { error: (err as Error).message, errorCode: 'SALARY_RUN_PARTIALLY_BOOKED', status: 409 }
    }
    return {
      error: err instanceof Error ? err.message : 'Failed to book salary run',
      status: 500,
    }
  }
}

async function commitDeleteAbsence(
  supabase: SupabaseClient,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const employeeId = params.employee_id as string
  const from = params.from as string
  const to = params.to as string
  if (!employeeId || !from || !to) {
    return { error: 'employee_id, from and to are required', status: 400 }
  }

  try {
    const { deleteAbsenceRange } = await import('@/lib/salary/absence')
    const result = await deleteAbsenceRange(supabase, {
      companyId,
      employeeId,
      from,
      to,
      absenceType: (params.absence_type as string | undefined) || undefined,
    })
    if (!result.ok) {
      // Same diagnosability treatment as commitRegisterAbsence: keep the PG
      // error in the logs and the registry code on the op row.
      createLogger('commit/delete_absence').error('delete_absence commit failed', {
        code: result.code,
        pgDetails: result.details,
        employeeId,
        from,
        to,
      })
      const entry = getErrorEntry(result.code)
      return {
        error: [entry?.message_sv ?? `Kunde inte ta bort frånvaron: ${result.code}`, registerLockDetail(result)]
          .filter(Boolean)
          .join(' '),
        errorCode: result.code,
        status: entry?.httpStatus ?? 500,
      }
    }
    return {
      data: {
        employee_id: employeeId,
        from,
        to,
        absence_type: (params.absence_type as string | undefined) ?? null,
        deleted_count: result.data.deleted_count,
      },
    }
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : 'Failed to delete absence',
      status: 500,
    }
  }
}

async function commitSetEmployeeOpeningBalances(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const items = params.items as Array<Record<string, unknown>> | undefined
  if (!items || !Array.isArray(items) || items.length === 0) {
    return { error: 'items are required', status: 400 }
  }

  try {
    const parsed = OpeningBalancesBulkSchema.safeParse({ items })
    if (!parsed.success) {
      return { error: 'Ogiltiga ingående saldon i den godkända operationen', status: 400 }
    }
    const { setOpeningBalancesBulk } = await import('@/lib/salary/opening-balances')
    const result = await setOpeningBalancesBulk(supabase, {
      companyId,
      userId,
      items: parsed.data.items,
    })
    if (!result.ok) {
      const itemSummary = result.itemErrors
        ?.map((e) => `${e.employee_id}: ${e.message}`)
        .join('; ')
      const entry = getErrorEntry(result.code)
      return {
        error: itemSummary ?? entry?.message_sv ?? `Kunde inte spara ingående saldon: ${result.code}`,
        status: entry?.httpStatus ?? 400,
      }
    }
    return {
      data: {
        employee_count: result.data.count,
        employee_opening_balances_ids: result.data.rows.map((r) => r.employee_opening_balances_id),
      },
    }
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : 'Failed to set opening balances',
      status: 500,
    }
  }
}

async function commitVacationYearClose(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const yearStart = params.vacation_year_start as string
  if (!yearStart) return { error: 'vacation_year_start is required', status: 400 }
  const bookAdjustment = params.book_adjustment !== false

  try {
    const { commitVacationYearClose: runClose } = await import('@/lib/salary/semesterberedning')
    const result = await runClose(supabase, companyId, userId, yearStart, { bookAdjustment })
    if (!result.ok) {
      const entry = getErrorEntry(result.code)
      return {
        error: entry?.message_sv ?? `Semesterårsavslutet misslyckades: ${result.code}`,
        status: entry?.httpStatus ?? 500,
      }
    }
    return {
      data: {
        vacation_year_closure_id: result.data.closure_id,
        adjustment_entry_id: result.data.adjustment_entry_id,
        vacation_year_start: yearStart,
        employee_count: result.data.report.rows.length,
        drift_2920: result.data.report.sek.drift_2920,
      },
    }
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : 'Failed to close vacation year',
      status: 500,
    }
  }
}

// ── Skatteverket filing commit handlers (PR5) ─────────────────────
//
// Core cannot import @/extensions (CI guard), so these reach the Skatteverket
// extension only through the registry-resolved `services` channel. The service
// runs the SKV chain and returns a SkvSubmitResult (shared shape in
// ./skatteverket-commit). A recoverable failure throws SkatteverketRecoverable-
// Error, which the dispatcher catch releases back to 'pending'; a non-recoverable
// failure becomes a plain { error, status } that rejects the op.

/**
 * Resolve the Skatteverket extension's services and require the given keys
 * to be wired. Extension absent or not wired is recoverable: the op is left
 * pending so a re-enable + re-approve works without re-staging.
 */
async function requireSkatteverketServices<T extends object>(keys: ReadonlyArray<keyof T>): Promise<T> {
  const services = (await extensionRegistry.get('skatteverket'))?.services as Partial<T> | undefined
  if (!services || keys.some((key) => !services[key])) {
    throw new SkatteverketRecoverableError(
      'Skatteverket-integrationen är inte tillgänglig.',
      'EXTENSION_DISABLED',
      503,
    )
  }
  return services as T
}

function getSkatteverketServices(): Promise<SkatteverketCommitServices> {
  return requireSkatteverketServices<SkatteverketCommitServices>(['commitSubmitVatDeclaration', 'commitSubmitAgi'])
}

function handleSkvSubmitResult(result: SkvSubmitResult): ExecutorResult {
  if (!result.ok) {
    if (result.recoverable) {
      throw new SkatteverketRecoverableError(maskPersonnummerInText(result.error), result.code, result.http_status)
    }
    // Skatteverket's own answer (e.g. the AGI kontrollrapport) rides along as
    // failure details: persisted in result_data.details and returned to the
    // approver, personnummer masked. Without it a rejection said only that
    // Skatteverket refused, not which field (agent feedback seq 948847).
    const details =
      result.details && Object.keys(result.details).length > 0
        ? maskPersonnummerDeep(result.details)
        : undefined
    return {
      error: maskPersonnummerInText(result.error),
      status: result.http_status,
      errorCode: result.code,
      ...(details ? { data: details } : {}),
    }
  }
  const data: Record<string, unknown> = { ...result, status: 'awaiting_signature' }
  delete data.ok
  return { data }
}

async function commitSubmitVatDeclaration(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>,
): Promise<ExecutorResult> {
  if (!params.period_type || !params.year || !params.period) {
    return { error: 'period_type, year och period krävs', status: 400 }
  }
  const services = await getSkatteverketServices()
  const result = await services.commitSubmitVatDeclaration(supabase, userId, companyId, params)
  return handleSkvSubmitResult(result)
}

async function commitSubmitAgi(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>,
): Promise<ExecutorResult> {
  if (!params.salary_run_id) {
    return { error: 'salary_run_id krävs', status: 400 }
  }
  const services = await getSkatteverketServices()
  const result = await services.commitSubmitAgi(supabase, userId, companyId, params)
  return handleSkvSubmitResult(result)
}

// ── Skattekonto row booking commit handler ────────────────────────
//
// Commit side of the staged book_skattekonto_row / book_skattekonto_rows MCP
// ops. The booking logic lives in the skatteverket extension
// (lib/skattekonto-booking.ts, same helper the HTTP bokfor-batch route uses),
// so this reaches it through the registry-resolved `services` channel exactly
// like the filing handlers above. Separate getter: the booking service must
// work (or fail recoverable) independently of the SKV filing services.

function getSkattekontoBookingService(): Promise<SkattekontoBookingCommitService> {
  return requireSkatteverketServices<SkattekontoBookingCommitService>(['commitBookSkattekontoRows'])
}

async function commitBookSkattekontoRows(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>,
): Promise<ExecutorResult> {
  // Accept both staged shapes: the single-row op stores { transaction_id },
  // the batch op stores { ids }. Normalised to one id list for the service.
  const ids = Array.isArray(params.ids)
    ? params.ids.filter((v): v is string => typeof v === 'string' && v.length > 0)
    : typeof params.transaction_id === 'string' && params.transaction_id.length > 0
      ? [params.transaction_id]
      : []
  if (ids.length === 0) {
    return { error: 'ids (eller transaction_id) krävs', status: 400 }
  }
  // Rows approved for booking although the ledger already holds a verifikat
  // for the event: the batch op stores allow_duplicate_ids, the single-row op
  // allow_duplicate, both with the duplicate_reason the verifikat notes
  // carry. Without a reason the service keeps the guard on.
  const allowDuplicateIds = Array.isArray(params.allow_duplicate_ids)
    ? params.allow_duplicate_ids.filter((v): v is string => typeof v === 'string' && v.length > 0)
    : params.allow_duplicate === true
      ? ids
      : []
  const duplicateReason = typeof params.duplicate_reason === 'string' ? params.duplicate_reason : null

  const services = await getSkattekontoBookingService()
  const result = await services.commitBookSkattekontoRows(supabase, userId, companyId, {
    ids,
    ...(allowDuplicateIds.length > 0 ? { allow_duplicate_ids: allowDuplicateIds } : {}),
    ...(allowDuplicateIds.length > 0 && duplicateReason ? { duplicate_reason: duplicateReason } : {}),
  })
  if (!result.ok) {
    if (result.recoverable) {
      throw new SkatteverketRecoverableError(result.error, result.code, result.http_status)
    }
    return { error: result.error, status: result.http_status, errorCode: result.code }
  }

  if (result.summary.succeeded === 0) {
    // Nothing was booked: reject (consume) the op with the per-row reasons in
    // result_data so the user fixes the rows (unignore, unlock period, add a
    // rule) and re-stages. 409: the dominant causes are state conflicts
    // (already booked / ignored / unsettled).
    const firstError = result.results.find((r) => !r.ok)
    return {
      error: firstError?.error_message ?? 'Ingen skattekontorad kunde bokföras.',
      status: 409,
      data: { results: result.results, summary: result.summary },
    }
  }

  log.info('book_skattekonto_rows committed', {
    companyId,
    operationType: 'book_skattekonto_rows',
    total: result.summary.total,
    succeeded: result.summary.succeeded,
    failed: result.summary.failed,
  })
  return { data: { results: result.results, summary: result.summary } }
}

// The multi-transaction bookings (the batch allocation, the bulk booking and
// the link to an existing verifikat) run their operations
// (commitRegisteredOperation), the same run() as v1 and the dashboard.

/**
 * Bulk-book selected Underlag (Dokumentinkorgen): Lena-driven flow. Each
 * selected inbox item is booked against its matched bank transaction using one
 * shared category + VAT treatment. The booking, VAT (incl. reverse charge), and
 * underlag→verifikat propagation are the SAME shared core the single-item
 * categorize path uses (categorizeMatchedTransaction). Items that can't be
 * booked are skipped with a reason rather than failing the whole batch: the
 * "Bokför valda hoppar över" contract. A per-item throw (e.g. period locked,
 * accounts not in chart) is caught and recorded as a skip so one bad underlag
 * never blocks the rest.
 */
async function commitBulkBookInboxItems(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const parsed = BulkBookInboxSchema.safeParse(params)
  if (!parsed.success) {
    return { error: `Invalid bulk_book_inbox_items params: ${parsed.error.message}`, status: 400 }
  }

  const { booked, skipped } = await bulkBookMatchedInboxItems(supabase, userId, companyId, parsed.data)

  log.info('bulk_book_inbox_items committed', {
    companyId,
    operationType: 'bulk_book_inbox_items',
    requested: parsed.data.item_ids.length,
    bookedCount: booked.length,
    skippedCount: skipped.length,
  })

  return {
    data: {
      booked_count: booked.length,
      skipped_count: skipped.length,
      booked,
      skipped,
    },
  }
}

/**
 * reconciliation_match: link the staged pairs on one account through the
 * same service the page and the v1 API use. Every pair is re-validated at
 * commit time (row still open, entry still posted and unlinked, amounts
 * close); partial success is reported in data.applied / data.skipped rather
 * than failing the whole operation, because the pairs are independent. A
 * bank 1:N pair (one row, several verifikat, allocations) is staged as one
 * pair and re-validated as one all-or-nothing split. A skattekonto pair
 * staged with allow_remainder (rows against a summarised verifikat) keeps the
 * flag, so the reviewer's approval of the previewed remainder is what links it.
 * A pair without an outside row (verifikat settled against each other,
 * crm#1074) is staged with empty external_ids and comes back in data.settled.
 */
async function commitReconciliationMatch(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const accountKey = params.account_key as string | undefined
  const pairs = params.pairs as
    | Array<{
        external_ids: string[]
        journal_entry_ids: string[]
        allocations?: Array<{ journal_entry_id: string; amount: number }>
        allow_remainder?: boolean
      }>
    | undefined
  if (!accountKey || !Array.isArray(pairs) || pairs.length === 0) {
    return { error: 'account_key and pairs are required', status: 400 }
  }
  const result = await matchPairs(supabase, companyId, userId, accountKey, { pairs }, { dryRun: false })
  if (!result) {
    return { error: `Unknown account_key ${accountKey}`, status: 404 }
  }
  const settled = result.settled ?? []
  if (result.applied.length + settled.length === 0) {
    return {
      error: `Ingen koppling kunde göras: ${result.skipped.map((s) => s.code).join(', ')}`,
      errorCode: result.skipped[0]?.code,
      status: 409,
      data: { account_key: accountKey, applied: result.applied, skipped: result.skipped },
    }
  }
  return {
    data: {
      account_key: accountKey,
      applied: result.applied,
      skipped: result.skipped,
      applied_count: result.applied.length,
      skipped_count: result.skipped.length,
      // Only when the operation settled verifikat against each other.
      ...(settled.length > 0 ? { settled, settled_count: settled.length } : {}),
    },
  }
}

/** reconciliation_unmatch: clear one link. The verifikat is untouched. */
async function commitReconciliationUnmatch(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const accountKey = params.account_key as string | undefined
  const externalId = params.external_id as string | undefined
  if (!accountKey || !externalId) {
    return { error: 'account_key and external_id are required', status: 400 }
  }
  try {
    const result = await unmatchLink(supabase, companyId, userId, accountKey, externalId)
    if (!result) return { error: `Unknown account_key ${accountKey}`, status: 404 }
    return { data: { account_key: accountKey, ...result } }
  } catch (err) {
    const code = (err as { code?: string }).code
    return {
      error: err instanceof Error ? err.message : String(err),
      errorCode: code,
      status: code === 'TRANSACTION_NOT_FOUND' ? 404 : 400,
    }
  }
}

/** reconciliation_signoff: "avstämt t.o.m." on one account; policy in lib/reconciliation/signoff.ts. */
async function commitReconciliationSignoff(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const accountKey = params.account_key as string | undefined
  const throughDate = params.through_date as string | undefined
  if (!accountKey || !throughDate) {
    return { error: 'account_key and through_date are required', status: 400 }
  }
  try {
    const result = await signOffAccount(
      supabase,
      companyId,
      userId,
      accountKey,
      {
        through_date: throughDate,
        note: (params.note as string | null | undefined) ?? null,
        force: params.force === true,
        external_balance: typeof params.external_balance === 'number' ? params.external_balance : null,
      },
      { dryRun: false },
    )
    if (!result) return { error: `Unknown account_key ${accountKey}`, status: 404 }
    if (result.dry_run) return { error: 'Unexpected dry-run result', status: 500 }
    return { data: { account_key: accountKey, signoff: result.signoff } }
  } catch (err) {
    const code = (err as { code?: string }).code
    return {
      error: err instanceof Error ? err.message : String(err),
      errorCode: code,
      status: code === 'SIGNOFF_NOT_FOUND' ? 404 : code === 'ALREADY_SIGNED_OFF' || code === 'SIGNOFF_RACE' ? 409 : 400,
    }
  }
}

/**
 * reconciliation_residual: book the remainder of a bank selection as a small
 * fee / interest / rounding verifikat and link the selection, through the same
 * service the page and the v1 API use (lib/reconciliation/residual.ts). The
 * amount and direction are recomputed at commit time; a refusal (grown past
 * the cap, rows linked meanwhile, locked period) leaves nothing half done.
 */
async function commitReconciliationResidual(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const accountKey = params.account_key as string | undefined
  const externalIds = params.external_ids as string[] | undefined
  const journalEntryId = params.journal_entry_id as string | undefined
  const kind = params.kind as 'bank_fee' | 'rounding' | 'interest_income' | 'interest_expense' | undefined
  if (!accountKey || !Array.isArray(externalIds) || externalIds.length === 0 || !journalEntryId || !kind) {
    return { error: 'account_key, external_ids, journal_entry_id and kind are required', status: 400 }
  }
  try {
    const result = await bookResidualAndLink(
      supabase,
      companyId,
      userId,
      accountKey,
      {
        external_ids: externalIds,
        journal_entry_id: journalEntryId,
        kind,
        entry_date: (params.entry_date as string | undefined) ?? undefined,
        description: (params.description as string | undefined) ?? undefined,
      },
      { dryRun: false },
    )
    if (!result) return { error: `Unknown account_key ${accountKey}`, status: 404 }
    if (result.dry_run) return { error: 'Unexpected dry-run result', status: 500 }
    return {
      data: {
        account_key: accountKey,
        residual_journal_entry_id: result.residual_journal_entry_id,
        residual_amount: result.residual_amount,
        applied: result.applied,
        skipped: result.skipped,
      },
    }
  } catch (err) {
    if (err instanceof ReconciliationResidualError) {
      return {
        error: err.message,
        errorCode: err.code,
        status: err.code === 'RESIDUAL_ROWS_NOT_FOUND' || err.code === 'RESIDUAL_ENTRY_NOT_FOUND' ? 404 : 400,
      }
    }
    throw err
  }
}

// ── Public dispatcher ────────────────────────────────────────────

/**
 * Execute a pending_operation by type, update its status row, and return a
 * normalized CommitResult.
 *
 * Used by every approval path (web single and bulk approval, MCP-relayed
 * approval). Status row transitions are applied here so they stay consistent.
 *
 * When opts.actor is set, the entire executor runs inside a runWithActor()
 * scope so EVERY journal-entry commit the operation makes (regardless of
 * which entry generator produced it) carries actor attribution into
 * journal_entries.committed_actor_* and the audit_log COMMIT row via
 * commitEntry() → commit_journal_entry RPC (migration 20260619120000).
 */
export async function commitPendingOperation(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  pendingOp: PendingOperation,
  opts: CommitOptions = {}
): Promise<CommitResult> {
  // The operation id rides along for suggestion_log.pending_operation_id.
  const run = () =>
    runInOperationCommit(pendingOp.id, () => commitPendingOperationInner(supabase, userId, companyId, pendingOp, opts))
  return opts.actor ? runWithActor(opts.actor, run) : run()
}

async function commitPendingOperationInner(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  pendingOp: PendingOperation,
  opts: CommitOptions = {}
): Promise<CommitResult> {
  // ── Kontantmetoden cut-off suspension (#3440). The cut-off as built declares
  //    unpaid-invoice moms a second time when the invoice is paid next year.
  //    Refused HERE, before the atomic claim and before any read or write, for
  //    the same reason as the gates below: a refused op must stay 'pending'
  //    (not consumed), so it is still there when the fix decides what to do
  //    with it. The staging door reads the same switch.
  if (
    pendingOp.operation_type === 'post_kontantmetod_cutoff' &&
    isKontantmetodCutoffSuspended()
  ) {
    return {
      status: 'failed',
      error: kontantmetodCutoffSuspendedMessageSv(),
      http_status: getErrorEntry(KONTANTMETOD_CUTOFF_SUSPENDED_CODE)?.httpStatus ?? 409,
      code: KONTANTMETOD_CUTOFF_SUSPENDED_CODE,
      operation_status: 'pending',
    }
  }

  // ── Web-only approvals (collections). Handing an invoice over and
  //    escalating a case rest on a person's own word (attestations, the
  //    bank check they saw); an agent may stage them but only a person
  //    approving in the web UI commits them. Refused before the claim, so
  //    the op stays 'pending' for that person.
  if (
    requiresWebApproval(pendingOp.operation_type, pendingOp.params) &&
    !(opts.commitMethod === 'user_accept' && opts.actor?.type === 'user')
  ) {
    return {
      status: 'failed',
      error: getErrorEntry('COLLECTION_ATTESTATION_WEB_ONLY')?.message_sv ?? 'Det här måste godkännas av en person i Accounted.',
      http_status: 403,
      code: 'COLLECTION_ATTESTATION_WEB_ONLY',
      operation_status: 'pending',
    }
  }

  // ── The daily collections batch: an administrator approves it, and the
  //    batch's start gates must still say yes. Refused before the claim, so
  //    the batch stays 'pending' (the ladder cron rejects it after 72 hours).
  if (pendingOp.operation_type === COLLECTIONS_BATCH_TYPE) {
    const refused = await batchApprovalRefusal(supabase, companyId)
    if (refused) {
      return {
        status: 'failed',
        error: refused.messageSv,
        http_status: refused.status,
        code: refused.code,
        operation_status: 'pending',
      }
    }
  }

  // ── Capability gate (commit-time twin of the MCP dispatch gate). The actual
  //    external-service call (email / Skatteverket submit) happens below, so
  //    this is the true paid chokepoint: it also catches an op STAGED during
  //    the trial then approved AFTER the grant expired, regardless of caller
  //    (MCP approve tool or the UI approval path). Checked BEFORE the atomic
  //    claim so a blocked op stays 'pending' and is re-approvable once the
  //    company subscribes. Self-hosted is all-on in hasCapability except the
  //    connector capabilities without own credentials (see lib/entitlements).
  const requiredCapability = PAID_OPERATION_CAPABILITY_MAP[pendingOp.operation_type]
  if (requiredCapability && !(await hasCapability(supabase, companyId, requiredCapability))) {
    return {
      status: 'failed',
      // Via capabilityBlockedError so the self-host variant applies (the
      // hosted constant upsells a subscription a self-host cannot buy).
      error: capabilityBlockedError(requiredCapability).message_sv,
      http_status: 403,
      code: 'capability_blocked',
      operation_status: 'pending',
    }
  }

  // ── Approval-authority ceiling: what this API key may finish unattended.
  //
  //    Checked HERE, before the atomic claim, for the same reason the
  //    capability gate above is: a refused op must stay 'pending' so a human
  //    can still approve it in /pending. Inside the claim it would fall into
  //    the generic catch below, which marks the op terminal 'rejected' with no
  //    code and consumes the staged verifikat, which is unrecoverable: the
  //    agent must rebuild the whole booking to try again.
  //
  //    Cannot fire for a human: exceedsUnattendedLimit requires
  //    actor.type === 'api_key' AND a positive limit on that key. In-app
  //    approvals pass {type:'user'}, cron passes 'cron', and the
  //    cookie-session routes commit with no actor at all.
  const unattended = exceedsUnattendedLimit({
    actorType: opts.actor?.type,
    limit: opts.actor?.unattendedCommitLimit,
    operationType: pendingOp.operation_type,
    previewData: pendingOp.preview_data,
  })
  if (unattended.exceeded) {
    return {
      status: 'failed',
      error:
        getErrorEntry('UNATTENDED_COMMIT_LIMIT_EXCEEDED')?.message_sv ??
        'Beloppet \u00f6verstiger vad den h\u00e4r API-nyckeln f\u00e5r bokf\u00f6ra utan m\u00e4nskligt godk\u00e4nnande.',
      http_status: 403,
      code: 'UNATTENDED_COMMIT_LIMIT_EXCEEDED',
      operation_status: 'pending',
      unattended_limit: {
        attempted: unattended.attempted as number,
        limit: unattended.limit as number,
      },
    }
  }

  // ── Atomic claim: flip status pending → committing in a single conditional
  //    update. If 0 rows are affected, another caller (two parallel approvals,
  //    e.g. web and MCP) already claimed this op and we
  //    must not run side-effects. Without this, both callers can pass the
  //    in-memory status check and double-book journal entries, send duplicate
  //    emails, etc.
  //    updated_at is the claim's own time on the database clock (the
  //    update_updated_at_column trigger): the decision receipt below records
  //    only vouchers posted from then on.
  const { data: claimed, error: claimError } = await supabase
    .from('pending_operations')
    .update({ status: 'committing' })
    .eq('id', pendingOp.id)
    .eq('status', 'pending')
    .select('id, updated_at')
    .maybeSingle()

  if (claimError) {
    log.error('Failed to claim pending_operation:', claimError)
    return { status: 'failed', error: 'Failed to claim operation', http_status: 500 }
  }
  if (!claimed) {
    return {
      status: 'failed',
      error: 'Operation already claimed or resolved by another caller',
      http_status: 409,
    }
  }

  let result: ExecutorResult
  try {
    switch (pendingOp.operation_type) {
      case 'categorize_transaction':
        result = await commitCategorizeTransaction(supabase, userId, companyId, pendingOp.params)
        break
      case 'create_customer':
        result = await commitCreateCustomer(supabase, userId, companyId, pendingOp.params)
        break
      case 'update_customer':
        result = await commitUpdateCustomer(supabase, userId, companyId, pendingOp.params)
        break
      case 'update_invoice':
        result = await commitUpdateInvoice(supabase, companyId, pendingOp.params)
        break
      case 'create_recurring_schedule':
        result = await commitCreateRecurringSchedule(supabase, userId, companyId, pendingOp.params)
        break
      case 'update_recurring_schedule':
        result = await commitUpdateRecurringSchedule(supabase, companyId, pendingOp.params)
        break
      case 'create_article':
        result = await commitCreateArticle(supabase, userId, companyId, pendingOp.params)
        break
      case 'update_article':
        result = await commitUpdateArticle(supabase, userId, companyId, pendingOp.params)
        break
      case 'create_supplier':
        result = await commitCreateSupplier(supabase, userId, companyId, pendingOp.params)
        break
      case 'arkiv_propose_fact':
        result = await commitArkivProposeFact(supabase, userId, companyId, pendingOp.params)
        break
      case 'ignore_transaction':
        result = await commitIgnoreTransaction(supabase, companyId, pendingOp.params, userId)
        break
      case 'create_sales_order':
        result = await commitCreateSalesOrder(supabase, userId, companyId, pendingOp.params)
        break
      case 'transition_sales_order':
        result = await commitTransitionSalesOrder(supabase, companyId, pendingOp.params)
        break
      case 'register_sales_order_delivery':
        result = await commitRegisterSalesOrderDelivery(supabase, companyId, pendingOp.params)
        break
      case 'create_invoice_from_sales_order':
        result = await commitCreateInvoiceFromSalesOrder(supabase, userId, companyId, pendingOp.params)
        break
      case 'create_dimension_value':
        result = await commitCreateDimensionValue(supabase, userId, companyId, pendingOp.params)
        break
      case 'retag_line_dimensions':
        result = await commitRetagLineDimensions(supabase, userId, companyId, pendingOp.params)
        break
      case 'create_invoice':
        result = isRegisterBookedInvoiceParams(pendingOp.params)
          ? await commitRegisterBookedInvoice(supabase, userId, companyId, pendingOp.params)
          : await commitCreateInvoice(supabase, userId, companyId, pendingOp.params)
        break
      case 'create_transaction':
        result = await commitCreateTransaction(supabase, userId, companyId, pendingOp.params, pendingOp.id)
        break
      case 'mark_invoice_paid':
        result = await commitMarkInvoicePaid(supabase, userId, companyId, pendingOp.params)
        break
      case 'send_invoice':
        result = await commitSendInvoice(supabase, userId, companyId, pendingOp.params, opts.userEmail)
        break
      case 'mark_invoice_sent':
        result = await commitMarkInvoiceSent(supabase, userId, companyId, pendingOp.params)
        break
      case 'match_transaction_invoice':
        result = await commitMatchTransactionInvoice(supabase, userId, companyId, pendingOp.params)
        break
      case 'settle_rot_rut_payout':
        result = await commitSettleRotRutPayout(supabase, userId, companyId, pendingOp.params)
        break
      case 'link_rot_rut_payout_voucher':
        result = await commitLinkRotRutPayoutVoucher(supabase, companyId, pendingOp.params)
        break
      case 'link_invoice_voucher':
        result = await commitLinkInvoiceVoucher(supabase, userId, companyId, pendingOp.params)
        break
      case 'link_supplier_invoice_voucher':
        result = await commitLinkSupplierInvoiceVoucher(supabase, userId, companyId, pendingOp.params)
        break
      case 'close_period':
        result = await commitClosePeriod(supabase, userId, companyId, pendingOp.params)
        break
      case 'lock_period':
        result = await commitLockPeriod(supabase, userId, companyId, pendingOp.params)
        break
      case 'uncategorize_transaction':
        result = await commitUncategorizeTransaction(supabase, userId, companyId, pendingOp.params)
        break
      case 'link_document_to_voucher':
        result = await commitLinkDocumentToVoucher(supabase, userId, companyId, pendingOp.params)
        break
      case 'link_documents_to_vouchers':
        result = await commitLinkDocumentsToVouchers(supabase, userId, companyId, pendingOp.params)
        break
      case 'run_year_end':
        result = await commitRunYearEnd(supabase, userId, companyId, pendingOp.params)
        break
      case 'post_kontantmetod_cutoff':
        result = await commitPostKontantmetodCutoff(
          supabase,
          userId,
          companyId,
          pendingOp.params,
        )
        break
      case 'set_opening_balances':
        result = await commitSetOpeningBalances(supabase, userId, companyId, pendingOp.params)
        break
      case 'run_currency_revaluation':
        result = await commitRunCurrencyRevaluation(supabase, userId, companyId, pendingOp.params)
        break
      case 'explain_voucher_gap':
        result = await commitExplainVoucherGap(supabase, userId, companyId, pendingOp.params)
        break
      case 'approve_supplier_invoice':
        result = await commitApproveSupplierInvoice(supabase, userId, companyId, pendingOp.params)
        break
      case 'create_supplier_invoice_from_inbox':
        result = isRegisterBookedInvoiceParams(pendingOp.params)
          ? await commitRegisterBookedSupplierInvoice(supabase, userId, companyId, pendingOp.params)
          : await commitCreateSupplierInvoiceFromInbox(supabase, userId, companyId, pendingOp.params)
        break
      case 'credit_supplier_invoice':
        result = await commitCreditSupplierInvoice(supabase, userId, companyId, pendingOp.params)
        break
      case 'convert_invoice':
        result = await commitConvertInvoice(supabase, userId, companyId, pendingOp.params)
        break
      case 'credit_invoice':
        result = await commitCreditInvoice(supabase, userId, companyId, pendingOp.params)
        break
      case 'delete_draft_invoice':
        result = await commitDeleteDraftInvoice(supabase, userId, companyId, pendingOp.params)
        break
      case 'revoke_service_account':
        result = await commitRevokeServiceAccount(userId, companyId, pendingOp.params)
        break
      case 'import_sie':
        result = await commitImportSie(supabase, userId, companyId, pendingOp.params)
        break
      case 'create_voucher':
        result = await commitCreateVoucher(supabase, userId, companyId, pendingOp.params, opts)
        break
      case 'correct_entry':
        result = await commitCorrectEntry(supabase, userId, companyId, pendingOp.params)
        break
      case 'reverse_entry':
        result = await commitReverseEntry(supabase, userId, companyId, pendingOp.params)
        break
      case 'post_annual_depreciation':
        result = await commitPostAnnualDepreciation(supabase, userId, companyId, pendingOp.params)
        break
      case 'create_asset':
        result = await commitCreateAsset(supabase, userId, companyId, pendingOp.params)
        break
      case 'update_asset':
        result = await commitUpdateAsset(supabase, companyId, pendingOp.params)
        break
      case 'dispose_asset':
        result = await commitDisposeAsset(supabase, userId, companyId, pendingOp.params)
        break
      case 'create_salary_run':
        result = await commitCreateSalaryRun(supabase, userId, companyId, pendingOp.params)
        break
      case 'log_mileage_trip':
        result = await commitLogMileageTrip(supabase, userId, companyId, pendingOp.params)
        break
      case 'book_mileage_period':
        result = await commitBookMileagePeriod(supabase, userId, companyId, pendingOp.params)
        break
      case 'generate_agi':
        result = await commitGenerateAgi(supabase, userId, companyId, pendingOp.params)
        break
      case 'update_payslip_line':
        result = await commitUpdatePayslipLine(supabase, companyId, pendingOp.params)
        break
      case 'set_run_salary':
        result = await commitSetRunSalary(supabase, companyId, pendingOp.params)
        break
      case 'update_salary_run':
        result = await commitUpdateSalaryRun(supabase, companyId, pendingOp.params)
        break
      case 'register_absence':
        result = await commitRegisterAbsence(supabase, companyId, pendingOp.params)
        break
      case 'book_salary_run':
        result = await commitBookSalaryRun(supabase, userId, companyId, pendingOp.params)
        break
      case 'delete_absence':
        result = await commitDeleteAbsence(supabase, companyId, pendingOp.params)
        break
      case 'create_employee':
        result = await commitCreateEmployee(supabase, userId, companyId, pendingOp.params)
        break
      case 'update_employee':
        result = await commitUpdateEmployee(supabase, companyId, pendingOp.params)
        break
      case 'set_employee_opening_balances':
        result = await commitSetEmployeeOpeningBalances(supabase, userId, companyId, pendingOp.params)
        break
      case 'vacation_year_close':
        result = await commitVacationYearClose(supabase, userId, companyId, pendingOp.params)
        break
      case 'bulk_book_inbox_items':
        result = await commitBulkBookInboxItems(supabase, userId, companyId, pendingOp.params)
        break
      case 'reconciliation_match':
        result = await commitReconciliationMatch(supabase, userId, companyId, pendingOp.params)
        break
      case 'reconciliation_unmatch':
        result = await commitReconciliationUnmatch(supabase, userId, companyId, pendingOp.params)
        break
      case 'reconciliation_signoff':
        result = await commitReconciliationSignoff(supabase, userId, companyId, pendingOp.params)
        break
      case 'reconciliation_residual':
        result = await commitReconciliationResidual(supabase, userId, companyId, pendingOp.params)
        break
      case 'book_skattekonto_row':
      case 'book_skattekonto_rows':
        result = await commitBookSkattekontoRows(supabase, userId, companyId, pendingOp.params)
        break
      case 'submit_vat_declaration':
        result = await commitSubmitVatDeclaration(supabase, userId, companyId, pendingOp.params)
        break
      case 'submit_agi':
        result = await commitSubmitAgi(supabase, userId, companyId, pendingOp.params)
        break
      case 'collections_daily_batch': {
        const batch = await commitCollectionsDailyBatch({
          supabase,
          userId,
          userLabel: opts.userEmail ?? opts.actor?.label ?? null,
          companyId,
          operation: { id: pendingOp.id, params: pendingOp.params },
        })
        result = batch.ok
          ? { data: batch.data as unknown as Record<string, unknown> }
          : { error: batch.message, errorCode: batch.code, status: batch.status }
        break
      }
      default: {
        // Operations defined once in lib/operations run through the same
        // run() the v1 and MCP doors use; everything else is unknown.
        const operation = operationForPendingType(pendingOp.operation_type)
        if (!operation) {
          return {
            status: 'failed',
            error: `Unknown operation type: ${pendingOp.operation_type}`,
            http_status: 400,
          }
        }
        result = await commitRegisteredOperation(operation, supabase, userId, companyId, pendingOp.params)
        break
      }
    }
  } catch (err) {
    // Partial commit (issue #842): the executor already posted an
    // irreversible side-effect (storno voucher, credit note) before a later
    // step failed. 'rejected' would misrepresent reality and hide the posted
    // entity, so land the op in the terminal 'failed_partial' status with the
    // posted ids in result_data so an operator can locate the orphan. Checked
    // FIRST: a wrapped recoverable cause must NOT release the claim back to
    // 'pending' (the side-effect already exists).
    if (err instanceof PartialCommitError) {
      await supabase
        .from('pending_operations')
        .update({
          status: 'failed_partial',
          resolved_at: new Date().toISOString(),
          result_data: { error: err.message, threw: true, posted_ids: err.postedIds },
        })
        .eq('id', pendingOp.id)
      return {
        status: 'failed',
        error: err.message,
        http_status: 500,
        code: 'partial_commit',
        data: { posted_ids: err.postedIds },
        operation_status: 'failed_partial',
      }
    }
    // Accounts-not-in-chart is RECOVERABLE: the booking itself is valid; the
    // company's chart just lacks the (standard BAS) accounts it posts to. Do
    // NOT consume the op: release the atomic claim back to 'pending' so the
    // user can activate the accounts and retry the SAME op, and surface the
    // structured code + numbers so the client can offer one-click activation.
    if (err instanceof AccountsNotInChartError) {
      await supabase
        .from('pending_operations')
        .update({ status: 'pending' })
        .eq('id', pendingOp.id)
      return {
        status: 'failed',
        error: err.message,
        http_status: 400,
        code: ACCOUNTS_NOT_IN_CHART,
        account_numbers: err.accountNumbers,
        operation_status: 'pending',
      }
    }
    // Recoverable Skatteverket failure (extension disabled, no connection,
    // rate-limited, still processing). Same contract as accounts-not-in-chart:
    // release the claim back to 'pending' so the user can fix the connection/
    // flag and re-approve the SAME op, and surface the structured code.
    if (err instanceof SkatteverketRecoverableError) {
      await supabase
        .from('pending_operations')
        .update({ status: 'pending' })
        .eq('id', pendingOp.id)
      return {
        status: 'failed',
        error: err.message,
        http_status: err.httpStatus,
        code: err.code,
        operation_status: 'pending',
      }
    }
    const isBkErr = isBookkeepingError(err)
    const message = err instanceof Error ? err.message : (isBkErr ? 'Bookkeeping error' : 'Executor failed')
    // Release the claim by transitioning to 'rejected' so the row never gets
    // stuck in 'committing'. The error text is persisted in result_data for
    // audit/debug. 'failed': the approval did not go through, which is no
    // person's verdict on the proposal.
    await supabase
      .from('pending_operations')
      .update({
        status: 'rejected',
        resolved_at: new Date().toISOString(),
        rejection_category: 'failed',
        result_data: { error: message, threw: true },
      })
      .eq('id', pendingOp.id)
    return {
      status: 'failed',
      error: message,
      http_status: isBkErr ? 400 : 500,
      operation_status: 'rejected',
    }
  }

  if (result.error) {
    // Structured partial marker (issue #842): same semantics as the
    // PartialCommitError branch above, for executors that report the failure
    // via the ExecutorResult contract instead of throwing. Must run before
    // the auto-reject branch: a 409 AFTER a voucher was posted is a partial
    // commit, not a re-stageable rejection.
    const partialPostedIds =
      result.partialPostedIds && Object.keys(result.partialPostedIds).length > 0
        ? result.partialPostedIds
        : null
    if (partialPostedIds) {
      await supabase
        .from('pending_operations')
        .update({
          status: 'failed_partial',
          resolved_at: new Date().toISOString(),
          result_data: {
            error: result.error,
            http_status: result.status,
            posted_ids: partialPostedIds,
          },
        })
        .eq('id', pendingOp.id)
      return {
        status: 'failed',
        error: result.error,
        http_status: result.status ?? 500,
        code: 'partial_commit',
        data: { posted_ids: partialPostedIds },
        operation_status: 'failed_partial',
      }
    }
    // Authorization refusals (401/403) happen BEFORE any side-effect and say
    // nothing about the op's content: the credential, not the booking, was
    // wrong. Release the claim back to 'pending' so the op survives for a
    // caller that IS authorized (the /pending UI, or a key with the scope),
    // instead of vanishing as 'rejected'. Feedback seq 261545: three
    // samlingsverifikat were consumed this way and the user believed they
    // had been approved. An executor may ask for the same release for a
    // transient, side-effect-free refusal (returnToPending).
    if (result.status === 401 || result.status === 403 || result.returnToPending) {
      await supabase
        .from('pending_operations')
        .update({ status: 'pending' })
        .eq('id', pendingOp.id)
      return {
        status: 'failed',
        error: result.error,
        http_status: result.status,
        ...(result.errorCode ? { code: result.errorCode } : {}),
        operation_status: 'pending',
      }
    }
    const isAutoReject = result.status === 404 || result.status === 409
    // Executor-provided failure details (e.g. the Postgres message behind
    // LINK_TX_DB_ERROR) are persisted and returned alongside the message so
    // the approver sees WHY, not just that it failed.
    const failureDetails =
      result.data && Object.keys(result.data).length > 0 ? result.data : null
    const { error: rejectWriteError } = await supabase
      .from('pending_operations')
      .update({
        status: 'rejected',
        resolved_at: new Date().toISOString(),
        // A person approved; the executor refused. No verdict on the proposal.
        rejection_category: 'failed',
        result_data: isAutoReject
          ? {
              auto_rejected: true,
              reason: result.error,
              ...(result.errorCode ? { error_code: result.errorCode } : {}),
              ...(failureDetails ? { details: failureDetails } : {}),
            }
          : {
              error: result.error,
              http_status: result.status,
              ...(result.errorCode ? { error_code: result.errorCode } : {}),
              ...(failureDetails ? { details: failureDetails } : {}),
            },
      })
      .eq('id', pendingOp.id)
    if (rejectWriteError) {
      // Same contract as the finalize branch below: the row stays in
      // 'committing' and the daily recovery sweep
      // (recover-stuck-committing.ts) resolves it; log loudly with the ids
      // and the failure we could not persist so nothing is lost silently.
      log.error('failed to mark pending_operation rejected (left in committing)', rejectWriteError, {
        pendingOperationId: pendingOp.id,
        operationType: pendingOp.operation_type,
        companyId,
        executorError: result.error,
        executorErrorCode: result.errorCode ?? null,
      })
    }
    if (isAutoReject) {
      return {
        status: 'rejected',
        auto_rejected: true,
        error: result.error,
        http_status: result.status,
        ...(result.errorCode ? { code: result.errorCode } : {}),
        ...(failureDetails ? { data: failureDetails } : {}),
        operation_status: 'rejected',
      }
    }
    return {
      status: 'failed',
      error: result.error,
      http_status: result.status ?? 500,
      ...(result.errorCode ? { code: result.errorCode } : {}),
      ...(failureDetails ? { data: failureDetails } : {}),
      operation_status: 'rejected',
    }
  }

  const now = new Date().toISOString()
  const { error: finalizeError } = await supabase
    .from('pending_operations')
    .update({
      status: 'committed',
      resolved_at: now,
      result_data: result.data || {},
    })
    .eq('id', pendingOp.id)

  if (finalizeError) {
    // The executor's side-effects already committed (and are immutable); only
    // the terminal status write failed. Log loudly with the ids needed to
    // finalize manually; the response still reports success because the
    // actual work is done.
    //
    // Runbook (#843): rows left in 'committing' by this failure are picked up
    // by the daily recovery sweep in
    // lib/pending-operations/recover-stuck-committing.ts (runs from the
    // expire cron, threshold 15 min). Grep logs for 'pending_op_recovery' to
    // see per-row outcomes: 'committed' when posted side-effects were
    // verified, 'rejected' when no trace was detectable (nothing re-executes
    // either way).
    log.error('failed to finalize pending_operation to committed (left in committing)', finalizeError, {
      pendingOperationId: pendingOp.id,
      operationType: pendingOp.operation_type,
      companyId,
    })
  }

  // The decision receipt: one suggestion_log row per voucher this approval
  // posted, naming the operation, who approved it and under which policy, so
  // a staged-and-approved posting answers a receipt like a categorized bank
  // line does. After the commit and never part of it: the writer logs and
  // drops every failure (lib/suggestion-log/operation.ts).
  const claimedAt = (claimed as { updated_at?: unknown }).updated_at
  await recordOperationDecision(supabase, {
    companyId,
    userId,
    operation: pendingOp,
    resultData: result.data,
    claimedAt: typeof claimedAt === 'string' ? claimedAt : null,
    actor: opts.actor,
  })

  return {
    status: 'committed',
    data: result.data,
    operation_status: 'committed',
  }
}
