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
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { releaseDoubtfulReserveAfterChange } from '@/lib/customer-loss/doubtful'
import type { SupabaseClient } from '@supabase/supabase-js'
import { commitArkivProposeFact } from '@/lib/arkiv/facts/propose'
import { parseEntityType, resolveCompanyEntityType } from '@/lib/company/entity-type'
import { eventBus } from '@/lib/events'
import { emitInvoiceSent } from '@/lib/invoices/invoice-sent-event'
import { bulkBookMatchedInboxItems, categorizeMatchedTransaction } from '@/lib/transactions/categorize-core'
import { fetchExchangeRate, isExchangeRateTemporarilyUnavailable } from '@/lib/currency/riksbanken'
import { matchPairs, setItemIgnored, unmatchLink } from '@/lib/reconciliation/actions'
import { signOffAccount } from '@/lib/reconciliation/signoff'
import { bookResidualAndLink, ReconciliationResidualError } from '@/lib/reconciliation/residual'
import { SKATTEKONTO_ACCOUNT_KEY } from '@/lib/reconciliation/schemas'
import { SkattekontoLinkError } from '@/lib/skatteverket/skattekonto-link'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { createCustomer, PERSONAL_NUMBER_CIPHERTEXT_RE, updateCustomer } from '@/lib/customers/customer-commands'
import { toCustomerRecord } from '@/lib/customers/customer-record'
import {
  archiveIssuedInvoicePdf,
  emailRefusal,
  issuable,
  issueAndBookInvoice,
  markInvoiceSentAndBook,
  restoreUnbookedDraft,
  type IssuableInvoice,
  type IssueRefusal,
} from '@/lib/invoices/issue-and-book-invoice'
import { findCardCashAccount } from '@/lib/cash-accounts/load-card-ledgers'
import { isCardLedgerAccount } from '@/lib/cash-accounts/card-ledger'
import {
  ensureManualCashAccount,
  isCashAccountCurrencyMismatch,
  isCashAccountDisabledPayee,
  resolveDefaultCashAccount,
  type CashAccountCurrencyMismatch,
} from '@/lib/cash-accounts/service'
import { ingestTransactions } from '@/lib/transactions/ingest'
import { findFiscalPeriod, validateBalance } from '@/lib/bookkeeping/engine'
import { postingPort } from '@/lib/posting/port'
import { approveSupplierInvoice, personalAttestCap } from '@/lib/supplier-invoices/attest-service'
import type { AttestDecisionBatch } from '@/lib/supplier-invoices/attest-decision-notify'
import { CreditSupplierInvoiceInputSchema, creditSupplierInvoice } from '@/lib/supplier-invoices/credit'
import { claimInboxItemOrReverseEntry, readInboxItemBookingState } from '@/lib/documents/inbox-item-claim'
import { bookDirectDocumentCurrency, bookDirectFxRefusal } from '@/lib/bookkeeping/book-direct-prefill'
import { coerceDimensionsBag } from '@/lib/bookkeeping/dimension-resolver'
import { ACCOUNT_NUMBER_RE } from '@/lib/invariants/account-number'
import { isReverseChargeKind } from '@/lib/bookkeeping/vat-entries'
import { isReverseChargeBoxParam } from '@/lib/vat/reverse-charge-box'
import { correctionLanding } from '@/lib/vat/moved-correction-vat'
import { runWithActor } from '@/lib/bookkeeping/actor-context-node'
import { getActor, type CommitActor } from '@/lib/bookkeeping/actor-context'
import { createServiceClient } from '@/lib/supabase/server'
import { revokeServiceAccount } from '@/lib/service-accounts/service'
import { PackageSwitchParamsSchema, switchCompanyPackage } from '@/lib/suggestions/package-switch'
import { createGrantFromOperation, revokeGrantFromOperation } from '@/lib/grants/commit'
import { CreateGrantParamsSchema, GRANT_OPERATION_TYPES, RevokeGrantParamsSchema } from '@/lib/grants/types'
import { grantsEnabled } from '@/lib/grants/flag'
import { runInOperationCommit } from './commit-scope'
import { recordOperationDecision } from '@/lib/suggestion-log/operation'
import type { ApprovalDoor } from '@/lib/suggestion-log/approval-door'
import {
  correctionBusinessEvents,
  manualVoucherBusinessEvent,
  voucherStornoBusinessEvent,
} from '@/lib/bookkeeping/ledger-business-events'
import { bankLineStornoBusinessEvent, ownRowsStornoBusinessEvent } from '@/lib/bookkeeping/bank-line-business-events'
import {
  existingOpeningBalanceMessage,
  findExistingOpeningBalance,
  OPENING_BALANCE_EXISTS_CODE,
  type ExistingOpeningBalance,
} from '@/lib/import/opening-balance/existing'
import { linkOpeningBalance, OpeningBalanceExistsError } from '@/lib/import/opening-balance/existing'
import { saveVoucherGapExplanation, voucherGapExplanationFromParams } from '@/lib/core/bookkeeping/voucher-gaps'
import { MarkInvoiceSentPaidAtIssueSchema, SIEImportFlagsSchema } from '@/lib/api/schemas'
import { closePeriod, lockPeriod, resolvePeriodStatusForDate } from '@/lib/core/bookkeeping/period-service'
import {
  executeYearEndClosing,
  generateOpeningBalances,
} from '@/lib/core/bookkeeping/year-end-service'
import {
  assessKontantmetodCutoff,
  cutoffPreviewFingerprint,
  KontantmetodCutoffPartialError,
  KontantmetodManualCarryError,
  postKontantmetodCutoff,
  previewPaidBeforePostingCorrections,
  resolveKontantmetodManualCarries,
  type KontantmetodCarryPlan,
} from '@/lib/core/bookkeeping/kontantmetod-cutoff'
import {
  kontantmetodCutoffPreflight,
  kontantmetodCutoffWriteDates,
} from '@/lib/vat/kontantmetod-cutoff-preflight'
import { executeCurrencyRevaluation } from '@/lib/bookkeeping/currency-revaluation'
import {
  AssetCorrectionBlockedError,
  createAsset as createFixedAsset,
  deleteNeverPostedAsset,
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
import { linkInvoiceToVoucher, type LinkInvoiceToVoucherResult } from '@/lib/invoices/voucher-matching'
import { RegisterBookedInvoiceParamsSchema, registerBookedInvoice } from '@/lib/invoices/register-booked-invoice'
import { isRegisterBookedInvoiceParams } from '@/lib/invoices/register-booked-invoice-mode'
import {
  RegisterBookedSupplierInvoiceParamsSchema,
  registerBookedSupplierInvoice,
} from '@/lib/supplier-invoices/register-booked'
import { bookCustomerBankMatch } from '@/lib/invoices/book-customer-bank-match'
import { bankRowAlreadyBookedMessages } from '@/lib/errors/match-si-tx-already-booked'
import { findDuplicatePaymentCandidatesForInvoice } from '@/lib/invoices/duplicate-payment-candidates'
import {
  linkSupplierInvoiceToVoucher,
  type LinkSupplierInvoiceToVoucherResult,
} from '@/lib/invoices/supplier-voucher-matching'
import { invoicePayableRefusal } from '@/lib/invoices/invoice-payable'
import { settleInvoicePayment } from '@/lib/invoices/settle-invoice-payment'
import { describeRefundFailure, refundCreditNote, type RefundCreditNoteRow } from '@/lib/invoices/refund-credit-note'
import type { SaleFirstRefusal } from '@/lib/invoices/sale-first'
import { CREDIT_NOTE_NOT_DELIVERED, creditInvoice } from '@/lib/invoices/credit-invoice'
import { matchTransactionToRotRutPayout } from '@/lib/invoices/rot-rut-match-transaction'
import { linkRotRutPayoutVoucher } from '@/lib/invoices/rot-rut-link-voucher'
import {
  DocumentAlreadyLinkedError,
  documentHeldElsewhereReasonSv,
  isDocumentImmutabilityRefusal,
} from '@/lib/documents/link-holder'
import { linkDocumentCopyToVoucher, linkDocumentToVoucher, type LinkDocumentRefusal } from '@/lib/documents/link-document'
import { getErrorEntry, siCreateInvalidInputMessages } from '@/lib/errors/structured-errors'
import { recordVoucherWarningsAcknowledged, runVoucherWarningsGuard } from '@/lib/bookkeeping/voucher-warnings-guard'
import { linkOpenBankRowsToVoucher } from '@/lib/reconciliation/voucher-bank-link'
import { classifyError, isPeriodLockRefusal } from '@/lib/errors/get-structured-error'
import { requiresWebApproval, webOnlyRefusalCode } from '@/lib/pending-operations/risk-tiers'
import { bookingReviewLimitCovers } from '@/lib/booking-review/operation-gate'
import { stagedBookingReview } from '@/lib/pending-operations/staged-booking-review'
import { invoiceLacksCustomer } from '@/lib/invoices/invoice-customer'
import { sendInvoiceToDigitalMailbox } from '@/lib/invoices/digital-mailbox-send'
import { createDimensionValue } from '@/lib/dimensions/registry-service'
import { SIEJobDatabaseError, SIEJobValidationError, submitSIEJob } from '@/lib/import/sie-jobs'
import { userFacingCode } from '@/lib/errors/user-facing'
import type { AccountMapping } from '@/lib/import/types'
import {
  AccountsNotInChartError,
  BookingReviewLimitError,
  BookingReviewRequiredError,
  isBookkeepingError,
  ACCOUNTS_NOT_IN_CHART,
} from '@/lib/bookkeeping/errors'
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
import { fixableRefusalFor } from './fixable-refusals'
import { getEmailService } from '@/lib/email/service'
import { resolveInvoiceSender } from '@/lib/email/invoice-sender'
import { hasCapability, capabilityBlockedError } from '@/lib/entitlements/has-capability'
import { PAID_OPERATION_CAPABILITY_MAP } from '@/lib/entitlements/keys'
import { isSandboxCompany, SANDBOX_BLOCKED_MESSAGE_SV } from '@/lib/sandbox/guard'
import { exceedsUnattendedLimit } from './unattended-limit'
import {
  generateInvoiceEmailHtml,
  generateInvoiceEmailText,
  generateInvoiceEmailSubject,
} from '@/lib/email/invoice-templates'
import { linkToJournalEntry } from '@/lib/core/documents/document-service'
import { renderInvoicePdfBuffer } from '@/lib/invoices/render-invoice-pdf'
import { resolveInvoicePayeeChoice, resolveInvoicePaymentAccount, snapshotInvoicePayee } from '@/lib/invoices/invoice-payee'
import { describeMissingInvoicePaymentAccount, invoiceRequiresPaymentAccount } from '@/lib/cash-accounts/invoice-payment-accounts'
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
import { linkInvoiceAttachments, loadInvoiceEmailAttachments } from '@/lib/invoices/invoice-attachments'
import { createLogger } from '@/lib/logger'
import { createSupplier } from '@/lib/suppliers/create-supplier'
import { createArticle, updateArticle } from '@/lib/articles/article-commands'
import { UUID_RE } from '@/lib/invariants/uuid'
import { CreateDimensionValueParamsSchema } from '@/lib/pending-operations/schemas/dimension-value'
import { RetagLineDimensionsParamsSchema } from '@/lib/pending-operations/schemas/retag-line-dimensions'
import { everyRetagRefused, partialRetagWarning, retagLines } from '@/lib/dimensions/retag-service'
import { IgnoreTransactionParamsSchema } from '@/lib/pending-operations/schemas/ignore-transaction'
import { setTransactionIgnored } from '@/lib/transactions/ignore'
import { applyBulkIgnore } from '@/lib/transactions/bulk-ignore'
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
import {
  RECURRING_ARTICLE_INVALID_MESSAGE,
  findForeignRecurringArticleIds,
  insertRecurringScheduleItems,
  toRecurringScheduleItemRow,
} from '@/lib/invoices/recurring-schedule-items'
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
import { followPairedReceipt } from '@/lib/operations/inbox-companion'
import { convertInboxItemToSupplierInvoice, stagedConversion } from '@/lib/operations/inbox-convert'
import { refuseWhenPairBooked } from '@/lib/operations/inbox-pair-guard'
import { startPackageForPendingType } from '@/lib/modules/package-doors'
import { packageStartRefusal } from '@/lib/modules/package-gate'
import { COLLECTIONS_BATCH_TYPE } from '@/lib/collections/batch'
import { batchApprovalRefusal, commitCollectionsDailyBatch } from '@/lib/collections/batch-commit'
import { REMINDER_BATCH_TYPE } from '@/lib/reminders/batch'
import { commitReminderDailyBatch, reminderBatchApprovalRefusal } from '@/lib/reminders/batch-commit'
import type { AnyOperation, OperationOutcome } from '@/lib/operations/types'
import type {
  TransactionCategory,
  EntityType,
  VatTreatment,
  Currency,
  Invoice,
  Customer,
  PendingOperation,
  CompanySettings,
  InvoiceItem,
  InvoiceDocumentType,
  AccountingMethod,
  CreateJournalEntryLineInput,
  JournalEntrySourceType,
  FiscalPeriod,
} from '@/types'
import { hasEnded, todayIsoStockholm } from '@/lib/dates/iso'
import { isCreditNoteDocument } from '@/lib/bookkeeping/credit-note-state'
import { OWED_INVOICE_STATUSES } from '@/lib/bookkeeping/matchable-statuses'
import { linkBasisColumns } from '@/lib/links/stamp'
import {
  ACCOUNTING_METHOD_MISSING,
  ACCOUNTING_METHOD_UNREADABLE,
  checkAccountingMethod,
  type AccountingMethodUnavailableCode,
} from '@/lib/company/accounting-method'

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
  operation_status?: 'pending' | 'committed' | 'rejected' | 'failed_partial' | 'unknown'
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
  /**
   * The company grant that let this operation through without a person
   * (lib/grants/enforce.ts, after claim_company_grant matched it). Only the
   * grant path sets it, and only for a key credential's own staged
   * operation of a type a grant covers; the commit refuses any other use.
   * The pending operation's result_data and the decision receipt name the
   * grant and its version. The key's unattended ceiling (actor) still
   * applies: the stricter of the two wins.
   */
  grant?: { grantId: string; grantVersion: number; useId: string }
  /**
   * Where a key credential's approval came from, when the door knows: the
   * AI's own approve call (mcp_chat) or a person's click in the approval view
   * inside the AI client (mcp_view). Record-only: it names the door in the
   * decision receipt's policy and changes no gate; the key's ceiling and
   * every check below apply the same either way.
   */
  approvalDoor?: ApprovalDoor
  /**
   * A person approves one operation in the app, where a refusal they can fix
   * around the proposal can be said and fixed (lib/pending-operations/
   * fixable-refusals.ts, the one list): such a refusal hands the operation
   * back to 'pending' instead of consuming it as rejected. Nothing was
   * written, and the same approval is right once the fix is made. Every
   * other door (bulk, keys, agents) leaves it unset and keeps the rejection.
   */
  keepFixableRefusals?: boolean
  /**
   * The booking-time warning codes the approver read and confirmed in the
   * app (VOUCHER_NEEDS_CONFIRMATION answered in the warnings dialog), added
   * to the ones acknowledged at staging. The guard still runs again: a
   * warning not named here refuses the approval once more.
   */
  acknowledgedWarnings?: readonly string[]
  /**
   * The attest answers of a bulk approval, told once: each staged attest
   * passes it to the attest service (AttestDecisionInput in
   * lib/supplier-invoices/attest-service.ts), which adds the answer the
   * moment the attest is stored instead of mailing, and the caller flushes
   * it in a finally. Without it each attest mails as it completes.
   */
  attestDecisions?: AttestDecisionBatch
  /**
   * A person approves one categorize_transaction in the app, where a possible
   * duplicate can be shown and answered. Set (even empty), the duplicate
   * refusal hands the operation back to 'pending' with the candidate instead
   * of consuming it as rejected: nothing was written, and the person's yes
   * was to the booking, not to losing the proposal. With
   * expectedJournalEntryId the person saw that candidate and books anyway:
   * the guard re-detects it and records the dismissal in behandlingshistorik.
   * Every other door (bulk, keys, agents) keeps the auto-reject and restages
   * with allow_duplicate.
   */
  duplicateReview?: { expectedJournalEntryId?: string }
}

