import type {
  JournalEntry,
  Invoice,
  Transaction,
  Customer,
  Supplier,
  Article,
  FiscalPeriod,
  DocumentAttachment,
  CreditNote,
  ReconciliationMethod,
  InvoiceInboxItem,
  SupplierInvoice,
} from '@/types'
import type { ReopenedVatPeriod } from '@/lib/vat/filed-periods-reopened'

/**
 * The door a lock date change came through: the settings page ('app'), a
 * direct v1 API call ('api'), or the approval of a staged change, from MCP
 * or ?stage=true ('approval').
 */
export type LockDateChangeVia = 'app' | 'api' | 'approval'

// ============================================================
// Core Event Types: discriminated union of all system events
// ============================================================

/**
 * Who runs AI extraction on an uploaded document.
 * - 'invoice-inbox': the inbox extracts and mirrors the result itself.
 * - 'none': nobody should; the caller already holds the booking.
 * Unset: the document-extraction extension extracts (default).
 */
export type DocumentExtractionOwner = 'invoice-inbox' | 'none'

/**
 * Where an MCP event's `client` label came from when the request carried no
 * client marker: the provider stored on an OAuth key, the clientInfo name of
 * a stateless request, the User-Agent of our stdio bridge (accounted-mcp,
 * gnubok-mcp) with the client name it carries, any other User-Agent, or
 * nothing at all (label 'other'). Absent on rows labelled by the marker.
 */
export type McpClientSource = 'oauth' | 'client_info' | 'bridge' | 'user_agent' | 'none'

/**
 * A dimension value as its events carry it: the v1 resource
 * (GET /dimensions, values[]) plus the dimension's SIE number and name, so a
 * receiver knows a projekt (6) from a kostnadsställe (1) without a lookup.
 * is_active false means archived.
 */
export interface DimensionValueSnapshot {
  id: string
  dimension_id: string
  sie_dim_no: number
  dimension_name: string
  code: string
  name: string
  is_active: boolean
  start_date: string | null
  end_date: string | null
}

export interface DimensionValueEventPayload {
  dimensionValue: DimensionValueSnapshot
  /** The name before a rename; null on every other event. */
  previousName: string | null
  userId: string
  companyId: string
}

