import type { SupabaseClient } from '@supabase/supabase-js'
import type { CollectionsFeatures } from '@accounted/connect-contract'
import type { Logger } from '@/lib/logger'
import type { BankCheckResult } from './bank-check'
import {
  applyCaseSnapshot,
  caseView,
  loadCaseEvents,
  loadCurrentCaseForInvoice,
  loadOpenCaseForInvoice,
  recordCaseSyncError,
  type CollectionCaseRow,
  type CollectionCaseView,
} from './case'
import { getCollectionsProvider } from './catalogue'
import { loadLiveConnection, type CollectionConnectionRow } from './connection'
import type { EligibilityBlock, EligibilityHintCode } from './eligibility'
import { isCollectionsError } from './errors'
import { retrySubmittedCase } from './open-case'
import type { CollectionsAdapter, CollectionsRoute } from './port'
import { loadHandoverContext, type HandoverContext } from './readiness'
import { adapterForConnection, callContext, loadConnectionById } from './service-deps'
import { escalationRefusal, loadEscalationCheck } from './case-actions'
import { BANK_CHECKED_ACTIONS } from './stages'
import { missingAddressFields } from './eligibility'
import { loadCaseForwardState, loadForwardIssues, NO_CASE_FORWARDS, type CaseForwardState } from './forwarding'
import { loadPossiblePayments } from './bank-sweep'

/**
 * What the invoice page shows about collections for one invoice: the case
 * (open, or the latest closed or refused one) with its trail, and, when the
 * dialog asks for it, whether and how the invoice can be handed over.
 * Reading the case is an obligation path: it runs whatever the start gates
 * say. Opening the page refreshes an open case from the provider at most
 * once a minute.
 */

/** An open case is re-read from the provider when the page opens, at most this often. */
export const CASE_REFRESH_THROTTLE_MS = 60_000
/** A submitted case is retried from the page at most this often (the cron also retries). */
export const SUBMISSION_RETRY_THROTTLE_MS = 30_000

export interface RefreshDeps {
  db: SupabaseClient
  adapterFor?: (connection: { route: CollectionsRoute }) => CollectionsAdapter | null
  now?: () => Date
  log?: Logger
}

/** Read an open, registered case from the provider and store what it says; a failure is recorded on the case. */
export async function refreshCase(deps: RefreshDeps, row: CollectionCaseRow): Promise<CollectionCaseRow> {
  if (!row.is_open || row.submission_status !== 'registered' || !row.provider_case_ref) return row
  const connection = await loadConnectionById(deps.db, row.company_id, row.connection_id)
  if (!connection) return row
  try {
    const adapter = adapterForConnection(deps, connection)
    const snapshot = await adapter.getCase(callContext(row.company_id, connection), { caseRef: row.provider_case_ref })
    const applied = await applyCaseSnapshot(deps.db, row, snapshot, { now: deps.now ? deps.now() : new Date() })
    return applied.row
  } catch (err) {
    if (!isCollectionsError(err)) throw err
    deps.log?.warn('collection case refresh failed', { caseId: row.id, code: err.code })
    await recordCaseSyncError(deps.db, row, err.code)
    return { ...row, sync_error: err.code }
  }
}

function stale(at: string | null, now: Date, ms: number): boolean {
  return !at || now.getTime() - Date.parse(at) >= ms
}