// ensureFiscalPeriod moved to lib/transactions/categorize-core.ts (imported
// above) so the bulk-book-inbox path and the single-categorize path share one
// implementation.

// ── Executors ────────────────────────────────────────────────────

/**
 * The company's booking context for invoice-shaped executors: accounting
 * method and entity type. Fails closed (accounted#58): a missing row or a
 * failed read refuses the op and hands it back to 'pending' (nothing was
 * written), instead of booking a kontantmetod invoice's payment as a 1510
 * clearing under a guessed faktureringsmetoden.
 */
async function loadBookingContext(
  supabase: SupabaseClient,
  companyId: string
): Promise<
  | { ok: true; accountingMethod: AccountingMethod; entityType: EntityType }
  | { ok: false; result: ExecutorResult }
> {
  const settingsRead = await supabase
    .from('company_settings').select('accounting_method, entity_type').eq('company_id', companyId).single()
  const method = checkAccountingMethod(settingsRead)
  if (!method.ok) return { ok: false, result: accountingMethodRefusal(method) }

  return {
    ok: true,
    accountingMethod: method.accountingMethod,
    entityType: await resolveCompanyEntityType(supabase, companyId, settingsRead.data?.entity_type),
  }
}

/** An unreadable accounting method as an executor refusal: side-effect free, so the op stays pending. */
function accountingMethodRefusal(method: { code: AccountingMethodUnavailableCode }): ExecutorResult {
  const entry = getErrorEntry(method.code)
  return {
    error: entry?.message_sv ?? 'Företagets bokföringsmetod kunde inte läsas, så inget bokfördes.',
    errorCode: method.code,
    status: entry?.httpStatus ?? 503,
    returnToPending: true,
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
 * A refusal of the sale a settlement books first (lib/invoices/sale-first.ts)
 * as the executor's result: the Bokför step's own code with details.sale_first.
 * A typed bookkeeping error propagates to the dispatcher, as the engine's own
 * refusals do.
 */
function saleFirstRefusalResult(refusal: SaleFirstRefusal): ExecutorResult {
  if (refusal.error) throw refusal.error
  const entry = getErrorEntry(refusal.code)
  return {
    error: entry?.message_sv ?? refusal.code,
    errorCode: refusal.code,
    status: entry?.httpStatus ?? 400,
    ...(refusal.details ? { data: refusal.details } : {}),
  }
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
  pendingOperationId: string,
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
    { supabase, companyId, userId, log: log.child({ operation: operation.id }), pendingOperationId },
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
      // A refusal that brings its own English and next step (a document on a
      // locked year) keeps them there too, as the SIE executor keeps its
      // remediation: the agent that staged the write reads its way forward
      // from the approval's data, not from the registry's for the code.
      ...(outcome.details || outcome.messageEn || outcome.remediation
        ? {
            data: {
              ...(outcome.details ?? {}),
              ...(outcome.messageSv && outcome.messageEn ? { message_en: outcome.messageEn } : {}),
              ...(outcome.remediation ? { remediation: outcome.remediation } : {}),
            },
          }
        : {}),
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
  params: Record<string, unknown>,
  duplicateReview?: CommitOptions['duplicateReview'],
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

  // Whether the caller named that box at staging (the door's parameter) or
  // it was read off the underlag: a named box is held against the cost
  // account's own ruta 20-24 at approval too. A present but unknown value is
  // drift, as for the kind.
  const rawReverseChargeBoxParam = params.reverse_charge_box_param
  if (rawReverseChargeBoxParam != null && !isReverseChargeBoxParam(rawReverseChargeBoxParam)) {
    return {
      error:
        'Ogiltig reverse_charge_box_param i den stagade operationen. ' +
        'Avvisa operationen och stagea om kategoriseringen.',
      status: 400,
    }
  }

  return categorizeMatchedTransaction(supabase, userId, companyId, txId, {
    category,
    vatTreatment,
    reverseChargeKind: rawReverseChargeKind ?? undefined,
    ...(rawReverseChargeBoxParam ? { reverseChargeBoxParam: rawReverseChargeBoxParam } : {}),
    vatAmount,
    notes,
    allowDuplicate: params.allow_duplicate === true,
    // The approver saw the foreign-VAT note the staging put on the proposal.
    confirmForeignSellerVat: params.confirm_foreign_seller_vat === true,
    ...(duplicateReview?.expectedJournalEntryId
      ? { expectedDuplicateJournalEntryId: duplicateReview.expectedJournalEntryId }
      : {}),
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

  const articleCheck = await findForeignRecurringArticleIds(supabase, companyId, validated.items)
  if (articleCheck.error) return { error: articleCheck.error.message, status: 500 }
  if (articleCheck.invalidArticleIds.length > 0) {
    return { error: RECURRING_ARTICLE_INVALID_MESSAGE, status: 400 }
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

  const { error: itemsError } = await insertRecurringScheduleItems(supabase, itemRows)

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

  if (items) {
    const articleCheck = await findForeignRecurringArticleIds(supabase, companyId, items)
    if (articleCheck.error) return { error: articleCheck.error.message, status: 500 }
    if (articleCheck.invalidArticleIds.length > 0) {
      return { error: RECURRING_ARTICLE_INVALID_MESSAGE, status: 400 }
    }
  }

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

  // A bulk ignore (crm#1647): the pinned ids, re-read under the selection
  // they were staged from, so a row booked or linked since staging is
  // skipped. Writes no verifikat; a retry after a partial failure skips the
  // rows already changed.
  if (validated.transaction_ids) {
    const outcome = await applyBulkIgnore(
      supabase,
      companyId,
      {
        cashAccountId: validated.cash_account_id as string,
        beforeDate: validated.before_date as string,
        ignored: validated.ignored,
      },
      validated.transaction_ids,
    )
    return {
      data: {
        is_ignored: validated.ignored,
        changed_count: outcome.changed,
        skipped_count: outcome.skipped,
      },
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
 * enable_package and disable_package (Profiles and Suggestions, step 3): the
 * company's choice to show or hide a package such as Lön, staged by a
 * suggestion detector (lib/suggestions) and approved by a person, in the app
 * or through their own agent. set_company_package_choice (migration
 * 20261016200400) is the authority, called through the service client on
 * every path: it re-checks that the approver is an owner or admin (403
 * hands the op back to pending for one who is), refuses to switch off while
 * the package has open obligations (409, with the obligations named), and
 * writes the choice with who decided plus the audit row behandlingshistorik
 * shows. A service account's own key never decides a package: the approval
 * goes back for a person to give.
 */
async function commitPackageSwitch(
  userId: string,
  companyId: string,
  pendingOp: PendingOperation,
  enabled: boolean
): Promise<ExecutorResult> {
  const parsed = PackageSwitchParamsSchema.safeParse(pendingOp.params)
  if (!parsed.success) return invalidStagedParams(parsed.error)
  const actor = getActor()
  if (actor?.type === 'service_account') {
    const entry = getErrorEntry('PACKAGE_SWITCH_NEEDS_PERSON')
    return {
      error: entry?.message_sv ?? 'PACKAGE_SWITCH_NEEDS_PERSON',
      errorCode: 'PACKAGE_SWITCH_NEEDS_PERSON',
      status: entry?.httpStatus ?? 403,
    }
  }
  const result = await switchCompanyPackage(createServiceClient(), {
    companyId,
    userId,
    pendingOperationId: pendingOp.id,
    enabled,
    params: parsed.data,
    actor: { type: actor?.type ?? 'user', ...(actor?.label ? { label: actor.label } : {}) },
  })
  if (!result.ok) {
    return {
      error: result.message_sv,
      errorCode: result.code,
      status: result.status,
      ...(result.obligations ? { data: { obligations: result.obligations } } : {}),
    }
  }
  return { data: result.data }
}

/**
 * create_grant and revoke_grant (Profiles and Suggestions, step 4;
 * lib/grants): a company rule that lets a key credential book one known
 * counterparty's bank lines unattended within limits, staged by the
 * grant-suggestion detector (create) or from Att göra (revoke) and approved
 * by an owner or admin. Accepting a grant is a person's decision in the app
 * (create_grant is web-only, and here the actor must be 'user'): no agent
 * accepts its own authority, whatever key relays it. With GRANT_SUGGESTIONS
 * off nothing is accepted at all. Revoking stays open to any approver who
 * may approve, since it only takes authority away.
 * create_company_grant and revoke_company_grant (migration 20261017100300)
 * are the authority, called through the service client on every path: they
 * re-check that the approver is an owner or admin (403 hands the op back to
 * pending for one who is), create_company_grant re-checks that a person
 * decided, and both write the rule with the audit row behandlingshistorik
 * shows. Revoking answers the postings the grant let through.
 */
async function commitGrantDecision(
  userId: string,
  companyId: string,
  pendingOp: PendingOperation,
  kind: 'create' | 'revoke',
): Promise<ExecutorResult> {
  const actor = getActor()
  if (kind === 'create') {
    // GRANT_SUGGESTIONS is the master switch: off, no grant is accepted,
    // however the operation reached the queue.
    if (!grantsEnabled()) {
      const entry = getErrorEntry('GRANTS_SWITCHED_OFF')
      return { error: entry?.message_sv ?? 'GRANTS_SWITCHED_OFF', errorCode: 'GRANTS_SWITCHED_OFF', status: entry?.httpStatus ?? 409 }
    }
    // Accepting is a person's decision in the app: never a key, an OAuth
    // connector, the in-app assistant, a service account, or no actor at all.
    if (actor?.type !== 'user') {
      const entry = getErrorEntry('GRANT_NEEDS_PERSON')
      return { error: entry?.message_sv ?? 'GRANT_NEEDS_PERSON', errorCode: 'GRANT_NEEDS_PERSON', status: entry?.httpStatus ?? 403 }
    }
  }
  const decision = {
    companyId,
    userId,
    pendingOperationId: pendingOp.id,
    actor: { type: actor?.type ?? 'user', ...(actor?.label ? { label: actor.label } : {}) },
  }
  if (kind === 'create') {
    const parsed = CreateGrantParamsSchema.safeParse(pendingOp.params)
    if (!parsed.success) return invalidStagedParams(parsed.error)
    const result = await createGrantFromOperation(createServiceClient(), { ...decision, params: parsed.data })
    if (!result.ok) return { error: result.message_sv, errorCode: result.code, status: result.status }
    return { data: result.data }
  }
  const parsed = RevokeGrantParamsSchema.safeParse(pendingOp.params)
  if (!parsed.success) return invalidStagedParams(parsed.error)
  const result = await revokeGrantFromOperation(createServiceClient(), { ...decision, params: parsed.data })
  if (!result.ok) return { error: result.message_sv, errorCode: result.code, status: result.status }
  return { data: result.data }
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
 * A partial result is said as one (crm#1908): outcome 'partial' and a
 * warning lead the answer, and failed_by_reason counts every line left
 * untagged per reason (closed period, locked period, lock date, ...), also
 * past the 20 echoed. An approval answers that warning beside its status.
 *
 * The loop, the merge of the staged pairs into each line's current bag, the
 * lock check and the all-refused rule live in lib/dimensions/
 * retag-service.ts. A merge reads the bags at approval, not at staging, so a
 * tag set in between is kept.
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
  // Reading the lines or their period locks failed, before any write: the
  // operation stays pending, so the same approval works once the read does.
  // Every retag reads them now, and a failed read used to consume the op.
  if (!outcome.ok) {
    return {
      error:
        'Verifikationsraderna eller deras periodlås kunde inte läsas, så ingenting taggades om. Åtgärden ligger kvar: godkänn den igen om en stund.',
      status: 503,
      returnToPending: true,
    }
  }
  if (outcome.dryRun) return { data: outcome.preview }

  const { retagged, unchanged, failed, failed_by_reason } = outcome.data
  // Echo at most 20 failures: enough to act on without bloating result_data
  // on a pathological 500-line all-but-one failure. failed_by_reason counts
  // them all.
  const echoedFailures = failed.slice(0, 20)
  const refused = everyRetagRefused(outcome.data)
  if (refused) {
    return {
      error: refused.messageSv,
      errorCode: 'DIMENSION_RETAG_FAILED',
      status: 400,
      data: { failed_count: failed.length, failed_by_reason, failed: echoedFailures },
    }
  }

  const warning = partialRetagWarning(outcome.data)
  return {
    data: {
      outcome: outcome.data.outcome,
      ...(warning ? { warning } : {}),
      retagged,
      unchanged,
      failed_count: failed.length,
      failed_by_reason,
      failed: echoedFailures,
      mode: validated.mode,
      dimensions: validated.dimensions,
      ...(validated.filter_summary ? { filter_summary: validated.filter_summary } : {}),
    },
  }
}

/**
 * CASH_ACCOUNT_CURRENCY_MISMATCH as an approval's answer, naming the ledger
 * and both currencies. A 409 closes the proposal as one to stage again, as
 * TX_CREATE_DUPLICATE does: the proposal itself names an account in another
 * currency, so the same approval can never go through (fixable-refusals.ts
 * keeps only refusals fixed outside the proposal).
 */
function cashAccountCurrencyRefusal(mismatch: CashAccountCurrencyMismatch): ExecutorResult {
  const { ledger_account, account_currency, currency } = mismatch.details
  return {
    error:
      `Bankkontot på ${ledger_account} är i ${account_currency}, men transaktionen är i ${currency}. ` +
      `Ett bankkonto har bara en valuta, så inget sparades. Lägg transaktionen på ett bankkonto i ${currency}.`,
    errorCode: mismatch.code,
    status: getErrorEntry(mismatch.code)?.httpStatus ?? 409,
    data: { ...mismatch.details },
  }
}

/**
 * CASH_ACCOUNT_DISABLED_PAYEE as an approval's answer, naming the ledger:
 * the bank account on ledger_account is turned off and marked to be printed
 * on invoices, which rows never turn back on (reenableIfUnused). Refused
 * before anything is stored. What is wrong lies outside the proposal (an
 * owner or admin turns the account on, or hides it on invoices), so the
 * app's single approval keeps it pending for the same approval once that is
 * done (fixable-refusals.ts); every other door closes it, as any 409 does.
 */
function cashAccountDisabledPayeeRefusal(ledgerAccount: string): ExecutorResult {
  const code = 'CASH_ACCOUNT_DISABLED_PAYEE'
  return {
    error:
      `Bankkontot på ${ledgerAccount} är avstängt och markerat att visas på fakturor, så transaktionen sparades inte. ` +
      'En ägare eller administratör behöver aktivera det under Inställningar → Bokföring (då visas det på fakturor igen) ' +
      'eller dölja det på fakturor under Inställningar → Försäljning → Fakturor.',
    errorCode: code,
    status: getErrorEntry(code)?.httpStatus ?? 409,
    data: { ledger_account: ledgerAccount },
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
  // A 19xx cash account (a missing kassakonto is created below), or an
  // existing company card's liability account. A card is never created here:
  // it is added under Konton, owner/admin only.
  const isCardLedger = !!ledgerAccount && isCardLedgerAccount(ledgerAccount)
  if (ledgerAccount && !/^19\d{2}$/.test(ledgerAccount) && !isCardLedger) {
    return { error: 'ledger_account must be a BAS 19xx cash account or a company card account', status: 400 }
  }
  let card: Awaited<ReturnType<typeof findCardCashAccount>> = null
  if (ledgerAccount && isCardLedger) {
    card = await findCardCashAccount(supabase, companyId, ledgerAccount)
    if (!card) {
      return {
        error: `ledger_account ${ledgerAccount} is not a company card of this company: add the card under Konton first`,
        status: 400,
      }
    }
    if (card.currency.toUpperCase() !== currency.toUpperCase()) {
      return { error: `The company card on ${ledgerAccount} is billed in ${card.currency}, not ${currency}`, status: 400 }
    }
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
  let cashAccount: { id: string; ledger_account: string } | null
  if (card && ledgerAccount) {
    cashAccount = { id: card.id, ledger_account: ledgerAccount }
  } else if (ledgerAccount) {
    try {
      cashAccount = { id: await ensureManualCashAccount(supabase, companyId, ledgerAccount, currency), ledger_account: ledgerAccount }
    } catch (err) {
      // Two refusals before anything is stored, which used to reach the
      // dispatcher's catch as a 500 that told the approver to try again: the
      // kassakonto on ledger_account is in another currency (a ledger holds
      // one), or it is a turned-off invoice payee that only an owner or admin
      // turns on.
      if (isCashAccountCurrencyMismatch(err)) return cashAccountCurrencyRefusal(err)
      if (isCashAccountDisabledPayee(err)) return cashAccountDisabledPayeeRefusal(ledgerAccount)
      throw err
    }
  } else {
    cashAccount = await resolveDefaultCashAccount(supabase, companyId, currency, bankConnectionId)
  }

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
    // Omitted = the builder leaves the stored address alone; null clears it.
    delivery_address: changes.delivery_address,
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
  // The account the staging call said the money landed on (crm#1823).
  const paymentAccount = typeof params.payment_account === 'string' ? params.payment_account : undefined

  const { data: invoice, error: invoiceError } = await supabase
    .from('invoices')
    .select('*, customer:customers(*), items:invoice_items(*)')
    .eq('id', invoiceId)
    .eq('company_id', companyId)
    .single()

  if (invoiceError || !invoice) return { error: 'Invoice not found', status: 404 }
  // A kreditfaktura: the refund paid back to the customer (Dr 1510 / Cr bank).
  if (invoice.credited_invoice_id) {
    return commitCreditNoteRefund(supabase, userId, companyId, invoice as Invoice, paymentDate, params.allow_duplicate === true, paymentAccount)
  }
  // The one answer of every door. 409 like the credit-note guard above: the
  // dispatcher records it as rejected (a state refusal), not failed (an
  // execution error).
  const notPayable = await invoicePayableRefusal(supabase, companyId, invoice as Invoice, paymentDate)
  if (notPayable) {
    return {
      error: getErrorEntry(notPayable.code)?.message_sv ?? 'Invoice is not payable.',
      errorCode: notPayable.code,
      status: 409,
    }
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
  }

  const bookingContext = await loadBookingContext(supabase, companyId)
  if (!bookingContext.ok) return bookingContext.result
  const { accountingMethod, entityType } = bookingContext

  // Settle the full outstanding balance through settleInvoicePayment, the
  // write path the dashboard, v1 and the Stripe sync share: the sale first
  // when a deferring company's invoice has no verifikat yet (sale-first.ts),
  // journal entry routed on the invoice's own booking state (cash entry only
  // for a never-booked kontantmetod invoice, else clearing 1510), the
  // invoice_payments row, the CAS-guarded status update that makulerar the
  // voucher on a lost race, and invoice.paid. Prefer remaining_amount; for
  // legacy rows where it was never written, derive it from total - paid_amount
  // rather than the full total (which would double-count a prior partial).
  const inv = invoice as { remaining_amount?: number | null; paid_amount?: number | null }
  const paymentAmount = inv.remaining_amount ?? (invoice.total - (inv.paid_amount ?? 0))
  // Debit the account the staging call named, else the bank account the
  // invoice asked to be paid to (the primary bank account when none was
  // chosen): an agent marking a 1931-invoice paid must not land it on 1930.
  // The named account is checked again here: it may have been disabled since.
  const settlementAccount = await resolveInvoicePaymentAccount(supabase, companyId, invoice as Invoice, paymentAccount)
  if (!settlementAccount.ok) return paymentAccountRefusalResult(settlementAccount)
  const settlementAccountNumber = settlementAccount.account
  const settled = await settleInvoicePayment(supabase, companyId, userId, {
    invoice: invoice as Invoice,
    paymentAmountInInvoiceCurrency: paymentAmount,
    paymentDate,
    accountingMethod,
    entityType,
    settlementAccountNumber,
    paymentSource: 'manual',
    // The override goes in the behandlingshistorik with the voucher it produced.
    ...(params.allow_duplicate === true ? { duplicateGuardBypass: { user_id: userId, actor_type: 'user' as const } } : {}),
  })
  // A befarad kundförlust reserve the payment made unnecessary comes back
  // (Dr 1519 / Cr 6352), as on every payment path. Never throws.
  await releaseDoubtfulReserveAfterChange(supabase, companyId, userId, {
    invoiceId,
    entryDate: paymentDate,
    trigger: 'payment',
  })

  if (!settled.ok) {
    switch (settled.code) {
      case 'SALE_FIRST_REFUSED':
        // The sale this payment books first was refused: nothing was written.
        return saleFirstRefusalResult(settled.refusal)
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

  const { newStatus, newRemaining, journalEntryId, saleJournalEntryId } = settled
  return {
    data: {
      status: newStatus,
      remaining_amount: newRemaining,
      journal_entry_id: journalEntryId,
      // The sale verifikat this payment booked first (defer_invoice_booking).
      ...(saleJournalEntryId ? { sale_journal_entry_id: saleJournalEntryId } : {}),
    },
  }
}

/** A payment_account that is not one of the company's enabled cash accounts: nothing was written. */
function paymentAccountRefusalResult(
  refusal: Extract<Awaited<ReturnType<typeof resolveInvoicePaymentAccount>>, { ok: false }>,
): ExecutorResult {
  const available = (refusal.details.available_payment_accounts as string[] | undefined) ?? []
  return {
    error:
      (getErrorEntry(refusal.code)?.message_sv ?? refusal.code) +
      (available.length > 0 ? ` Möjliga konton: ${available.join(', ')}.` : ''),
    errorCode: refusal.code,
    status: 409,
  }
}

/**
 * The approved refund of a kreditfaktura (gnubok_mark_invoice_as_paid on a
 * credit note): the whole amount the customer has tillgodo, out of the credit
 * note's payee account, through the dashboard's write path
 * (lib/invoices/refund-credit-note.ts). The already-booked guard runs again
 * here; allow_duplicate skips it as it skips the payment guard.
 */
async function commitCreditNoteRefund(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  creditNote: Invoice,
  paymentDate: string,
  force: boolean,
  paymentAccount?: string,
): Promise<ExecutorResult> {
  const refundAccount = await resolveInvoicePaymentAccount(supabase, companyId, creditNote, paymentAccount)
  if (!refundAccount.ok) return paymentAccountRefusalResult(refundAccount)
  const refund = await refundCreditNote(supabase, companyId, userId, {
    creditNote: creditNote as unknown as RefundCreditNoteRow,
    refundDate: paymentDate,
    settlementAccountNumber: refundAccount.account,
    force,
  })
  if (!refund.ok) {
    // An engine refusal (a locked period, an account outside the chart)
    // propagates to the dispatcher, as for a payment.
    if (refund.code === 'BOOKKEEPING_ERROR') throw refund.error
    if (refund.code === 'DB_ERROR') {
      log.error('mark_invoice_paid: credit note refund read failed', refund.error as Error, { companyId, invoiceId: creditNote.id })
      return { error: 'Återbetalningen kunde inte registreras.', status: 500 }
    }
    const { code, status } = describeRefundFailure(refund)
    return { error: getErrorEntry(code)?.message_sv ?? code, errorCode: code, status }
  }
  return {
    data: {
      refund: true,
      refunded_amount: refund.amount,
      owed_after: refund.owedAfter,
      paid_amount: refund.paidAmount,
      journal_entry_id: refund.journalEntryId,
    },
  }
}

/**
 * A credit note staged as an ordinary send or mark-sent (crm#2061): the
 * refusal says how it does reach the customer. A linked draft is sent from
 * its page, which issues and books it; an issued one is not emailed again by
 * any door, so its PDF goes by hand; a cancelled one goes nowhere. The
 * last sentence of the issued refusal is the agent's and is stripped from the
 * person's copy (approval-refusal.ts).
 */
function creditNoteSendRefusal(invoice: Pick<Invoice, 'status' | 'credited_invoice_id'>): ExecutorResult {
  // A cancelled credit note is not a valid document: no PDF goes to anyone.
  // 409 as for the other cases, so the dispatcher consumes the operation.
  if (invoice.status === 'cancelled') {
    const message = getErrorEntry('INVOICE_SEND_CANCELLED')?.message_sv ?? 'INVOICE_SEND_CANCELLED'
    return { error: message, errorCode: 'INVOICE_SEND_CANCELLED', status: 409 }
  }
  const code =
    invoice.status !== 'draft'
      ? 'INVOICE_SEND_CREDIT_NOTE_ISSUED'
      : invoice.credited_invoice_id
        ? 'INVOICE_SEND_CREDIT_NOTE_DRAFT'
        : 'INVOICE_CREDIT_NOTE_NOT_ISSUABLE'
  const entry = getErrorEntry(code)
  const agentStep =
    code === 'INVOICE_SEND_CREDIT_NOTE_ISSUED'
      ? ' Hämta PDF:en med gnubok_get_invoice_pdf och se med gnubok_get_invoice_deliveries om den har levererats.'
      : ''
  return { error: `${entry?.message_sv ?? code}${agentStep}`, errorCode: code, status: 409 }
}

/** A refused issue as the executors answer it. */
function issueRefusalResult(refusal: IssueRefusal, currency: Invoice['currency']): ExecutorResult {
  if (refusal.code === 'INVOICE_SEND_PAYMENT_ACCOUNT_MISSING') {
    return { error: describeMissingInvoicePaymentAccount(currency).sv, errorCode: refusal.code, status: 400 }
  }
  const entry = getErrorEntry(refusal.code)
  return { error: entry?.message_sv ?? refusal.code, errorCode: refusal.code, status: entry?.httpStatus ?? 400 }
}

/**
 * send_invoice staged with channel kivra or billo: the invoice page's send to
 * the customer's digital mailbox (lib/invoices/digital-mailbox-send.ts), every
 * check, the usage gate and the dispatch log included. A delivery that fails
 * after a draft was booked on issue leaves the verifikat posted: the op lands
 * in failed_partial carrying it, and sending again resends the issued invoice.
 */
async function commitSendInvoiceToMailbox(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  invoiceId: string,
  provider: 'kivra' | 'billo',
): Promise<ExecutorResult> {
  const outcome = await sendInvoiceToDigitalMailbox(
    { supabase, service: createServiceClient(), companyId, userId, log },
    invoiceId,
    provider,
  )
  if (outcome.ok) return { data: { invoice_id: invoiceId, channel: provider, ...outcome.data } }
  // The engine's own refusal: the dispatcher maps it with its Swedish text.
  if (isBookkeepingError(outcome.bookingError)) throw outcome.bookingError
  const entry = getErrorEntry(outcome.code)
  const journalEntryId = outcome.details?.journal_entry_id
  return {
    error: outcome.messageSv ?? entry?.message_sv ?? outcome.code,
    errorCode: outcome.code,
    status: entry?.httpStatus ?? 400,
    ...(outcome.details ? { data: outcome.details } : {}),
    ...(typeof journalEntryId === 'string' ? { partialPostedIds: { journal_entry_id: journalEntryId } } : {}),
  }
}

async function commitSendInvoice(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>,
  userEmail?: string
): Promise<ExecutorResult> {
  const invoiceId = params.invoice_id as string

  // Staged by gnubok_send_invoice's channel; a row without one is an email send.
  const channel = params.channel ?? 'email'
  if (channel === 'kivra' || channel === 'billo') {
    return commitSendInvoiceToMailbox(supabase, userId, companyId, invoiceId, channel)
  }
  if (channel !== 'email') return { error: 'Invalid channel', errorCode: 'VALIDATION_ERROR', status: 400 }

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
  if (isCreditNoteDocument(invoice)) return creditNoteSendRefusal(invoice)
  const notEmailed = emailRefusal(invoice)
  if (notEmailed) return issueRefusalResult(notEmailed, invoice.currency)
  // partially_paid/credited imply the invoice was already issued too: the
  // status flip below would regress them to 'sent' (PR #666 review, ASVS V2.3).
  if ([...OWED_INVOICE_STATUSES, 'paid', 'credited', 'written_off'].includes(invoice.status)) {
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
  const refused = issuable(invoice as Invoice, company as CompanySettings)
  if (refused) return issueRefusalResult(refused, invoice.currency)

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

  // The files the invoice carries (crm#1269): documents named at staging are
  // attached now, then the whole set is read before a number is allocated or
  // anything is issued, so a missing or oversized file stops the send while
  // nothing irreversible has happened.
  const attachmentFailure = (code: string): ExecutorResult => {
    const entry = getErrorEntry(code)
    return { error: entry?.message_sv ?? code, errorCode: code, status: entry?.httpStatus ?? 400 }
  }
  const requestedAttachments = Array.isArray(params.attachment_document_ids)
    ? (params.attachment_document_ids as unknown[]).filter((id): id is string => typeof id === 'string')
    : []
  if (requestedAttachments.length > 0) {
    const linked = await linkInvoiceAttachments(supabase, companyId, invoiceId, requestedAttachments)
    if (!linked.ok) return attachmentFailure(linked.code)
  }
  const extraAttachments = await loadInvoiceEmailAttachments(supabase, companyId, invoiceId)
  if (!extraAttachments.ok) return attachmentFailure(extraAttachments.code)

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
    paymentAccountRequired,
  })

  const filename = invoicePdfFilename({
    companyName: company.company_name,
    customerName: customer.name,
    invoiceNumber: invoice.invoice_number,
    invoiceId: invoice.id,
    invoiceDate: invoice.invoice_date,
    documentType: invoice.document_type,
    isCreditNote: false,
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
    await emitInvoiceSent({ supabase, companyId, userId, invoice: invoice as Invoice, settings: company as CompanySettings, log })
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
      extraAttachments: extraAttachments.value,
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
      await linkToJournalEntry(supabase, companyId, result.documentId, journalEntryId, linkBasisColumns('system_derived'))
    } catch { /* non-blocking */ }
  }

  await emitInvoiceSent({ supabase, companyId, userId, invoice: invoice as Invoice, settings: company as CompanySettings, log })

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
  // The kontantfaktura (crm#1281), staged by gnubok_mark_invoice_as_sent with
  // paid_at_issue_account: the dashboard mark-sent body, the same schema.
  const paidAtIssueParse = MarkInvoiceSentPaidAtIssueSchema.safeParse({ paid_at_issue: params.paid_at_issue })
  if (!paidAtIssueParse.success) {
    return { error: 'Betalkontot måste vara ett 19xx-konto (kassa, bank eller Swish).', status: 400 }
  }
  const paidAtIssue = paidAtIssueParse.data.paid_at_issue ?? null

  const { data: invoice, error: invoiceError } = await supabase
    .from('invoices')
    .select('*, customer:customers(*), items:invoice_items(*)')
    .eq('id', invoiceId)
    .eq('company_id', companyId)
    .single()

  if (invoiceError || !invoice) return { error: 'Invoice not found', status: 404 }
  if (isCreditNoteDocument(invoice)) return creditNoteSendRefusal(invoice)
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
  // invoice.sent emitted. A kontantfaktura is refused there for anything but
  // a plain faktura (INVOICE_PAID_AT_ISSUE_NOT_ALLOWED), and otherwise booked
  // as one cash verifikat with the invoice ending paid.
  const issued = await issueAndBookInvoice({
    supabase,
    companyId,
    userId,
    invoice: invoice as IssuableInvoice,
    settings: settings as CompanySettings,
    log,
    paidAtIssue: paidAtIssue ? { settlementAccountNumber: paidAtIssue.account_number } : null,
  })
  if (!issued.ok) {
    switch (issued.errorCode) {
      case 'INVOICE_CUSTOMER_MISSING':
        return customerMissingResult()
      case 'INVOICE_SEND_PAYMENT_ACCOUNT_MISSING':
      case 'INVOICE_SEND_VAT_NUMBER_MISSING':
        return issueRefusalResult({ code: issued.errorCode }, (invoice as Invoice).currency)
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
      status: paidAtIssue ? 'paid' : 'sent',
      journal_entry_id: issued.journalEntryId,
      ...(warnings.length > 0 ? { warning: warnings.join(' ') } : {}),
    },
  }
}

/**
 * Refusals of a staged match that are a state of the books, not a failure of
 * the approval: the dispatcher records a 409 as rejected, and the user can
 * stage the match again once the state has changed.
 */
const MATCH_STATE_REFUSALS: ReadonlySet<string> = new Set([
  'MATCH_INVOICE_TX_ALREADY_LINKED',
  'MATCH_INVOICE_NOT_INVOICE_TYPE',
  'MATCH_INVOICE_CREDIT_NOTE',
  'MATCH_INVOICE_NOT_OPEN',
])

/** The approval of a staged match: the booking is bookCustomerBankMatch, this maps its outcome. */
async function commitMatchTransactionInvoice(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const outcome = await bookCustomerBankMatch(
    { supabase, companyId, userId, log },
    {
      transactionId: params.transaction_id as string,
      invoiceId: params.invoice_id as string,
      // Where the user chose to book an excess and a provider's fee, with the
      // amounts the approver saw: re-checked against the amounts as they are now.
      overpaymentAccount: typeof params.overpayment_account === 'string' ? params.overpayment_account : undefined,
      overpaymentAmount: params.overpayment_amount === undefined ? undefined : Number(params.overpayment_amount),
      feeAccount: typeof params.fee_account === 'string' ? params.fee_account : undefined,
      feeAmount: params.fee_amount === undefined ? undefined : Number(params.fee_amount),
      // Re-bound to the candidate detected now: an approval staged before the
      // manual voucher was posted cannot slip through (issue #2294).
      force: params.force === true,
      expectedJournalEntryId:
        typeof params.expected_journal_entry_id === 'string' ? params.expected_journal_entry_id : undefined,
      overrideVia: 'pending_operation_force',
    },
  )
  if (!outcome.ok) {
    // Nothing was written, as in loadBookingContext: the operation stays pending.
    if (outcome.code === ACCOUNTING_METHOD_UNREADABLE || outcome.code === ACCOUNTING_METHOD_MISSING) {
      return accountingMethodRefusal({ code: outcome.code })
    }
    // A chart the user can complete keeps the operation pending, whatever
    // posted; any other typed error after the sale posted is a partial commit.
    if (outcome.error instanceof AccountsNotInChartError) throw outcome.error
    if (outcome.error) {
      if (outcome.partialPostedIds) {
        throw new PartialCommitError(
          `match_transaction_invoice failed after booking the invoice's sale: ${outcome.error instanceof Error ? outcome.error.message : outcome.code}`,
          outcome.partialPostedIds,
          outcome.error,
        )
      }
      throw outcome.error
    }
    const entry = getErrorEntry(outcome.code)
    const candidate = (outcome.details as { candidate?: { voucher_label: string; entry_date: string } } | undefined)?.candidate
    return {
      error: candidate
        ? `${entry?.message_sv ?? outcome.code} (verifikat ${candidate.voucher_label}, ${candidate.entry_date})`
        : (bankRowAlreadyBookedMessages(outcome.code, outcome.details)?.message_sv ?? entry?.message_sv ?? outcome.code),
      errorCode: outcome.code,
      status: MATCH_STATE_REFUSALS.has(outcome.code) ? 409 : (entry?.httpStatus ?? 400),
      ...(outcome.details ? { data: outcome.details } : {}),
      ...(outcome.partialPostedIds ? { partialPostedIds: outcome.partialPostedIds } : {}),
    }
  }

  return {
    data: {
      invoice_status: outcome.invoiceStatus,
      paid_amount: outcome.paidAmount,
      journal_entry_id: outcome.journalEntryId,
      ...(outcome.overpayment ? { overpayment: outcome.overpayment } : {}),
      ...(outcome.fee ? { fee: outcome.fee } : {}),
      // The sale verifikat this match booked first (defer_invoice_booking).
      ...(outcome.saleJournalEntryId ? { sale_journal_entry_id: outcome.saleJournalEntryId } : {}),
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
      // Customer side: the sale verifikat the link booked first
      // (defer_invoice_booking), when it did.
      ...('saleJournalEntryId' in outcome.result && outcome.result.saleJournalEntryId
        ? { sale_journal_entry_id: outcome.result.saleJournalEntryId }
        : {}),
      // Supplier side: the registration verifikat the link booked first
      // (defer_invoice_booking), when it did.
      ...('registrationJournalEntryId' in outcome.result && outcome.result.registrationJournalEntryId
        ? { registration_journal_entry_id: outcome.result.registrationJournalEntryId }
        : {}),
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
  // The staged share of the verifikat. A value that is not a number is refused
  // here: read as "no share stated" it would settle another amount than the
  // one the approver was shown.
  if (params.amount != null && typeof params.amount !== 'number') {
    return { error: 'amount must be a number', status: 400 }
  }
  const amount = (params.amount as number | null | undefined) ?? undefined

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
    amount,
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
    // Posting port: the storno records ledger.storno of the bank line, as both
    // uncategorize routes do; inside the approval the link basis resolves to
    // agent_proposed_user_approved.
    await postingPort.reverseJournalEntry({
      supabase,
      companyId,
      userId,
      entryId: journalEntryId,
      event: () => bankLineStornoBusinessEvent(txId, todayIsoStockholm(), linkBasisColumns('user_created')),
      role: 'reversal',
    })
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
      return { error: documentPeriodLockedSv(), status: 409, errorCode: refusal.code }
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
 * A document on a verifikat in a locked or closed year: the sentence every
 * door gives it (DOC_UPLOAD_PERIOD_LOCKED), naming the way forward.
 */
function documentPeriodLockedSv(): string {
  return getErrorEntry('DOC_UPLOAD_PERIOD_LOCKED')!.message_sv
}

/**
 * Shared failure mapping for both link executors. A locked period is the one
 * case worth its own sentence: it is recoverable by unlocking, unlike the rest,
 * and the raw trigger text is English database prose. Everything else goes
 * through getErrorMessage so nothing reaches the Granskning panel untranslated.
 */
function documentLinkFailureMessage(err: unknown): string {
  if (isPeriodLockRefusal(err)) return documentPeriodLockedSv()
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
    const status = isPeriodLockRefusal(err) || isDocumentLinkConflict(err) ? 409 : 500
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
    const result = await executeYearEndClosing(
      supabase,
      companyId,
      userId,
      id,
      // The posting port's events, while POSTING_EVENTS is on: the close
      // approved from this operation.
      () => ({ linkBasis: linkBasisColumns('user_created') }),
    )
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

// Per invoice (#3440): re-assesses the period, recomputes every carry and every
// correction of a cash verifikat booked before the cut-off, and posts only when
// the fingerprint the approver saw (acknowledgements included) still matches.
// The pre-flight (locks, filed VAT periods) runs again here, before any write.
async function commitPostKontantmetodCutoff(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>,
): Promise<ExecutorResult> {
  const fiscalPeriodId = params.fiscal_period_id as string
  const stagedPeriodEnd = params.period_end as string
  const stagedEntityType = params.entity_type as EntityType
  const stagedFingerprint = params.preview_fingerprint as string
  const stringList = (value: unknown): string[] | null =>
    value === undefined || value === null
      ? []
      : Array.isArray(value) && value.every((v) => typeof v === 'string')
        ? (value as string[])
        : null
  const acknowledgedFiledVatPeriods = stringList(params.acknowledge_filed_vat_periods)
  const acknowledgedLegacyInvoiceIds = stringList(params.acknowledge_legacy_invoice_ids)
  if (
    !fiscalPeriodId || !stagedPeriodEnd || !stagedEntityType || !stagedFingerprint ||
    !acknowledgedFiledVatPeriods || !acknowledgedLegacyInvoiceIds
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
  if (!hasEnded(period.period_end, todayIsoStockholm())) {
    return { error: 'Bokslutsavgränsningen kan bokföras först efter periodens slut', status: 409 }
  }
  if (period.period_end !== stagedPeriodEnd || settings?.entity_type !== stagedEntityType) {
    return { error: 'Period- eller företagsuppgifter har ändrats sedan förhandsgranskningen', status: 409 }
  }
  if (settings?.accounting_method !== 'cash') {
    return { error: 'Företaget använder inte kontantmetoden', status: 409 }
  }

  try {
    const entityType = parseEntityType(settings.entity_type)
    const assessment = await assessKontantmetodCutoff(
      supabase,
      companyId,
      period,
      null,
      entityType,
      { acknowledgedLegacyInvoiceIds },
    )

    // A legacy period (aggregate cut-off with vändning) takes no new posting:
    // its cut-off stands or is corrected by hand. Per invoice, nothing to
    // carry and nothing to correct means nothing to post.
    if (assessment.mode === 'legacy') {
      return {
        error:
          'Perioden har redan en äldre bokslutsavgränsning med vändning. Den bedöms som tidigare och inget nytt bokförs i den.',
        status: 409,
      }
    }
    let manualPlans: KontantmetodCarryPlan[]
    try {
      manualPlans = resolveKontantmetodManualCarries(assessment.collection, params.manual_carries)
    } catch (err) {
      if (err instanceof KontantmetodManualCarryError) {
        return { error: err.message, errorCode: err.code, status: 409 }
      }
      throw err
    }
    const allPlans = [...assessment.plans, ...manualPlans]

    if (allPlans.length === 0 && assessment.collection.paidBeforePosting.length === 0) {
      return {
        error: assessment.complete
          ? 'Kontantmetodens bokslutsavgränsning är redan bokförd för perioden'
          : 'Det finns inget att bokföra automatiskt: de fakturor som återstår måste hanteras manuellt',
        status: 409,
      }
    }

    const { corrections, refusals } = await previewPaidBeforePostingCorrections(
      supabase,
      companyId,
      assessment.collection.paidBeforePosting,
      assessment.plans,
    )
    const currentFingerprint = cutoffPreviewFingerprint({
      collection: assessment.collection,
      lines: assessment.lines,
      entityType,
      periodEnd: period.period_end,
      plans: allPlans,
      corrections,
      correctionRefusals: refusals,
      acknowledgedFiledVatPeriods,
      acknowledgedLegacyInvoiceIds,
    })
    if (currentFingerprint !== stagedFingerprint) {
      return {
        error:
          'Reskontran har ändrats sedan förhandsgranskningen. Skapa en ny förhandsgranskning innan du bokför.',
        status: 409,
      }
    }

    const preflight = await kontantmetodCutoffPreflight(supabase, companyId, {
      dates: kontantmetodCutoffWriteDates(
        period.period_end,
        allPlans,
        corrections,
      ),
      acknowledgedFiledVatPeriods,
      manualCorrectionDates: [
        ...assessment.collection.paidBeforePostingManual.map((m) => m.entryDate),
        ...refusals.map((r) => r.entryDate),
      ].filter((date): date is string => !!date),
    })
    if (!preflight.ok) {
      return {
        error: preflight.message_sv,
        errorCode: preflight.code,
        status: getErrorEntry(preflight.code)?.httpStatus ?? 409,
      }
    }

    const correctable = new Set(corrections.map((c) => `${c.side}:${c.invoiceId}:${c.entryId}`))
    const result = await postKontantmetodCutoff(supabase, companyId, userId, {
      fiscalPeriodId,
      periodEnd: period.period_end,
      plans: allPlans,
      paidBeforePosting: assessment.collection.paidBeforePosting.filter((item) =>
        correctable.has(`${item.side}:${item.invoiceId}:${item.entryId}`),
      ),
      unknownVatTreatment: assessment.collection.unknownVatTreatment,
      strayVatOnZeroRate: assessment.collection.strayVatOnZeroRate,
      // The posting port's events, while POSTING_EVENTS is on: the cut-off
      // approved from this operation.
      posting: () => ({ linkBasis: linkBasisColumns('user_created') }),
    })

    return {
      data: {
        posted: result.posted.map((carry) => ({
          side: carry.side,
          invoice_id: carry.invoiceId,
          reference: carry.reference,
          journal_entry_id: carry.entryId,
        })),
        compensated: result.compensated.map((carry) => ({
          side: carry.side,
          invoice_id: carry.invoiceId,
          reference: carry.reference,
          journal_entry_id: carry.entryId,
          storno_entry_id: carry.stornoEntryId,
          code: carry.code,
        })),
        corrected: result.corrected.map((c) => ({
          side: c.side,
          invoice_id: c.invoiceId,
          reference: c.reference,
          cash_entry_id: c.entryId,
          storno_entry_id: c.stornoEntryId,
          correction_entry_id: c.correctionEntryId,
        })),
        correction_failed: result.correctionFailed.map((c) => ({
          side: c.side,
          invoice_id: c.invoiceId,
          reference: c.reference,
          cash_entry_id: c.entryId,
          code: c.code,
          message: c.message,
        })),
        manual_corrections: refusals.map((r) => ({
          side: r.side,
          invoice_id: r.invoiceId,
          reference: r.reference,
          cash_entry_id: r.entryId,
          entry_date: r.entryDate,
          reason: r.reason,
          code: 'KONTANTMETOD_CUTOFF_PAID_BEFORE_POSTING_MANUAL',
        })),
        amended_vat_periods_required: preflight.amendedVatPeriodsRequired,
        remaining: result.remaining,
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
    const entry = await generateOpeningBalances(
      supabase,
      companyId,
      userId,
      closedId,
      nextId,
      // The posting port's event, while POSTING_EVENTS is on: the IB
      // approved from this operation.
      () => ({ linkBasis: linkBasisColumns('user_created') }),
    )
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
  userId: string,
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
    // The approver acts: the own-development mark's audit row names them.
    const asset = await updateFixedAsset(supabase, companyId, assetId, parsed.data, { userId })
    const posted = await hasPostedDepreciation(supabase, companyId, assetId)
    return { data: { asset_id: asset.id, ...assetView(asset, posted) } }
  } catch (err) {
    if (err instanceof AssetCorrectionBlockedError) {
      return { error: err.message, errorCode: err.code, status: 409 }
    }
    return failUnlessBookkeepingError(err, 'Asset update failed', 400)
  }
}

/**
 * Remove a register row that never reached the books (crm#1452). The rule is
 * decided again here, under the asset row lock, by delete_never_posted_asset:
 * a depreciation posted after staging refuses the delete.
 */
async function commitDeleteAsset(
  supabase: SupabaseClient,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const assetId = params.asset_id
  if (typeof assetId !== 'string' || !assetId) return { error: 'asset_id is required', status: 400 }
  try {
    const asset = await deleteNeverPostedAsset(supabase, companyId, assetId)
    return { data: { asset_id: asset.id, name: asset.name, deleted: true } }
  } catch (err) {
    const code = (err as { code?: unknown }).code
    if (code === 'ASSET_NOT_FOUND' || code === 'ASSET_DELETE_BLOCKED') {
      return {
        error: (err instanceof Error && err.message) || code,
        errorCode: code,
        status: code === 'ASSET_NOT_FOUND' ? 404 : 409,
      }
    }
    return failUnlessBookkeepingError(err, 'Asset deletion failed', 400)
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
  params: Record<string, unknown>,
  attestDecisions?: AttestDecisionBatch,
): Promise<ExecutorResult> {
  const id = params.supplier_invoice_id as string
  if (!id) return { error: 'supplier_invoice_id is required', status: 400 }

  // The approving person attests: the company's attest policy (who may
  // attest, four eyes, any or all) is applied to them, in the same service
  // as the dashboard and v1 (lib/supplier-invoices/attest-service.ts).
  // Staged operations can be committed twice (retry, two approvers): the
  // service's optimistic guard sets approved_at and emits the event once.
  // In a bulk approval the registrant hears once, for all of them: the
  // service adds the answer to the batch the moment the attest is stored.
  const outcome = await approveSupplierInvoice(
    { supabase, companyId, userId, log: createLogger('pending-operations/approve-supplier-invoice') },
    { invoiceId: id, source: 'mcp', ...(attestDecisions ? { decisions: attestDecisions } : {}) },
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

/** A refused conversion as the approval's failure, or the invoice a re-fired commit already made. */
function inboxConversionFailure(
  outcome: Extract<OperationOutcome<unknown>, { ok: false }>,
  inboxItemId: string,
): ExecutorResult {
  // Idempotency: a re-fired commit (a retry, a double click on the approval, a
  // racy MCP call) must not make a second leverantörsfaktura for the same row.
  if (outcome.code === 'INBOX_ITEM_ALREADY_CONVERTED') {
    return { data: { supplier_invoice_id: outcome.details?.supplier_invoice_id, inbox_item_id: inboxItemId, idempotent: true } }
  }
  if (outcome.code === ACCOUNTING_METHOD_UNREADABLE || outcome.code === ACCOUNTING_METHOD_MISSING) {
    return accountingMethodRefusal({ code: outcome.code })
  }
  // Resolved before an ankomstnummer is drawn, so a temporary Riksbanken
  // refusal leaves the operation approvable.
  if (outcome.details?.temporary) return exchangeRateRetryLater()
  if (isBookkeepingError(outcome.error)) throw outcome.error

  const invalidColumn = describeSupplierInvoiceInputViolation(outcome.error as { code?: string; message?: string } | null)
  if (invalidColumn) {
    return {
      error: `${getErrorEntry('SI_CREATE_INVALID_INPUT')?.message_sv ?? 'Ogiltig kombination av fakturafält.'} ${invalidColumn}`,
      errorCode: 'SI_CREATE_INVALID_INPUT',
      status: 400,
    }
  }
  const entry = getErrorEntry(outcome.code)
  if (outcome.code === 'UNKNOWN_ERROR' || !entry) {
    log.error('Failed to register a supplier invoice from the inbox', { inboxItemId, error: outcome.error })
    return { error: 'Failed to create supplier invoice', status: 500 }
  }
  return {
    error: outcome.messageSv ?? siCreateInvalidInputMessages(outcome.details)?.message_en ?? entry.message_sv,
    errorCode: outcome.code,
    status: entry.httpStatus,
    ...(outcome.details ? { data: outcome.details } : {}),
  }
}

/**
 * The approval of a staged conversion: convertInboxItemToSupplierInvoice, the
 * door the dashboard and v1 use, on what was staged. A staged line stays as
 * the approver saw it (stagedConversion).
 */
async function commitCreateSupplierInvoiceFromInbox(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const staged = stagedConversion(params)
  if (!staged.ok) {
    const entry = staged.code ? getErrorEntry(staged.code) : undefined
    return {
      error: staged.error ?? entry?.message_sv ?? 'Invalid staged conversion',
      ...(staged.code ? { errorCode: staged.code } : {}),
      status: entry?.httpStatus ?? 400,
    }
  }

  const outcome = await convertInboxItemToSupplierInvoice(
    { supabase, companyId, userId, log },
    staged.inboxItemId,
    staged.body,
    { approvedTotal: staged.approvedTotal },
  )
  if (!outcome.ok) return inboxConversionFailure(outcome, staged.inboxItemId)
  if (outcome.dryRun) return { data: outcome.preview }
  return {
    data: {
      supplier_invoice_id: outcome.data.invoice.id,
      inbox_item_id: staged.inboxItemId,
      registration_journal_entry_id: outcome.data.registration_journal_entry_id,
      arrival_number: outcome.data.invoice.arrival_number,
      // Why a payment of it waits, as the dashboard and v1 doors say it.
      ...(outcome.warnings?.length ? { warnings: outcome.warnings } : {}),
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
  // gnubok_credit_supplier_invoice stages are passed on: the inbox item and
  // the credit note's date (crm#1733), so the approval books on the date the
  // staged preview showed.
  const parsed = CreditSupplierInvoiceInputSchema.safeParse({
    ...(typeof params.inbox_item_id === 'string' ? { inbox_item_id: params.inbox_item_id } : {}),
    ...(typeof params.credit_date === 'string' ? { credit_date: params.credit_date } : {}),
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
      // accounted#58: the deferred original was booked before the credit
      // failed: failed_partial with its verifikat id, never a plain refusal.
      ...(outcome.partialPostedIds ? { partialPostedIds: outcome.partialPostedIds } : {}),
    }
  }
  if (outcome.dryRun) return { data: outcome.preview }
  return {
    data: {
      credit_note_id: outcome.data.credit_note.id,
      journal_entry_id: outcome.data.journal_entry_id,
      // accounted#58: the deferred original was booked first, on its own date.
      ...(outcome.data.original_journal_entry_id ? { original_journal_entry_id: outcome.data.original_journal_entry_id } : {}),
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
      warning: CREDIT_NOTE_NOT_DELIVERED.message,
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
  // Only a literal true leaves the file's unused #KONTO definitions out (#63).
  const onlyUsedAccounts = params.only_used_accounts === true
  // Append the file's new vouchers to the year's import (issue #108): only
  // the literal value; the job plans again and refuses what changed since.
  const append = params.on_existing_year === 'append'
  const includePossibleDuplicates = params.include_possible_duplicates === true
  // The append's series map as staged (crm#1751); submitSIEJob checks its
  // shape with the schema the staging tool read it by.
  const seriesMap = append && params.series_map !== undefined ? params.series_map as Record<string, string> : undefined

  if (!fileContent || !filename || !Array.isArray(mappings)) {
    return { error: 'file_content, filename, and mappings are required', status: 400 }
  }

  // Only an MCP tool stages import_sie: the agent sent the file, the person approved it.
  let job: Awaited<ReturnType<typeof submitSIEJob>>
  try {
    job = await submitSIEJob(supabase,companyId,userId,fileContent,mappings,{
      filename,createFiscalPeriod,importOpeningBalances,importTransactions,voucherSeries,openingBalanceSeries,updateAccountNames,
      confirmOrgNumberMismatch,...(onlyUsedAccounts ? { onlyUsedAccounts } : {}),
      ...(append ? { onExistingPeriod: 'append' as const, ...(includePossibleDuplicates ? { includePossibleDuplicates } : {}),
        ...(seriesMap ? { seriesMap } : {}) } : {}),
    },undefined,'sie_file',{source:'sie',via:'mcp',fetchedBy:{type:'user',user_id:userId,label:'mcp-approval'}})
  } catch (err) {
    // A refusal the job RPC raised rolled back: nothing started. It answers
    // with its code, the reader's sentence and the registry's remediation,
    // not the database's English: an agent that read "Existing SIE import
    // requires reviewed replacement or reconciliation" had nothing to act on
    // (crm#1272).
    // An append refusal (a user-facing SIEJobValidationError, sie-append.ts)
    // answers the same way, its sentence naming the vouchers.
    const coded = err instanceof SIEJobDatabaseError || (err instanceof SIEJobValidationError && userFacingCode(err))
      ? err as SIEJobDatabaseError | SIEJobValidationError : null
    const entry = coded?.code?.startsWith('SIE_') ? getErrorEntry(coded.code) : undefined
    if (entry && coded) {
      return {
        error: userFacingCode(coded) ? coded.message : entry.message_sv,
        status: entry.httpStatus,
        errorCode: coded.code,
        ...(entry.remediation ? { data: { remediation: entry.remediation } } : {}),
      }
    }
    throw err
  }
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
    // A foreign underlag booked with its own total as a kronor line posts
    // 100 EUR as 100 kr (crm#1146): the book-direct route and its dialog
    // refuse it, and so does this door, at staging and again here.
    const fxRefusal = bookDirectFxRefusal(booking.extracted_data as Parameters<typeof bookDirectFxRefusal>[0], null, lines)
    if (fxRefusal === 'face_amount') {
      return {
        error: getErrorEntry('INBOX_BOOK_DIRECT_FX_FACE_AMOUNT')?.message_sv ?? 'Beloppen är underlagets belopp i utländsk valuta, inte kronor.',
        errorCode: 'INBOX_BOOK_DIRECT_FX_FACE_AMOUNT',
        status: 400,
        data: { currency: bookDirectDocumentCurrency(booking.extracted_data as Parameters<typeof bookDirectDocumentCurrency>[0]) },
      }
    }
    // The other half of this purchase is booked already: approving would book it twice.
    const pairBooked = await refuseWhenPairBooked(supabase, companyId, inboxItemId)
    if (pairBooked) return { error: pairBooked.messageSv, errorCode: pairBooked.code, status: 409, data: pairBooked.details }
  }

  // The booking-time warnings again at approval, against the books as they
  // are now: a duplicate posted since the staging is refused until it too is
  // confirmed (lib/bookkeeping/voucher-warnings-guard.ts). An IB is never asked.
  const voucherGuard =
    sourceType === 'manual'
      ? await runVoucherWarningsGuard(supabase, companyId, { entry_date: entryDate, description, lines }, log, {
          // What the agent's user confirmed at staging, and what the approver
          // confirmed in the app after this approval was refused once.
          acknowledged: [
            ...(Array.isArray(params.acknowledged_warnings) ? (params.acknowledged_warnings as string[]) : []),
            ...(opts.acknowledgedWarnings ?? []),
          ],
        })
      : null
  if (voucherGuard && !voucherGuard.ok) {
    return {
      error: getErrorEntry('VOUCHER_NEEDS_CONFIRMATION')?.message_sv ?? 'Verifikationen behöver bekräftas.',
      errorCode: voucherGuard.code,
      status: 409,
      data: voucherGuard.details,
    }
  }

  try {
    // Posting port (step 2i): while POSTING_EVENTS is on, the voucher's
    // event (the kind its source type names; agent_proposed_user_approved,
    // this approval as evidence) is linked before a number is drawn.
    const entry = await postingPort.postJournalEntry({
      supabase,
      companyId,
      userId,
      event: () =>
        manualVoucherBusinessEvent({
          sourceType,
          entryDate,
          linkBasis: linkBasisColumns('user_created'),
          inboxItemId,
          documentId: inboxItemId ? (params.document_id as string | undefined) : undefined,
        }),
      input: {
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
      commitMethod: opts.commitMethod ?? 'user_accept',
    })
    if (voucherGuard?.ok) {
      await recordVoucherWarningsAcknowledged({
        companyId,
        userId,
        journalEntryId: entry.id,
        warnings: voucherGuard.acknowledged,
        door: opts.acknowledgedWarnings?.length ? 'pending_approval' : 'mcp_create_voucher',
        log,
      })
    }

    // Claim the inbox item for this verifikat. Two approvals of different
    // staged ops for the same item can both pass the read above; the
    // compare-and-set lets one keep its verifikat and reverses the other's
    // (storno), so the books never hold the underlag twice. Before the IB
    // link and the document attach: a loser must leave neither behind.
    if (inboxItemId) {
      const claim = await claimInboxItemOrReverseEntry(supabase, companyId, userId, inboxItemId, entry.id, {
        expected: replacesEntryId,
        // The storno of a lost claim through the port too: ledger.storno of
        // the inbox item, made of the door's own accord (system_derived).
        stornoEvent: () => ownRowsStornoBusinessEvent({ type: 'inbox_item', id: inboxItemId }, todayIsoStockholm(), linkBasisColumns('system_derived')),
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
        await linkToJournalEntry(supabase, companyId, documentId, entry.id, linkBasisColumns('user_created'))
      } catch (linkDocErr) {
        log.warn('Failed to attach inbox document to new voucher', {
          documentId,
          journalEntryId: entry.id,
          error: linkDocErr instanceof Error ? linkDocErr.message : String(linkDocErr),
        })
      }
    }

    // The receipt this invoice came with as one purchase follows it onto the
    // voucher (lib/operations/inbox-companion.ts), so an agent's booking
    // never leaves it in the inbox to be booked twice. Best effort.
    if (inboxItemId) await followPairedReceipt({ supabase, companyId, userId, log }, inboxItemId)

    // A posted typed verifikat meets the open bank row it books
    // (lib/reconciliation/voucher-bank-link.ts). Last, once the claim above
    // is won: a verifikat reversed for a lost claim never takes a row.
    const bankLink = voucherGuard?.ok
      ? await linkOpenBankRowsToVoucher(supabase, companyId, userId, { journalEntryId: entry.id, entryDate, lines }, log)
      : null

    return {
      data: {
        journal_entry_id: entry.id,
        voucher_number: entry.voucher_number,
        voucher_series: entry.voucher_series,
        fiscal_period_id: fiscalPeriodId,
        // inbox_linked stays in the result for callers that read it; a
        // committed op with an inbox item has always claimed it now.
        ...(inboxItemId ? { inbox_item_id: inboxItemId, inbox_linked: true } : {}),
        // Said only when it happened, so an agent does not link the same row
        // once more (gnubok_reconcile_match would answer ALREADY_LINKED).
        ...(bankLink && bankLink.linked > 0 ? { bank_rows_linked: bankLink.linked } : {}),
        ...(bankLink && bankLink.suggested > 0 ? { bank_rows_suggested: bankLink.suggested } : {}),
      },
    }
  } catch (err) {
    return failUnlessBookkeepingError(err, 'Failed to create voucher', 500)
  }
}

/**
 * Whether the staged correction already moved to the first open period when
 * it was staged: gnubok_correct_entry states the moved pair's date as
 * preview.correction.entry_date, and only then, with the VAT advice for it
 * (VAT_OF_MOVED_CORRECTION) among preview.warnings.
 */
function stagedAsMovedCorrection(preview: Record<string, unknown> | null | undefined): boolean {
  const correction = preview?.correction
  return (
    correction !== null &&
    typeof correction === 'object' &&
    typeof (correction as Record<string, unknown>).entry_date === 'string'
  )
}

async function commitCorrectEntry(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>,
  preview?: Record<string, unknown> | null,
): Promise<ExecutorResult> {
  const entryId = params.entry_id as string
  const lines = normalizeVoucherLines(params.lines)

  if (!entryId || lines.length < 2) {
    return { error: 'entry_id and at least two lines are required', status: 400 }
  }

  // Pre-flight: verify the original is posted. Where the storno and the
  // corrected verifikat land is correctEntry's own check (assertStornoTarget,
  // the one the staging tool ran): on the original's date in an open year,
  // else in the first open, unlocked period after it, refused with a typed
  // error before anything is written when neither works.
  const { data, error: origErr } = await supabase
    .from('journal_entries')
    .select(
      'id, status, entry_date, fiscal_period_id, source_type, lines:journal_entry_lines(account_number, debit_amount, credit_amount)',
    )
    .eq('id', entryId)
    .eq('company_id', companyId)
    .maybeSingle()
  const original = data as unknown as {
    id: string
    status: string
    entry_date: string
    fiscal_period_id: string
    source_type: string | null
    lines: Array<{ account_number: string; debit_amount: number | string; credit_amount: number | string }> | null
  } | null

  if (origErr || !original) {
    return { error: 'Verifikationen hittades inte.', status: 404 }
  }
  if (original.status !== 'posted') {
    return {
      error: `Endast bokförda verifikationer kan rättas. Aktuell status: ${original.status}. Drafts redigeras direkt.`,
      status: 409,
    }
  }

  try {
    // The original's period was locked after this proposal was staged: the
    // pair would now land in the first open period, and when it changes VAT
    // the approver never saw which momsperiod the error belongs to. Refused
    // before anything is written, so the correction is staged again and its
    // preview carries that advice (the same landing check every correction
    // door previews with). A proposal staged as moved carried it already.
    if (!stagedAsMovedCorrection(preview)) {
      const landing = await correctionLanding(supabase, companyId, original, lines)
      if (landing.target.moved && landing.vatWarning) {
        const entry = getErrorEntry('CORRECTION_MOVED_SINCE_STAGED')
        return {
          error: entry?.message_sv ?? 'Rättelsen ändrar momsen och skulle nu bokföras i första öppna period. Inget har bokförts.',
          errorCode: 'CORRECTION_MOVED_SINCE_STAGED',
          status: entry?.httpStatus ?? 409,
          data: { entry_date: landing.target.date, vat_warning: landing.vatWarning },
        }
      }
    }

    // Posting port (step 2i): ledger.storno and ledger.correction of the
    // verifikat while POSTING_EVENTS is on, this approval as evidence.
    const result = await postingPort.correctJournalEntry({
      supabase,
      companyId,
      userId,
      entryId,
      ...correctionBusinessEvents({ entryId, occurredOn: todayIsoStockholm, linkBasis: () => linkBasisColumns('user_created') }),
      correction: {
        lines,
        options: {
          // Staged by the MCP tool when the agent explicitly overrode the
          // chain-depth guard; the guard re-checks here so a stale approval of a
          // chain that grew deeper in the meantime still stops.
          allowDeepChain: params.allow_deep_chain === true,
          // The corrected entry's text when the agent gave one; rows staged
          // without it keep correctEntry's "Rättelse: <original text>".
          description: typeof params.description === 'string' ? params.description : undefined,
          // Staged only when the agent said the original had debit and
          // credit swapped; without it a correction that negates the
          // original is refused here too (crm#1397).
          ...(params.sides_swapped === true ? { sidesSwapped: true } : {}),
          // A locked or closed original is corrected in the first open
          // period, as the staging preview said.
          inFirstOpenPeriodWhenLocked: true,
        },
      },
    })
    // The original's date took no write (its period was locked, perhaps
    // after the proposal was staged): the pair landed in the first open
    // period, and the answer says so instead of implying the original's date.
    const moved =
      !!original.entry_date && !!result.reversal.entry_date && result.reversal.entry_date !== original.entry_date
    return {
      data: {
        original_entry_id: entryId,
        storno_entry_id: result.reversal.id,
        corrected_entry_id: result.corrected.id,
        storno_voucher_number: result.reversal.voucher_number,
        corrected_voucher_number: result.corrected.voucher_number,
        ...(moved
          ? {
              moved_to_first_open_period: true,
              entry_date: result.reversal.entry_date,
              note_sv: `Originalets period var låst: stornot och rättelsen bokfördes ${result.reversal.entry_date} i första öppna period, med hänvisning till originalet.`,
            }
          : {}),
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
    // Posting port (step 2i): ledger.storno of the verifikat while
    // POSTING_EVENTS is on, this approval as evidence.
    const reversal = await postingPort.reverseJournalEntry({
      supabase,
      companyId,
      userId,
      entryId,
      reversalDate,
      options: { allowDeepChain: params.allow_deep_chain === true },
      event: () => voucherStornoBusinessEvent({ entryId, occurredOn: todayIsoStockholm(), linkBasis: linkBasisColumns('user_created') }),
      role: 'reversal',
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
        voucher: formatVoucher({ voucher_series: result.voucherSeries, voucher_number: result.voucherNumber }),
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
  userId: string,
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
    // userId: the approver, to whom a kollektivavtal confirmation in the
    // patch is attributed in audit_log (the credential is the actor scope).
    const result = await updateEmployee(supabase, { companyId, employeeId, patch, userId })
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
      hoursPerDay: (params.hours_per_day as number | null | undefined) ?? undefined,
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
      // Staged by gnubok_book_salary_run after the user confirmed a payment
      // date still ahead (crm#1216); the executor refuses it otherwise.
      confirmPaymentDateAhead: params.confirm_payment_date_ahead === true,
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
    return {
      data: { account_key: accountKey, signoff: result.signoff, bank_balance: result.bank_balance, warning: result.warning },
    }
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
  // The operation id rides along for suggestion_log.pending_operation_id,
  // its agent_reason for the receipt's copy.
  const run = () =>
    runInOperationCommit(
      pendingOp.id,
      () => commitPendingOperationInner(supabase, userId, companyId, pendingOp, opts),
      pendingOp.agent_reason ?? null,
    )
  if (!opts.actor) return run()
  // The key's unattended ceiling is the operation's, priced on its preview
  // before the claim below, where a refusal keeps it pending. The executor
  // runs without it: the engine's own check (lib/bookkeeping/unattended-ceiling.ts)
  // would refuse inside the claim, where a throw consumes the operation.
  const { unattendedCommitLimit: _priced, ...dispatchActor } = opts.actor
  // The approver is the person the dispatch acts for: the audit log names
  // them for its service-role writes (lib/supabase/actor-header.ts).
  const actor = { ...dispatchActor, userId: dispatchActor.userId ?? userId }
  // Only a person's single approval in the app is a review of the booking:
  // a bulk approval, a key or an agent never stamps one (accounted#130).
  return runWithActor(
    opts.commitMethod && opts.commitMethod !== 'user_accept' ? { ...actor, withoutReview: true } : actor,
    run,
  )
}

async function commitPendingOperationInner(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  pendingOp: PendingOperation,
  opts: CommitOptions = {}
): Promise<CommitResult> {
  // ── A scheduled or system turn never approves: approval is a person's act,
  //    in their own session or through a key they hold. First, before any
  //    gate or the claim, so the op stays 'pending' for a person.
  if (opts.actor?.type === 'cron' || opts.actor?.type === 'system') {
    return {
      status: 'failed',
      error:
        getErrorEntry('PENDING_OPERATION_SYSTEM_APPROVAL_FORBIDDEN')?.message_sv ??
        'En schemalagd körning eller systemet kan inte godkänna ett förslag.',
      http_status: 403,
      code: 'PENDING_OPERATION_SYSTEM_APPROVAL_FORBIDDEN',
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
    // A grant answers its own code, pointing the person to Att göra.
    const webOnlyCode = webOnlyRefusalCode(pendingOp.operation_type)
    return {
      status: 'failed',
      error: getErrorEntry(webOnlyCode)?.message_sv ?? 'Det här måste godkännas av en person i Accounted.',
      http_status: 403,
      code: webOnlyCode,
      operation_status: 'pending',
    }
  }

  // ── Hard blocks (accounted#130 step 2): a staged booking a booking review
  //    rule matches is approved by a person in the app, one at a time, never
  //    through a key, MCP, a grant or a bulk approval; with booking_review
  //    limits set, by a person whose limit covers the amount. Refused before
  //    the claim, so the op stays 'pending' for that person.
  const bookingReview = await stagedBookingReview(supabase, companyId, pendingOp)
  if (bookingReview) {
    if (!(opts.commitMethod === 'user_accept' && opts.actor?.type === 'user')) {
      return {
        status: 'failed',
        error: getErrorEntry('BOOKING_REVIEW_WEB_ONLY')?.message_sv ?? 'Det här måste godkännas av en person i Accounted.',
        http_status: 403,
        code: 'BOOKING_REVIEW_WEB_ONLY',
        operation_status: 'pending',
      }
    }
    const limit = await bookingReviewLimitCovers(supabase, companyId, userId, bookingReview.amountSek)
    if (!limit.covered) {
      return {
        status: 'failed',
        error: getErrorEntry('BOOKING_REVIEW_LIMIT')?.message_sv ?? 'Din attestgräns täcker inte beloppet.',
        http_status: 403,
        code: 'BOOKING_REVIEW_LIMIT',
        operation_status: 'pending',
      }
    }
  }

  // ── The daily collections batch: an administrator approves it, and the
  //    batch's start gates must still say yes. Refused before the claim, so
  //    the batch stays 'pending' (the ladder cron rejects it after 72 hours).
  if (pendingOp.operation_type === COLLECTIONS_BATCH_TYPE || pendingOp.operation_type === REMINDER_BATCH_TYPE) {
    // The reminder batch: an owner or administrator, while reminders are on.
    const refused =
      pendingOp.operation_type === COLLECTIONS_BATCH_TYPE
        ? await batchApprovalRefusal(supabase, companyId)
        : await reminderBatchApprovalRefusal(supabase, companyId)
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

  // ── The sandbox gate: the same operations reach the same paid services, and
  //    a sandbox holds a trial of them all, so the capability above says yes.
  //    The routes run guardSandbox; an approval comes through here instead.
  if (requiredCapability && (await isSandboxCompany(supabase, companyId))) {
    return {
      status: 'failed',
      error: SANDBOX_BLOCKED_MESSAGE_SV,
      http_status: 403,
      code: 'sandbox_blocked',
      operation_status: 'pending',
    }
  }

  // ── Package start gate (commit-time twin of the doors' gate,
  //    lib/modules/package-doors.ts). Approving a staged start (a new
  //    invoice, salary run, asset, ...) starts that work now, so it refuses
  //    while the company has the package switched off or winding down, even
  //    when it was staged before the switch. Before the claim, so the op stays
  //    'pending' and commits once the package is on again.
  const startPackage = startPackageForPendingType(
    pendingOp.operation_type,
    operationForPendingType(pendingOp.operation_type)?.id,
  )
  if (startPackage) {
    const refusal = await packageStartRefusal(supabase, companyId, startPackage)
    if (refusal) {
      return {
        status: 'failed',
        error: refusal.messageSv,
        http_status: refusal.status,
        code: refusal.code,
        operation_status: 'pending',
      }
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
  //
  //    An attest with attest levels on is capped by the lower of the key's
  //    ceiling and the person's attest limit (#135): over it, the op stays
  //    pending for a person, as over the ceiling. The database's ruling caps
  //    it too, but only after the claim.
  const keyActor = opts.actor?.type === 'api_key' || opts.actor?.type === 'mcp_oauth' || opts.actor?.type === 'service_account'
  const attestInvoiceId = pendingOp.params?.supplier_invoice_id
  const attestCap =
    keyActor && pendingOp.operation_type === 'approve_supplier_invoice' && typeof attestInvoiceId === 'string'
      ? await personalAttestCap(supabase, companyId, userId, attestInvoiceId)
      : null
  const keyCeiling = opts.actor?.unattendedCommitLimit ?? null
  const unattended = exceedsUnattendedLimit({
    actorType: opts.actor?.type,
    limit: attestCap !== null && (keyCeiling === null || keyCeiling <= 0 || attestCap < keyCeiling) ? attestCap : keyCeiling,
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

  // ── A grant only ever carries a key credential's own operation of a type a
  //    grant covers (lib/grants/enforce.ts after claim_company_grant). Any
  //    other use is a programming error and is refused before the claim, so
  //    the op stays pending for a person.
  if (
    opts.grant &&
    (!(GRANT_OPERATION_TYPES as readonly string[]).includes(pendingOp.operation_type) ||
      !opts.actor ||
      !['api_key', 'mcp_oauth', 'service_account'].includes(opts.actor.type))
  ) {
    return {
      status: 'failed',
      error: getErrorEntry('GRANT_NOT_APPLICABLE')?.message_sv ?? 'GRANT_NOT_APPLICABLE',
      http_status: 403,
      code: 'GRANT_NOT_APPLICABLE',
      operation_status: 'pending',
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
        result = await commitCategorizeTransaction(supabase, userId, companyId, pendingOp.params, opts.duplicateReview)
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
        result = await commitApproveSupplierInvoice(supabase, userId, companyId, pendingOp.params, opts.attestDecisions)
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
      case 'enable_package':
        result = await commitPackageSwitch(userId, companyId, pendingOp, true)
        break
      case 'disable_package':
        result = await commitPackageSwitch(userId, companyId, pendingOp, false)
        break
      case 'create_grant':
        result = await commitGrantDecision(userId, companyId, pendingOp, 'create')
        break
      case 'revoke_grant':
        result = await commitGrantDecision(userId, companyId, pendingOp, 'revoke')
        break
      case 'import_sie':
        result = await commitImportSie(supabase, userId, companyId, pendingOp.params)
        break
      case 'create_voucher':
        result = await commitCreateVoucher(supabase, userId, companyId, pendingOp.params, opts)
        break
      case 'correct_entry':
        result = await commitCorrectEntry(supabase, userId, companyId, pendingOp.params, pendingOp.preview_data)
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
        result = await commitUpdateAsset(supabase, userId, companyId, pendingOp.params)
        break
      case 'dispose_asset':
        result = await commitDisposeAsset(supabase, userId, companyId, pendingOp.params)
        break
      case 'delete_asset':
        result = await commitDeleteAsset(supabase, companyId, pendingOp.params)
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
        result = await commitUpdateEmployee(supabase, userId, companyId, pendingOp.params)
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
      case 'reminder_daily_batch': {
        const batch = await commitReminderDailyBatch({ userId, companyId, operation: { id: pendingOp.id, params: pendingOp.params } })
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
        result = await commitRegisteredOperation(operation, supabase, userId, companyId, pendingOp.params, pendingOp.id)
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
    // A hard block (accounted#130, #145): commit_journal_entry refused the
    // booking before a voucher number was drawn, because a booking review
    // rule matches it and this approval is no person's review in the app (or
    // the person's booking_review limit does not cover it). Nothing is
    // posted and the executors roll back what they wrote before it, so the
    // operation goes back to 'pending' for a person who may approve it,
    // whatever operation type booked it.
    if (err instanceof BookingReviewRequiredError || err instanceof BookingReviewLimitError) {
      await supabase
        .from('pending_operations')
        .update({ status: 'pending' })
        .eq('id', pendingOp.id)
      const code = err instanceof BookingReviewLimitError ? 'BOOKING_REVIEW_LIMIT' : 'BOOKING_REVIEW_WEB_ONLY'
      return {
        status: 'failed',
        error: getErrorEntry(code)?.message_sv ?? err.message,
        http_status: 403,
        code,
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
    // The app's single approval (keepFixableRefusals) and a refusal the
    // person can fix around the proposal (fixable-refusals.ts: refused before
    // any write, and what is wrong lies outside the proposal): the operation
    // goes back to 'pending' with the code and the executor's details, so the
    // page says what to fix and the same approval can be given again.
    if (
      opts.keepFixableRefusals &&
      fixableRefusalFor(pendingOp.operation_type, result.errorCode)
    ) {
      await supabase
        .from('pending_operations')
        .update({ status: 'pending' })
        .eq('id', pendingOp.id)
      return {
        status: 'failed',
        error: result.error,
        http_status: result.status,
        ...(result.errorCode ? { code: result.errorCode } : {}),
        ...(result.data && Object.keys(result.data).length > 0 ? { data: result.data } : {}),
        operation_status: 'pending',
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
    if (
      result.status === 401 ||
      result.status === 403 ||
      result.returnToPending ||
      result.errorCode === 'BOOKING_REVIEW_REQUIRED' ||
      result.errorCode === 'BOOKING_REVIEW_LIMIT' ||
      // The categorize core's word for the same database refusal.
      result.errorCode === 'TX_CATEGORIZE_REVIEW_REQUIRED' ||
      // A read behind the bank row gate failed, before any write: the same
      // approval can be given again.
      result.errorCode === 'BANK_ROW_READ_FAILED' ||
      // The app's single approval answers a possible duplicate itself
      // (duplicateReview): the proposal waits for that answer. A candidate
      // that changed since the person looked is asked again the same way.
      (opts.duplicateReview !== undefined &&
        pendingOp.operation_type === 'categorize_transaction' &&
        (result.errorCode === 'TRANSACTION_BOOK_POSSIBLE_DUPLICATE' ||
          result.errorCode === 'TRANSACTION_BOOK_FORCE_CANDIDATE_MISMATCH'))
    ) {
      await supabase
        .from('pending_operations')
        .update({ status: 'pending' })
        .eq('id', pendingOp.id)
      return {
        status: 'failed',
        error: result.error,
        http_status: result.status,
        ...(result.errorCode ? { code: result.errorCode } : {}),
        ...(result.data && Object.keys(result.data).length > 0 ? { data: result.data } : {}),
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

  // Under a grant, the operation records the rule that let it through.
  const resultData: Record<string, unknown> = opts.grant
    ? {
        ...(result.data || {}),
        grant: { grant_id: opts.grant.grantId, grant_version: opts.grant.grantVersion, use_id: opts.grant.useId },
      }
    : result.data || {}
  const now = new Date().toISOString()
  const { error: finalizeError } = await supabase
    .from('pending_operations')
    .update({
      status: 'committed',
      resolved_at: now,
      result_data: resultData,
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
    ...(opts.grant ? { grant: { grantId: opts.grant.grantId, grantVersion: opts.grant.grantVersion } } : {}),
    ...(opts.approvalDoor ? { door: opts.approvalDoor } : {}),
  })

  return {
    status: 'committed',
    data: opts.grant ? resultData : result.data,
    operation_status: 'committed',
  }
}