export type CoreEvent =
  // Bookkeeping
  | { type: 'journal_entry.drafted'; payload: { entry: JournalEntry; userId: string; companyId: string } }
  | { type: 'journal_entry.committed'; payload: { entry: JournalEntry; userId: string; companyId: string } }
  | { type: 'journal_entry.corrected'; payload: { original: JournalEntry; storno: JournalEntry; corrected: JournalEntry; userId: string; companyId: string } }
  | { type: 'journal_entry.reversed'; payload: { originalEntry: JournalEntry; reversalEntry: JournalEntry; userId: string; companyId: string } }
  | { type: 'journal_entry.cancelled'; payload: { entry: JournalEntry; userId: string; companyId: string } }
  | { type: 'journal_entry.deleted'; payload: { entryId: string; voucherSeries: string; voucherNumber: number; userId: string; companyId: string } }
  // Documents
  // extractionOwner: set by the invoice inbox on documents it extracts itself,
  // so the document-extraction extension yields instead of racing it (the
  // inbox row does not exist yet when this event fires inside uploadDocument).
  // 'none' is an explicit opt-out: the uploader already knows the booking
  // (provider underlag import links each file to its posted verifikat), so
  // running a paid model over it would buy nothing. The extension stamps the
  // row as skipped instead of extracting.
  | { type: 'document.uploaded'; payload: { document: DocumentAttachment; userId: string; companyId: string; extractionOwner?: DocumentExtractionOwner } }
  | { type: 'document.accessed'; payload: { document: { id: string; file_name: string }; userId: string; companyId: string } }
  | { type: 'document.deleted'; payload: { document: { id: string; file_name: string }; userId: string; companyId: string } }
  // BankID document signing (lib/signing). Payloads carry ids, positions and
  // times only: never a name typed by the sender, an address or a personnummer.
  // userId is the person who sent the request.
  | { type: 'signing.requested'; payload: { signingRequestId: string; documentId: string; signerCount: number; createdVia: 'app' | 'api' | 'mcp'; annualReportVersionId: string | null; userId: string; companyId: string } }
  | { type: 'signing.signer_signed'; payload: { signingRequestId: string; signerId: string; position: number; signedAt: string; userId: string; companyId: string } }
  | { type: 'signing.declined'; payload: { signingRequestId: string; signerId: string; position: number; userId: string; companyId: string } }
  | { type: 'signing.completed'; payload: { signingRequestId: string; documentId: string; signedDocumentId: string | null; evidenceDocumentId: string | null; annualReportVersionId: string | null; userId: string; companyId: string } }
  | { type: 'signing.cancelled'; payload: { signingRequestId: string; userId: string; companyId: string } }
  /** Arkiv said what a document is (a model or a person). The invoice inbox routes it into or out of the Underlag queue on this. */
  | { type: 'document.classified'; payload: { document: { id: string; file_name: string }; companyId: string; userId: string; docType: string; admission: 'admitted' | 'held'; decidedBy: 'model' | 'human' } }
  // Invoicing
  | { type: 'invoice.created'; payload: { invoice: Invoice; userId: string; companyId: string } }
  // Hard delete of an un-finalized, unnumbered draft (no F-series number was
  // consumed). Carries only the identifiers (the row is gone) so the audit
  // log can record who removed which draft and when. Numbered drafts are
  // makulerade instead and surface via the journal, not this event.
  | { type: 'invoice.draft_deleted'; payload: { invoiceId: string; userId: string; companyId: string } }
  | { type: 'invoice.sent'; payload: { invoice: Invoice; userId: string; companyId: string } }
  // A quote or proforma makulerad (lib/invoices/cancel-quote-or-proforma.ts).
  // The row stays with status 'cancelled'; the event log is its audit trail.
  | { type: 'invoice.cancelled'; payload: { invoice: Invoice; userId: string; companyId: string } }
  | { type: 'invoice.paid'; payload: { invoice: Invoice; paymentAmount: number; paymentDate: string; userId: string; companyId: string } }
  | { type: 'credit_note.created'; payload: { creditNote: CreditNote; userId: string; companyId: string } }
  // Recurring invoices: emitted by the daily cron after a schedule spawns
  // an invoice. `autoSent` tells observers whether the email also went out
  // (false means it was created as draft for manual review).
  | { type: 'recurring_invoice.executed'; payload: {
      scheduleId: string
      invoice: Invoice
      autoSent: boolean
      warning: string | null
      userId: string
      companyId: string
    } }
  // Banking
  | { type: 'transaction.synced'; payload: { transactions: Transaction[]; userId: string; companyId: string } }
  | { type: 'transaction.categorized'; payload: { transaction: Transaction; account: string; taxCode: string; userId: string; companyId: string } }
  | { type: 'transaction.reconciled'; payload: { transaction: Transaction; journalEntryId: string; method: ReconciliationMethod; userId: string; companyId: string } }
  // Account-keyed reconciliation (lib/reconciliation/actions.ts): one event per
  // link made or removed on any reconcilable account (bank:<cash_account_id>,
  // skattekonto, later manual:NNNN). `transaction.reconciled` keeps firing for
  // bank links made through the bank engine; these are the kind-agnostic
  // signals the flows builder triggers on.
  | { type: 'reconciliation.matched'; payload: { accountKey: string; externalId: string; journalEntryId: string; method: 'manual' | 'proposal'; userId: string; companyId: string } }
  | { type: 'reconciliation.unmatched'; payload: { accountKey: string; externalId: string; previousJournalEntryId: string | null; userId: string; companyId: string } }
  // Sign-off: the human (or agent-staged, user-approved) assertion "reconciled
  // through this date" on one account (lib/reconciliation/signoff.ts), and its undo.
  | { type: 'reconciliation.signed_off'; payload: { accountKey: string; signoffId: string; throughDate: string; unexplainedDifference: number | null; userId: string; companyId: string } }
  | { type: 'reconciliation.reopened'; payload: { accountKey: string; signoffId: string; throughDate: string; reason: string | null; userId: string; companyId: string } }
  // Bank connection lifecycle: consent + account selection are the
  // GDPR/PSD2 audit points; emitted to event_log for compliance trail.
  | { type: 'bank_connection.consent_granted'; payload: { connectionId: string; bankName: string | null; accountCount: number; consentExpiresAt: string | null; userId: string; companyId: string } }
  | { type: 'bank_connection.account_selection_changed'; payload: { connectionId: string; bankName: string | null; previousStatus: string; newStatus: string; enabledCount: number; totalCount: number; userId: string; companyId: string; /** Set by a ledger-account change (lib/cash-accounts/ledger-change.ts): which bank account moved from which 19xx account to which, kept in event_log as the behandlingshistorik of the change. */ ledgerChanges?: Array<{ cashAccountId: string | null; uid: string; from: string | null; to: string }> } }
  | { type: 'bank_connection.revoked'; payload: { connectionId: string; bankName: string | null; userId: string; companyId: string } }
  // Emitted when a new or renewed connection supersedes an older row for the
  // same bank in the same company: the old row is parked as 'revoked' with
  // superseded_by pointing at the replacement, and its transactions are
  // re-pointed. connectionId is the SUPERSEDED (old) row, mirroring .revoked.
  | { type: 'bank_connection.superseded'; payload: { connectionId: string; supersededById: string; bankName: string | null; userId: string; companyId: string } }
  // Emitted when the bank/provider redirects the OAuth callback back with an
  // error instead of an authorization code: denied consent, a bank-side
  // failure (e.g. Handelsbanken's missing corporate fullmakt), or an expired
  // signing session. Durable failure trail (issue #1716): the pending row is
  // deleted right after and console logs expire, so without this event
  // support cannot answer which attempt failed, with which error, on whose
  // side. connectionId may reference a row deleted by the same request.
  | { type: 'bank_connection.consent_denied'; payload: {
      connectionId: string
      bankName: string | null
      psuType: string | null
      errorCode: string
      errorDescription: string | null
      priorStatus: string
      userId: string
      companyId: string
    } }
  // Emitted when the code-for-session exchange or connection finalization
  // throws after the bank redirected back successfully. Same audit doctrine
  // as consent_denied: the fresh-connect row is deleted by cleanup and the
  // console log expires, leaving support nothing to answer from.
  | { type: 'bank_connection.finalize_failed'; payload: {
      connectionId: string
      bankName: string | null
      reason: string
      priorStatus: string
      userId: string
      companyId: string
    } }
  // Emitted on every failed bank sync (cron, the manual button, an agent
  // trigger): one durable row per failure with the class, the connection
  // status after handling and the INTERNAL error text, so a same-day
  // failure across connections can be diagnosed after the server log has
  // expired (feedback seq 340107). message is never the user-facing Swedish
  // string: that one is the same for every cause. httpStatus/ebCode are set
  // when the transport exposed them (Enable Banking envelope or connector
  // code).
  | { type: 'bank_connection.sync_failed'; payload: {
      connectionId: string
      bankName: string | null
      provider: 'enable_banking' | 'accounted_connect' | 'open_payments'
      trigger: 'agent' | 'cron' | 'manual'
      /**
       * throttled: the bank's short throttle (Open Payments), a retry in a minute; rate_limited: the daily cap;
       * consent_refused: a permanent consent failure code (Open Payments), the row needs a renewal like session_expired.
       */
      errorClass: 'session_expired' | 'consent_refused' | 'bank_unavailable' | 'rate_limited' | 'throttled' | 'connector' | 'unknown'
      status: string
      /** Redacted summary (class name + scrubbed phrase); never a raw provider body. */
      diagnostic: string
      httpStatus?: number
      ebCode?: string
      /** rate_limited only: the cooldown applied, in seconds. */
      cooldownSeconds?: number
      /** rate_limited only: the bank's own Retry-After in seconds, when it sent one. */
      bankRetryAfterSeconds?: number
      userId: string
      companyId: string
    } }
  // Stripe Connect lifecycle: connect/disconnect are outward-facing consent
  // transitions (a third party gains/loses access to payment data), so they
  // land in event_log for the audit trail, mirroring bank_connection.*.
  | { type: 'stripe.connected'; payload: { connectionId: string; stripeAccountId: string; livemode: boolean; userId: string; companyId: string } }
  | { type: 'stripe.disconnected'; payload: { connectionId: string; stripeAccountId: string | null; reason: 'user' | 'revoked_upstream'; userId: string; companyId: string } }
  // WooCommerce store lifecycle: same audit doctrine as stripe.* (a third
  // party's API credentials are granted/dropped).
  | { type: 'woocommerce.connected'; payload: { connectionId: string; storeUrl: string; userId: string; companyId: string } }
  | { type: 'woocommerce.disconnected'; payload: { connectionId: string; storeUrl: string | null; reason: 'user' | 'revoked_upstream'; userId: string; companyId: string } }
  // Shopify store lifecycle: same audit doctrine as stripe.*/woocommerce.*.
  | { type: 'shopify.connected'; payload: { connectionId: string; shopDomain: string; userId: string; companyId: string } }
  | { type: 'shopify.disconnected'; payload: { connectionId: string; shopDomain: string | null; reason: 'user' | 'revoked_upstream'; userId: string; companyId: string } }
  // Zettle organization lifecycle: same audit doctrine as shopify.*.
  | { type: 'zettle.connected'; payload: { connectionId: string; organizationUuid: string; userId: string; companyId: string } }
  | { type: 'zettle.disconnected'; payload: { connectionId: string; organizationUuid: string | null; reason: 'user' | 'revoked_upstream'; userId: string; companyId: string } }
  // A point-of-sale venue connected through Accounted Connect
  // (lib/pos-sales/service.ts connectPosVenue). Internal: not persisted to
  // event_log and not a public webhook; the suggestion detectors listen to it.
  | { type: 'pos.connected'; payload: { connectionId: string; provider: string; userId: string; companyId: string } }
  // Periods
  | { type: 'period.locked'; payload: { period: FiscalPeriod; userId: string; companyId: string } }
  | { type: 'period.unlocked'; payload: { period: FiscalPeriod; userId: string; companyId: string } }
  | { type: 'period.year_closed'; payload: { period: FiscalPeriod; userId: string; companyId: string } }
  // The company-wide lock date ("Bokföring låst t.o.m.",
  // company_settings.bookkeeping_locked_through) was set, moved or removed
  // (lib/company/settings-service.ts). lockDate is null when the lock was
  // removed, which is a move backward. `via` names the door, never the person
  // (the webhook payload carries no personal data).
  | { type: 'period.lock_date_changed'; payload: { previousLockDate: string | null; lockDate: string | null; direction: 'forward' | 'backward'; via: LockDateChangeVia; reopenedFiledVatPeriods: ReopenedVatPeriod[]; userId: string; companyId: string } }
  // Customers
  | { type: 'customer.created'; payload: { customer: Customer; userId: string; companyId: string } }
  // Articles (artikelregister)
  | { type: 'article.created'; payload: { article: Article; userId: string; companyId: string } }
  | { type: 'article.updated'; payload: { article: Article; userId: string; companyId: string } }
  | { type: 'article.deleted'; payload: { articleId: string; userId: string; companyId: string } }
  // Suppliers
  | { type: 'supplier.created'; payload: { supplier: Supplier; userId: string; companyId: string } }
  // Dimension values (SIE #OBJEKT: a projekt, kostnadsställe or custom code),
  // accounted#193. One event per kind of change, whichever door wrote it
  // (lib/dimensions/value-events.ts): a PATCH that renames and archives
  // emits both. previousName is set on a rename only.
  | { type: 'dimension_value.created'; payload: DimensionValueEventPayload }
  | { type: 'dimension_value.renamed'; payload: DimensionValueEventPayload }
  | { type: 'dimension_value.archived'; payload: DimensionValueEventPayload }
  | { type: 'dimension_value.unarchived'; payload: DimensionValueEventPayload }
  // Supplier Invoice Lifecycle
  | { type: 'supplier_invoice.registered'; payload: { supplierInvoice: SupplierInvoice; userId: string; companyId: string } }
  | { type: 'supplier_invoice.approved'; payload: { supplierInvoice: SupplierInvoice; userId: string; companyId: string } }
  | { type: 'supplier_invoice.paid'; payload: { supplierInvoice: SupplierInvoice; paymentAmount: number; userId: string; companyId: string } }
  | { type: 'supplier_invoice.credited'; payload: { supplierInvoice: SupplierInvoice; creditNote: SupplierInvoice; userId: string; companyId: string } }
  | { type: 'supplier_invoice.uncredited'; payload: { supplierInvoice: SupplierInvoice; reversedCreditNoteId: string; reversalEntryId: string | null; userId: string; companyId: string } }
  // Payment Matching
  | { type: 'invoice.match_confirmed'; payload: { invoice: Invoice; transaction: Transaction; userId: string; companyId: string } }
  | { type: 'supplier_invoice.match_confirmed'; payload: { supplierInvoice: SupplierInvoice; transaction: Transaction; userId: string; companyId: string } }
  // Supplier Invoice Inbox
  | { type: 'supplier_invoice.confirmed'; payload: { inboxItem: InvoiceInboxItem; supplierInvoice: SupplierInvoice; userId: string; companyId: string } }
  // Salary
  // An employee registered (lib/salary/employee-commands.ts createEmployee,
  // every door). Ids only, never personal data. Internal: not persisted to
  // event_log and not a public webhook; the suggestion detectors listen to it.
  | { type: 'employee.created'; payload: { employeeId: string; userId: string; companyId: string } }
  | { type: 'salary_run.created'; payload: { salaryRunId: string; periodYear: number; periodMonth: number; userId: string; companyId: string } }
  | { type: 'salary_run.approved'; payload: { salaryRunId: string; approvedBy: string; userId: string; companyId: string } }
  | { type: 'salary_run.approval_reverted'; payload: { salaryRunId: string; revertedBy: string; deletedAgiDeclarationId: string | null; userId: string; companyId: string } }
  | { type: 'salary_run.booked'; payload: { salaryRunId: string; entryIds: string[]; userId: string; companyId: string } }
  | { type: 'agi.generated'; payload: { agiId: string; periodYear: number; periodMonth: number; userId: string; companyId: string } }
  // Bolagsverket: digital inlämning av årsredovisning. Status values follow
  // GUIDE §5.2.2 (arsred_inkommen → … → arsred_registrerad). `uploaded` fires
  // when the iXBRL lands in eget utrymme; the undertecknare then signs the
  // fastställelseintyg at Bolagsverket and the webhook drives the rest.
  | { type: 'arsredovisning.uploaded'; payload: { submissionId: string; fiscalPeriodId: string; idnummer: string; environment: 'test' | 'accept' | 'prod'; userId: string; companyId: string } }
  | { type: 'arsredovisning.status_changed'; payload: { submissionId: string; fiscalPeriodId: string | null; previousStatus: string; status: string; bolagsverketStatus: string; userId: string; companyId: string } }
  | { type: 'arsredovisning.registered'; payload: { submissionId: string; fiscalPeriodId: string | null; userId: string; companyId: string } }
  | { type: 'arsredovisning.forelagd'; payload: { submissionId: string; fiscalPeriodId: string | null; userId: string; companyId: string } }
  // Skatteverket: Skattekonto sync
  | { type: 'skattekonto.synced'; payload: { booked: number; upcoming: number; balanceSkv: number; balanceKfm: number; userId: string; companyId: string } }
  | { type: 'skattekonto.balance.changed'; payload: { previousBalance: number; currentBalance: number; userId: string; companyId: string } }
  | { type: 'skattekonto.transaction.upcoming'; payload: { transaktionsdatum: string; forfallodatum: string; transaktionstext: string; beloppSkatteverket: number; userId: string; companyId: string } }
  | { type: 'skattekonto.connection.expired'; payload: { reason: 'REFRESH_EXHAUSTED' | 'SESSION_EXPIRED' | 'TOKEN_CORRUPTED'; userId: string; companyId: string } }
  // Company & account lifecycle
  | { type: 'company.deleted'; payload: { companyId: string; userId: string; archivedAt: string } }
  // The K2/K3 framework of a räkenskapsår changed (lib/company/accounting-framework-change.ts,
  // BFNAR 2012:4): a change of accounting principle. fiscalPeriodId is null when
  // the company had no fiscal year and only its default changed. Internal:
  // persisted to event_log, not a public webhook.
  | { type: 'company.accounting_framework_changed'; payload: { companyId: string; userId: string; fiscalPeriodId: string | null; framework: 'k2' | 'k3'; previousFramework: 'k2' | 'k3' | null; cascadedPeriodIds: string[]; k3ToK2: boolean } }
  | { type: 'account.deleted'; payload: { userId: string; deletedAt: string } }
  // MCP telemetry: fired from the MCP dispatcher.
  // Persisted to event_log (180-day TTL for mcp.*/agent.* rows, vs 30 days for
  // delivery events) for hot-tool / error-rate / latency analytics.
  // Intentionally lightweight: no args, no result body, only metadata.
  | { type: 'mcp.tool_called'; payload: {
      tool: string                                  // e.g. 'gnubok_create_invoice'
      requiredScope: string | null                  // from TOOL_SCOPE_MAP, null if unscoped
      // How the call picked its company: the key default (no company_id),
      // an explicit company_id, the row of a named pending operation, a
      // scope resolved by a cross-company tool (one row per inner call), or
      // none for company-independent tools. Optional so older emitters and
      // stored rows stay valid.
      companySelection?: 'default' | 'explicit' | 'operation' | 'scope' | 'none'
      actorType: 'user' | 'api_key' | 'mcp_oauth' | 'cron' | 'anonymous'
      actorId: string | null                        // api_key id, oauth client, etc.
      actorLabel: string | null                     // human-readable actor label
      latencyMs: number                             // wall-clock time inside execute()
      success: boolean                              // true iff the tool returned without throwing AND was invoked (not denied)
      isError: boolean                              // matches the JSON-RPC tool-result isError flag returned to the client
      errorCode: string | null                      // structured error code from tool-result.toToolError when applicable
      errorKind: 'execution' | 'scope_denied' | 'capability_denied' | 'company_access_denied' | 'invalid_arguments' | 'unknown_tool' | 'test_key_write_blocked' | 'unattended_write_blocked' | 'bridge_refused' | 'package_off' | null
                                                    // bridge_refused: gnubok_call_tool was pointed at a write tool, or at nothing.
                                                    // invalid_arguments: the call never reached the tool because its arguments
                                                    // were rejected (unknown parameter, malformed company_id). Split out of
                                                    // company_access_denied, which used to swallow both and send triage
                                                    // looking for a permissions problem that did not exist.
      errorMessage: string | null                   // human-readable error message (truncated to 500 chars), null on success.
                                                    // Raw material for clustering real agent failures into curated gotchas:
                                                    // errorCode alone can't distinguish "period locked" from "unbalanced".
      errorDetail: string | null
      errorCause: string | null  // errorCauseTag(err): SQLSTATE / coded-error code / error class name, <= 64 chars. The clustering key for rows whose errorMessage is the UNKNOWN_ERROR constant (#2051); never a raw driver message, which can quote row values.                    // The specific English diagnostic, when message_sv is a generic registry
                                                    // default that says nothing (VALIDATION_ERROR -> "Förfrågan innehåller
                                                    // ogiltiga uppgifter."). Null when it would only repeat errorMessage.
                                                    // Without it a 604-call outage looked identical to a typo in the logs:
                                                    // the agent was told exactly what was wrong, and we were not.
      requestId: string | number | null             // JSON-RPC request id (helps correlate with client-side logs)
      traceId: string | null                        // W3C trace-id of the message (lib/observability/trace-context.ts): the
                                                    // trace_id the rows it wrote carry (pending_operations, business_events,
                                                    // suggestion_log). Older rows lack it.
      userId: string
      companyId: string
      sessionId: string | null                      // from Mcp-Session-Id header; null if absent
      client: string | null                         // distribution marker (X-Accounted-Client, legacy X-Gnubok-Client, or ?client=).
                                                    // Client-supplied (allow-list-sanitized): telemetry only, never identity or authz.
                                                    // Without a marker: derived from the OAuth provider, clientInfo or User-Agent.
      clientName?: string                           // sanitized raw client name when the derived label is 'other' (<= 64 chars)
      clientSource?: McpClientSource                // which fallback derived `client`; absent when the marker set it
    }}
  // tools/list: informs us whether agents are using progressive discovery
  // (gnubok_search_tools) or pulling the full list. Tool counts vary with
  // the caller's scope set.
  | { type: 'mcp.tools_list_called'; payload: {
      toolCount: number                             // tools actually returned (post scope filter)
      actorType: 'user' | 'api_key' | 'mcp_oauth' | 'cron' | 'anonymous'
      actorId: string | null
      actorLabel: string | null
      latencyMs: number
      requestId: string | number | null
      userId: string
      companyId: string
      sessionId: string | null                      // from Mcp-Session-Id header; null if absent
      client: string | null                         // distribution-channel marker, else the derived label
      clientName?: string
      clientSource?: McpClientSource
    }}
  // resources/read: informs us which skills/widgets/data resources actually
  // get loaded by agents. `kind` discriminates by URI scheme so we can
  // GROUP BY skill vs widget vs data without parsing URIs.
  | { type: 'mcp.resource_read'; payload: {
      uri: string                                   // e.g. 'Accounted://skill/month-end-close'
      kind: 'widget' | 'skill' | 'data' | 'unknown'
      success: boolean
      errorCode: string | null
      latencyMs: number
      actorType: 'user' | 'api_key' | 'mcp_oauth' | 'cron' | 'anonymous'
      actorId: string | null
      actorLabel: string | null
      requestId: string | number | null
      userId: string
      companyId: string
      sessionId: string | null                      // from Mcp-Session-Id header; null if absent
      client: string | null                         // distribution-channel marker, else the derived label
      clientName?: string
      clientSource?: McpClientSource
    }}
  // Workflow lifecycle: agents declare "I'm starting month-end-close" via
  // gnubok_load_skill (or implicitly by following a skill's recommended tool
  // sequence), or start a task with gnubok_get_task. Phase 3A captures these
  // to measure how often a workflow is started.
  | { type: 'mcp.workflow_started'; payload: {
      slug: string                                  // load_skill: 'month-end-close'; get_task: 'task/vat', 'skill/<slug>', 'agent/<slug>', 'agent/own'
      sessionId: string | null
      actorType: 'user' | 'api_key' | 'mcp_oauth' | 'cron' | 'anonymous'
      actorId: string | null
      actorLabel: string | null
      userId: string
      companyId: string
    }}
  // Fires on EVERY successful gnubok_load_skill: all tiers, unlike
  // mcp.workflow_started which fires only for workflow-tier skills. Records
  // WHICH skill/atom bodies agents actually pull, the denominator needed to
  // correlate a loaded atom with downstream tool-error rates (a skill can
  // make the model worse: measure, don't assume).
  | { type: 'mcp.skill_loaded'; payload: {
      slug: string                                  // e.g. 'modifier/holding-ab', 'month-end-close'
      tier: 'workflow' | 'horizontal' | 'vertical' | 'modifier' | 'community' | 'own'
      bodyHash?: string
      version?: number
      found?: true                                  // always true here; misses are mcp.skill_not_found. Optional: older rows lack it
      sessionId: string | null
      actorType: 'user' | 'api_key' | 'mcp_oauth' | 'cron' | 'anonymous'
      actorId: string | null
      actorLabel: string | null
      userId: string
      companyId: string
      client?: string | null                        // as on mcp.tool_called; optional: older rows lack it
      clientName?: string
      clientSource?: McpClientSource
    }}
  // A gnubok_load_skill call whose slug matched no skill. Kept apart from
  // mcp.skill_loaded, whose rows are read back as retrieval evidence (skill
  // provenance, usage counts): a miss retrieved nothing.
  | { type: 'mcp.skill_not_found'; payload: {
      slug: string                                  // the requested slug, trimmed, <= 200 chars
      found: false
      sessionId: string | null
      actorType: 'user' | 'api_key' | 'mcp_oauth' | 'cron' | 'anonymous'
      actorId: string | null
      actorLabel: string | null
      userId: string
      companyId: string
      client: string | null
      clientName?: string
      clientSource?: McpClientSource
    }}
  // One gnubok_search_tools call (either alias, direct or bridged): the query
  // and what ranked first, so a capability agents look for and do not find
  // shows up. The only tool whose argument text is recorded.
  | { type: 'mcp.tool_searched'; payload: {
      query: string                                 // as sent, trimmed, <= 200 chars; '' lists every tool
      detail: 'name' | 'summary' | 'full'
      topHits: string[]                             // canonical tool ids in rank order, <= 5
      hitCount: number                              // every tool that matched (total_matched), not just the returned page
      sessionId: string | null
      actorType: 'user' | 'api_key' | 'mcp_oauth' | 'cron' | 'anonymous'
      actorId: string | null
      actorLabel: string | null
      userId: string
      companyId: string
      client: string | null
      clientName?: string
      clientSource?: McpClientSource
    }}
  // Fires when the agent's next tool call matches the previous response's
  // nextHint.tool: measures whether `next` hints are actually followed.
  // Computed dispatcher-side by comparing the last response shape to the
  // current call.
  | { type: 'mcp.next_hint_followed'; payload: {
      fromTool: string
      toTool: string
      sessionId: string | null
      actorType: 'user' | 'api_key' | 'mcp_oauth' | 'cron' | 'anonymous'
      actorId: string | null
      actorLabel: string | null
      userId: string
      companyId: string
    }}
  // Collections: an invoice handed over to the company's collections
  // provider, its stage moving, and the case closing. Ids and stages only:
  // nothing about the debtor travels on the bus. userId is the person who
  // acted, or, for a change the sync read from the provider, the person who
  // handed the invoice over.
  | { type: 'collection.case_opened'; payload: {
      caseId: string
      invoiceId: string
      stage: string
      origin: 'handover' | 'batch' | 'distribution'
      companyId: string
      userId: string
    }}
  | { type: 'collection.case_updated'; payload: {
      caseId: string
      invoiceId: string
      stage: string
      previousStage: string
      closeReason: string | null
      companyId: string
      userId: string
    }}
  | { type: 'collection.case_closed'; payload: {
      caseId: string
      invoiceId: string
      stage: string
      previousStage: string
      closeReason: string | null
      companyId: string
      userId: string
    }}
  // Agent self-reported feedback (gnubok_feedback tool). The product team
  // queries event_log for `agent.feedback` and routes to a backlog.
  | { type: 'agent.feedback'; payload: {
      context: string
      sentiment: 'positive' | 'negative' | 'neutral'
      suggestion: string | null
      toolName: string | null
      skillSlug: string | null
      sessionId: string | null
      actorType: 'user' | 'api_key' | 'mcp_oauth' | 'cron' | 'anonymous'
      actorId: string | null
      actorLabel: string | null
      userId: string
      companyId: string
    }}

// ============================================================
// Helper Types
// ============================================================

/** All possible event type strings */
export type CoreEventType = CoreEvent['type']

/** Extract the payload type for a given event type */
export type EventPayload<T extends CoreEventType> = Extract<CoreEvent, { type: T }>['payload']

/** Handler function for a specific event type */
export type EventHandler<T extends CoreEventType> = (payload: EventPayload<T>) => Promise<void> | void