/** The invoice's case for the page, refreshed when it is due. Null when the invoice never had one. */
export async function loadInvoiceCase(
  deps: RefreshDeps,
  companyId: string,
  invoiceId: string,
  options: { refresh: boolean },
): Promise<CollectionCaseView | null> {
  const now = deps.now ? deps.now() : new Date()
  let row = await loadCurrentCaseForInvoice(deps.db, companyId, invoiceId)
  if (!row) return null
  // A payment or credit note the provider took in after the stored snapshot
  // makes its amounts out of date: read the case again at once, whatever the
  // throttle says (unless the last read failed: then the throttle stands).
  // One still on its way tells the page to read again shortly.
  const caseRow = row
  const forwards: CaseForwardState =
    row.submission_status === 'registered'
      ? await loadCaseForwardState(deps.db, companyId, row.id, row.last_synced_at, now).catch((err: unknown) => {
          deps.log?.warn('collection case forwards not loaded', { caseId: caseRow.id, error: err instanceof Error ? err.message : String(err) })
          return NO_CASE_FORWARDS
        })
      : NO_CASE_FORWARDS
  if (options.refresh && row.is_open) {
    if (row.submission_status === 'registered' && ((forwards.reportedSince && row.sync_error === null) || stale(row.last_synced_at, now, CASE_REFRESH_THROTTLE_MS))) {
      row = await refreshCase(deps, row)
    } else if (row.submission_status === 'submitted' && stale(row.updated_at, now, SUBMISSION_RETRY_THROTTLE_MS)) {
      try {
        row = (await retrySubmittedCase(deps, row.id))?.case ?? row
      } catch (err) {
        deps.log?.warn('collection case retry from the page failed', { caseId: row.id, error: err instanceof Error ? err.message : String(err) })
      }
    }
  }
  const caseId = row.id
  const [events, forwardIssues, possiblePayments] = await Promise.all([
    loadCaseEvents(deps.db, caseId),
    // The card still renders when the forwards cannot be read; Att göra keeps counting them.
    loadForwardIssues(deps.db, companyId, invoiceId).catch((err: unknown) => {
      deps.log?.warn('collection forward issues not loaded', { caseId, error: err instanceof Error ? err.message : String(err) })
      return []
    }),
    row.is_open
      ? loadPossiblePayments(deps.db, companyId, caseId).catch((err: unknown) => {
          deps.log?.warn('collection possible payments not loaded', { caseId, error: err instanceof Error ? err.message : String(err) })
          return []
        })
      : Promise.resolve([]),
  ])
  return caseView(row, events, forwardIssues, possiblePayments, { forwardsInFlight: row.is_open && forwards.inFlight })
}

/** The bank check as the dialogs show it. */
export interface BankCheckView {
  outcome: BankCheckResult['outcome']
  freshness: BankCheckResult['freshness']
  lastSyncedAt: string | null
  accounts: Array<{ name: string | null; ledgerAccount: string; syncedAt: string | null; fresh: boolean; connected: boolean }>
  candidates: BankCheckResult['candidates']
}

export function bankCheckView(result: BankCheckResult): BankCheckView {
  return {
    outcome: result.outcome,
    freshness: result.freshness,
    lastSyncedAt: result.lastSyncedAt,
    accounts: result.payeeAccounts.map((a) => ({
      name: a.name,
      ledgerAccount: a.ledgerAccount,
      syncedAt: a.syncedAt,
      fresh: a.fresh,
      connected: a.bankConnectionId !== null,
    })),
    candidates: result.candidates,
  }
}

export interface CollectionReadinessView {
  eligible: boolean
  blocks: EligibilityBlock[]
  hints: EligibilityHintCode[]
  invoiceNumber: string | null
  dueDate: string
  overdueDays: number
  claim: { amount: number; vatAmount: number; remaining: number }
  /** A ROT/RUT invoice: the claim is the customer's share only. */
  rotRut: boolean
  customer: {
    id: string | null
    name: string | null
    kind: 'business' | 'private'
    missingAddress: string[]
    /** private: whether a valid personnummer will be sent. */
    identity: 'ok' | 'missing' | 'invalid' | 'not_needed'
  }
  deliveryAttestation: 'not_delivered' | 'imported' | null
  responseAttestation: 'disputed' | 'marked_paid' | null
  reminderFee: { agreed: boolean; since: string | null }
  bankCheck: BankCheckView
  startSteps: Array<'reminder' | 'collection'>
  defaultStartStep: 'reminder' | 'collection'
  minimumAmount: number
  /** The invoice was delivered through the provider and is watched: the dialog starts reminders on that claim. */
  watching: boolean
  /** Days after handover within which a withdrawal is free; null = unknown (the withdraw dialog always warns). */
  withdrawFreeDays: number | null
}

