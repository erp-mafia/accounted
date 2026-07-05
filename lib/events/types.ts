import type {
  JournalEntry,
  Invoice,
  Transaction,
  Customer,
  Supplier,
  Article,
  FiscalPeriod,
  DocumentAttachment,
  Receipt,
  CreditNote,
  ReconciliationMethod,
  InvoiceInboxItem,
  SupplierInvoice,
} from '@/types'

// ============================================================
// Core Event Types: discriminated union of all system events
// ============================================================

export type CoreEvent =
  // Bookkeeping
  | { type: 'journal_entry.drafted'; payload: { entry: JournalEntry; userId: string; companyId: string } }
  | { type: 'journal_entry.committed'; payload: { entry: JournalEntry; userId: string; companyId: string } }
  | { type: 'journal_entry.corrected'; payload: { original: JournalEntry; storno: JournalEntry; corrected: JournalEntry; userId: string; companyId: string } }
  | { type: 'journal_entry.reversed'; payload: { originalEntry: JournalEntry; reversalEntry: JournalEntry; userId: string; companyId: string } }
  | { type: 'journal_entry.deleted'; payload: { entryId: string; voucherSeries: string; voucherNumber: number; userId: string; companyId: string } }
  // Documents
  | { type: 'document.uploaded'; payload: { document: DocumentAttachment; userId: string; companyId: string } }
  | { type: 'document.accessed'; payload: { document: { id: string; file_name: string }; userId: string; companyId: string } }
  | { type: 'document.deleted'; payload: { document: { id: string; file_name: string }; userId: string; companyId: string } }
  // Invoicing
  | { type: 'invoice.created'; payload: { invoice: Invoice; userId: string; companyId: string } }
  // Hard delete of an un-finalized, unnumbered draft (no F-series number was
  // consumed). Carries only the identifiers (the row is gone) so the audit
  // log can record who removed which draft and when. Numbered drafts are
  // makulerade instead and surface via the journal, not this event.
  | { type: 'invoice.draft_deleted'; payload: { invoiceId: string; userId: string; companyId: string } }
  | { type: 'invoice.sent'; payload: { invoice: Invoice; userId: string; companyId: string } }
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
  // Bank connection lifecycle: consent + account selection are the
  // GDPR/PSD2 audit points; emitted to event_log for compliance trail.
  | { type: 'bank_connection.consent_granted'; payload: { connectionId: string; bankName: string | null; accountCount: number; consentExpiresAt: string | null; userId: string; companyId: string } }
  | { type: 'bank_connection.account_selection_changed'; payload: { connectionId: string; bankName: string | null; previousStatus: string; newStatus: string; enabledCount: number; totalCount: number; userId: string; companyId: string } }
  | { type: 'bank_connection.revoked'; payload: { connectionId: string; bankName: string | null; userId: string; companyId: string } }
  // Emitted when the PSD2 callback fails to mirror a returned account into
  // cash_accounts. ASVS V16 / ISO 27001 A.8.15: security-relevant failures
  // must land in a structured audit log (event_log, 30-day TTL) rather than
  // being lost to console.error.
  | { type: 'bank_connection.cash_account_mirror_failed'; payload: {
      connectionId: string
      bankName: string | null
      accountUid: string
      ledgerAccount: string
      currency: string
      reason: string
      userId: string
      companyId: string
    } }
  // Periods
  | { type: 'period.locked'; payload: { period: FiscalPeriod; userId: string; companyId: string } }
  | { type: 'period.unlocked'; payload: { period: FiscalPeriod; userId: string; companyId: string } }
  | { type: 'period.year_closed'; payload: { period: FiscalPeriod; userId: string; companyId: string } }
  // Customers
  | { type: 'customer.created'; payload: { customer: Customer; userId: string; companyId: string } }
  // Articles (artikelregister)
  | { type: 'article.created'; payload: { article: Article; userId: string; companyId: string } }
  | { type: 'article.updated'; payload: { article: Article; userId: string; companyId: string } }
  // Suppliers
  | { type: 'supplier.created'; payload: { supplier: Supplier; userId: string; companyId: string } }
  // Receipts
  | { type: 'receipt.extracted'; payload: {
      receipt: Receipt;
      documentId: string | null;
      confidence: number;
      userId: string;
      companyId: string;
    }}
  | { type: 'receipt.matched'; payload: {
      receipt: Receipt;
      transaction: Transaction;
      confidence: number;
      autoMatched: boolean;
      userId: string;
      companyId: string;
    }}
  | { type: 'receipt.confirmed'; payload: {
      receipt: Receipt;
      businessTotal: number;
      privateTotal: number;
      userId: string;
      companyId: string;
    }}
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
  | { type: 'supplier_invoice.received'; payload: { inboxItem: InvoiceInboxItem; userId: string; companyId: string } }
  | { type: 'supplier_invoice.extracted'; payload: { inboxItem: InvoiceInboxItem; confidence: number; userId: string; companyId: string } }
  | { type: 'supplier_invoice.confirmed'; payload: { inboxItem: InvoiceInboxItem; supplierInvoice: SupplierInvoice; userId: string; companyId: string } }
  // Salary
  | { type: 'salary_run.created'; payload: { salaryRunId: string; periodYear: number; periodMonth: number; userId: string; companyId: string } }
  | { type: 'salary_run.approved'; payload: { salaryRunId: string; approvedBy: string; userId: string; companyId: string } }
  | { type: 'salary_run.approval_reverted'; payload: { salaryRunId: string; revertedBy: string; deletedAgiDeclarationId: string | null; userId: string; companyId: string } }
  | { type: 'salary_run.booked'; payload: { salaryRunId: string; entryIds: string[]; userId: string; companyId: string } }
  | { type: 'agi.generated'; payload: { agiId: string; periodYear: number; periodMonth: number; userId: string; companyId: string } }
  | { type: 'agi.submitted'; payload: { salaryRunId: string; periodYear: number; periodMonth: number; userId: string; companyId: string } }
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
  // Fired when the SKV saldo and GL 1630 sum diverge beyond the configured
  // tolerance. The drift handler emails the company contact; UI surfaces a
  // dashboard tile via /api/extensions/skatteverket/skattekonto/drift.
  | { type: 'skattekonto.drift_detected'; payload: {
      drift: number                       // SKV saldo - GL 1630 sum (signed)
      saldoSkatteverket: number
      glSum1630: number
      fetchedAt: number                   // ms epoch from the snapshot
      unbookedCount: number               // skattekonto rows without journal_entry_id ≤ fetchedAt
      userId: string
      companyId: string
    } }
  // Company & account lifecycle
  | { type: 'company.deleted'; payload: { companyId: string; userId: string; archivedAt: string } }
  | { type: 'account.deleted'; payload: { userId: string; deletedAt: string } }
  // MCP telemetry: fired from the MCP dispatcher.
  // Persisted to event_log (180-day TTL for mcp.*/agent.* rows, vs 30 days for
  // delivery events) for hot-tool / error-rate / latency analytics.
  // Intentionally lightweight: no args, no result body, only metadata.
  | { type: 'mcp.tool_called'; payload: {
      tool: string                                  // e.g. 'gnubok_create_invoice'
      requiredScope: string | null                  // from TOOL_SCOPE_MAP, null if unscoped
      actorType: 'user' | 'api_key' | 'mcp_oauth' | 'cron'
      actorId: string | null                        // api_key id, oauth client, etc.
      actorLabel: string | null                     // human-readable actor label
      latencyMs: number                             // wall-clock time inside execute()
      success: boolean                              // true iff the tool returned without throwing AND was invoked (not denied)
      isError: boolean                              // matches the JSON-RPC tool-result isError flag returned to the client
      errorCode: string | null                      // structured error code from tool-result.toToolError when applicable
      errorKind: 'execution' | 'scope_denied' | 'capability_denied' | 'unknown_tool' | 'test_key_write_blocked' | null
      errorMessage: string | null                   // human-readable error message (truncated to 500 chars), null on success.
                                                    // Raw material for clustering real agent failures into curated gotchas:
                                                    // errorCode alone can't distinguish "period locked" from "unbalanced".
      requestId: string | number | null             // JSON-RPC request id (helps correlate with client-side logs)
      userId: string
      companyId: string
      sessionId: string | null                      // from Mcp-Session-Id header; null if absent
      client: string | null                         // distribution-channel marker (X-Gnubok-Client header / ?client= param, e.g. 'openclaw').
                                                    // Client-supplied (allow-list-sanitized): telemetry only, never identity or authz.
    }}
  // tools/list: informs us whether agents are using progressive discovery
  // (gnubok_search_tools) or pulling the full list. Tool counts vary with
  // the caller's scope set.
  | { type: 'mcp.tools_list_called'; payload: {
      toolCount: number                             // tools actually returned (post scope filter)
      actorType: 'user' | 'api_key' | 'mcp_oauth' | 'cron'
      actorId: string | null
      actorLabel: string | null
      latencyMs: number
      requestId: string | number | null
      userId: string
      companyId: string
      sessionId: string | null                      // from Mcp-Session-Id header; null if absent
      client: string | null                         // distribution-channel marker; null if absent
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
      actorType: 'user' | 'api_key' | 'mcp_oauth' | 'cron'
      actorId: string | null
      actorLabel: string | null
      requestId: string | number | null
      userId: string
      companyId: string
      sessionId: string | null                      // from Mcp-Session-Id header; null if absent
      client: string | null                         // distribution-channel marker; null if absent
    }}
  // Workflow lifecycle: agents declare "I'm starting month-end-close" via
  // gnubok_load_skill (or implicitly by following a skill's recommended tool
  // sequence). Phase 3A captures these to measure: how often is a workflow
  // started? How often does it complete? Where do agents abandon?
  | { type: 'mcp.workflow_started'; payload: {
      slug: string                                  // e.g. 'month-end-close'
      sessionId: string | null
      actorType: 'user' | 'api_key' | 'mcp_oauth' | 'cron'
      actorId: string | null
      actorLabel: string | null
      userId: string
      companyId: string
    }}
  | { type: 'mcp.workflow_completed'; payload: {
      slug: string
      sessionId: string | null
      outcome: 'success' | 'abandoned' | 'failed'
      stepsCompleted: number | null                 // null when not tracked granularly
      durationMs: number | null
      actorType: 'user' | 'api_key' | 'mcp_oauth' | 'cron'
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
      tier: 'workflow' | 'horizontal' | 'vertical' | 'modifier'
      sessionId: string | null
      actorType: 'user' | 'api_key' | 'mcp_oauth' | 'cron'
      actorId: string | null
      actorLabel: string | null
      userId: string
      companyId: string
    }}
  // Fires when the agent's next tool call matches the previous response's
  // nextHint.tool: measures whether `next` hints are actually followed.
  // Computed dispatcher-side by comparing the last response shape to the
  // current call.
  | { type: 'mcp.next_hint_followed'; payload: {
      fromTool: string
      toTool: string
      sessionId: string | null
      actorType: 'user' | 'api_key' | 'mcp_oauth' | 'cron'
      actorId: string | null
      actorLabel: string | null
      userId: string
      companyId: string
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
      actorType: 'user' | 'api_key' | 'mcp_oauth' | 'cron'
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

/** Subscription: event type + handler */
export interface EventSubscription<T extends CoreEventType = CoreEventType> {
  eventType: T
  handler: EventHandler<T>
}