export function readinessView(
  ctx: HandoverContext,
  connection: Pick<CollectionConnectionRow, 'default_start_step' | 'minimum_amount'>,
  features: CollectionsFeatures | null,
): CollectionReadinessView {
  const { eligibility, customer } = ctx
  const watching = ctx.openCase?.stage === 'invoice_sent' && ctx.openCase.submission_status === 'registered'
  const blocks = watching ? eligibility.blocks.filter((b) => b.code !== 'elig_open_case') : eligibility.blocks
  const identity: CollectionReadinessView['customer']['identity'] =
    eligibility.debtorKind !== 'private'
      ? 'not_needed'
      : customer?.personalNumber.status === 'valid'
        ? 'ok'
        : customer?.personalNumber.status === 'invalid'
          ? 'invalid'
          : 'missing'
  return {
    eligible: blocks.length === 0,
    blocks,
    hints: eligibility.hints,
    invoiceNumber: ctx.invoice.invoice_number,
    dueDate: ctx.invoice.due_date,
    overdueDays: eligibility.overdueDays,
    claim: eligibility.claim,
    rotRut: (ctx.invoice.deduction_total ?? 0) > 0,
    customer: {
      id: customer?.id ?? null,
      name: customer?.name ?? null,
      kind: eligibility.debtorKind,
      missingAddress: customer ? missingAddressFields(customer) : [],
      identity,
    },
    deliveryAttestation: eligibility.deliveryAttestation,
    responseAttestation: eligibility.responseAttestation,
    reminderFee: { agreed: eligibility.reminderFeeAgreed, since: eligibility.reminderFeeSince },
    bankCheck: bankCheckView(ctx.bankCheck),
    startSteps: (features?.startSteps ?? ['reminder', 'collection']) as Array<'reminder' | 'collection'>,
    defaultStartStep: connection.default_start_step,
    minimumAmount: connection.minimum_amount,
    watching,
    withdrawFreeDays: features?.withdrawFreeDays ?? null,
  }
}

/** The dialog's readiness for one invoice; null when the company has no live connection. */
export async function loadInvoiceReadiness(
  deps: RefreshDeps & { userId: string },
  companyId: string,
  invoiceId: string,
  dismissedTransactionIds: readonly string[] = [],
): Promise<CollectionReadinessView | null> {
  const connection = await loadLiveConnection(deps.db, companyId)
  if (!connection) return null
  const provider = await getCollectionsProvider(connection.route)
  const ctx = await loadHandoverContext(deps.db, {
    companyId,
    invoiceId,
    connection,
    features: provider?.features ?? null,
    dismissedTransactionIds,
    purpose: 'collections_check',
    userId: deps.userId,
    now: deps.now ? deps.now() : new Date(),
    log: deps.log,
  })
  return readinessView(ctx, connection, provider?.features ?? null)
}

/**
 * The click-time check before an escalation of an open case (approve_step,
 * confirm_not_paid, start on a watched claim): what the books say is owed,
 * what the provider last said, the bank check, and the refusal the commit
 * would answer now without an attestation (null = it may go ahead). The
 * commit runs the same check again (case-actions.ts).
 */
export interface CaseEscalationCheckView {
  remaining: number
  providerOutstanding: number | null
  refusal: { code: string; details?: Record<string, unknown> } | null
  bankCheck: BankCheckView
}

export async function loadCaseEscalationCheck(
  deps: RefreshDeps,
  companyId: string,
  invoiceId: string,
  dismissedTransactionIds: readonly string[] = [],
): Promise<CaseEscalationCheckView | null> {
  const row = await loadOpenCaseForInvoice(deps.db, companyId, invoiceId)
  if (!row || row.submission_status !== 'registered' || !row.actions.some((a) => BANK_CHECKED_ACTIONS.has(a))) return null
  const check = await loadEscalationCheck(deps.db, {
    companyId,
    row,
    dismissedTransactionIds,
    now: deps.now ? deps.now() : new Date(),
  })
  const refused = escalationRefusal(check, { bankAttested: false, channel: 'web' })
  return {
    remaining: check.ledgerRemaining,
    providerOutstanding: check.providerOutstanding,
    refusal: refused ? { code: refused.code, ...(refused.details ? { details: refused.details } : {}) } : null,
    bankCheck: bankCheckView(check.bankCheck),
  }
}
