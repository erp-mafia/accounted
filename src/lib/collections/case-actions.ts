import { isOwedInvoiceStatus } from '@/lib/bookkeeping/matchable-statuses'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CollectionsAction, CollectionsCaseActionRequest } from '@accounted/connect-contract'
import { roundOre } from '@/lib/money'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { runBankCheck, type BankCheckResult } from './bank-check'
import {
  applyCaseSnapshot,
  appendCaseEvents,
  countUserActions,
  loadOpenCaseForInvoice,
  type CollectionCaseRow,
} from './case'
import { collectionClaim } from './eligibility'
import { isCollectionsError } from './errors'
import type { CollectionsPath } from './flags'
import { getCollectionsProvider } from './catalogue'
import { loadLiveConnection } from './connection'
import { handoverRefusal, openCollectionCase, type OpenCaseInput, type OpenCaseOutcome } from './open-case'
import { HandoverNotFoundError, loadHandoverContext, loadHandoverInvoice, type HandoverInvoice } from './readiness'
import {
  adapterForConnection,
  callContext,
  gateRefusal,
  loadConnectionById,
  refusal,
  serviceLog,
  type CollectionsRefusal,
  type CollectionsServiceDeps,
} from './service-deps'
import {
  BANK_CHECKED_ACTIONS,
  LEDGER_ONLY_CASE_ACTIONS,
  MAX_PAUSE_DAYS,
  MESSAGE_REQUIRED_ACTIONS,
  MIN_ACTION_MESSAGE,
  pauseUntilWindow,
  withdrawFeeInfo,
} from './stages'

/**
 * Actions on an open case (build spec 3.5): pause (optionally until a date),
 * resume, withdraw, dispute, contest, the decisions the provider waits for,
 * and the start of reminders on a delivered invoice. Shared by POST
 * /api/invoices/[id]/collection/actions and the staged operation
 * collections.cases.action. `start` runs only from handOverInvoice, after
 * the full handover checklist: those two doors refuse it.
 *
 * `start` and `approve_step` begin new work: they pass the start gates. They
 * and confirm_not_paid (the provider keeps pursuing the customer after it)
 * are escalations: before each one the ledger checks, at click time (GET
 * ?readiness=1) and again here at commit, that the invoice is still owed,
 * that the provider has heard of every payment the books hold, and the bank.
 * Every other action serves the open case and runs whatever the start gates
 * say: a lapsed plan or a kill switch never stops a company from pausing or
 * withdrawing a case.
 *
 * Withdrawing after the provider's free days (or when it states none) may
 * cost a fee: the person confirms that before the case is withdrawn.
 *
 * `already_paid` is never sent: when the customer has paid, the payment is
 * booked on the invoice and reported to the provider, which closes the case;
 * when not, confirm_not_paid contests the customer's word.
 *
 * Idempotency: the key is the case id, the action and how many decisions the
 * company has taken on the case so far. A retry after a failure sends the
 * same key, so Connect answers it with the first result; the next decision
 * after a success gets a new key.
 */

export interface CaseActionInput {
  invoiceId: string
  action: CollectionsAction
  /** For `start`: where the provider begins. */
  step?: 'reminder' | 'collection' | null
  message?: string | null
  /** For `pause`: the provider postpones its next step until and including this date (YYYY-MM-DD, after today). */
  until?: string | null
  attestations?: { bank?: boolean }
  dismissedTransactionIds?: string[]
  /** For `withdraw`: the person saw that the provider may charge for the withdrawal. */
  feeAcknowledged?: boolean
  /**
   * Set only by handOverInvoice, once the full handover checklist has passed
   * (eligibility, the attestations the facts ask for, the amount the person
   * saw). A `start` without it is refused: the action route and the case
   * action tool cannot carry those facts.
   */
  handoverChecked?: boolean
  dryRun?: boolean
}

export type CaseActionOutcome =
  | { ok: true; dryRun: true; preview: Record<string, unknown> }
  | { ok: true; dryRun?: false; case: CollectionCaseRow }
  | CollectionsRefusal

const ACTION_PATHS: Record<CollectionsAction, CollectionsPath> = {
  start: 'case_start',
  approve_step: 'case_approve_step',
  pause: 'case_pause',
  resume: 'case_resume',
  withdraw: 'case_withdraw',
  dispute: 'case_dispute',
  contest_dispute: 'case_contest_dispute',
  already_paid: 'case_already_paid',
  confirm_not_paid: 'case_confirm_not_paid',
  approve_legal_action: 'case_legal_action_decision',
  decline_legal_action: 'case_legal_action_decision',
}

export { MAX_PAUSE_DAYS, MIN_ACTION_MESSAGE }


/** What an escalation of a case is decided on: what the books say is still owed, and the bank. */
export interface EscalationCheck {
  invoice: HandoverInvoice
  /** The customer's share still unpaid according to the books. */
  ledgerRemaining: number
  /** What the provider last said is left of the principal; null before its first snapshot. */
  providerOutstanding: number | null
  bankCheck: BankCheckResult
}

/** What the books say the customer still owes on a case invoice, with the invoice and its customer. */
export interface LedgerRemaining {
  invoice: HandoverInvoice
  customerRow: Record<string, unknown> | null
  /** The customer's share still unpaid according to the books (0 once paid, credited or cancelled). */
  ledgerRemaining: number
}

/** Load what the books say is still owed on the case's invoice. Throws HandoverNotFoundError without the invoice. */
export async function loadLedgerRemaining(
  db: Pick<SupabaseClient, 'from'>,
  companyId: string,
  invoiceId: string,
): Promise<LedgerRemaining> {
  const [{ invoice, customerRow }, settings] = await Promise.all([
    loadHandoverInvoice(db, companyId, invoiceId),
    db.from('company_settings').select('ore_rounding').eq('company_id', companyId).maybeSingle(),
  ])
  if (settings.error) throw new Error(`company_settings lookup failed: ${settings.error.message}`)
  const companyOreRounding = (settings.data as { ore_rounding?: boolean | null } | null)?.ore_rounding ?? null
  // The claim's own arithmetic (the printed amount less what was paid), the
  // same the provider applies to the amount and the payments it was told
  // about: comparing it with remaining_amount would read the öresavrundning
  // as an unreported payment.
  const ledgerRemaining =
    isOwedInvoiceStatus(invoice.status) && invoice.remaining_amount > 0 ? collectionClaim(invoice, companyOreRounding).remaining : 0
  return { invoice, customerRow, ledgerRemaining }
}

/** Load the facts an escalation of an open case is decided on. Throws HandoverNotFoundError without the invoice. */
export async function loadEscalationCheck(
  db: Pick<SupabaseClient, 'from'>,
  input: { companyId: string; row: CollectionCaseRow; dismissedTransactionIds: readonly string[]; now: Date },
): Promise<EscalationCheck> {
  const { companyId, row, now } = input
  const { invoice, customerRow, ledgerRemaining } = await loadLedgerRemaining(db, companyId, row.invoice_id)
  const providerOutstanding = row.outstanding_principal === null ? null : roundOre(row.outstanding_principal)
  const bankCheck = await runBankCheck(db, {
    companyId,
    invoice,
    customerName: typeof customerRow?.name === 'string' ? customerRow.name : null,
    // A name match counts up to the larger of the two: what the customer may still pay either of us.
    remaining: roundOre(Math.max(ledgerRemaining, providerOutstanding ?? row.claim_amount)),
    dismissedTransactionIds: input.dismissedTransactionIds,
    today: todayIsoStockholm(now),
    now,
  })
  return { invoice, ledgerRemaining, providerOutstanding, bankCheck }
}

/**
 * Whether an escalation may go ahead (rule 5: never let the provider
 * escalate an invoice that may already be paid). Refused when the books say
 * the invoice is paid, when the books hold a payment the provider has not
 * heard of yet (its outstanding principal is above what the books say is
 * owed), when an unbooked bank row may be the payment, and, without a
 * person's attestation in the web UI, when the bank is not fresh. Pure.
 */
export function escalationRefusal(
  check: Pick<EscalationCheck, 'ledgerRemaining' | 'providerOutstanding' | 'bankCheck'>,
  input: { bankAttested: boolean; channel: 'web' | 'agent' },
): CollectionsRefusal | null {
  if (check.ledgerRemaining <= 0) return refusal('COLLECTION_NOT_ELIGIBLE', { blocks: [{ code: 'elig_paid' }] })
  if (check.providerOutstanding !== null && check.ledgerRemaining < check.providerOutstanding) {
    return refusal('COLLECTION_PAYMENT_NOT_REPORTED', {
      remaining: check.ledgerRemaining,
      provider_outstanding: check.providerOutstanding,
    })
  }
  if (check.bankCheck.outcome === 'candidates') {
    return refusal('COLLECTION_BANK_CANDIDATES', {
      candidates: check.bankCheck.candidates.filter((c) => !c.dismissed).map((c) => c.transactionId),
    })
  }
  if (check.bankCheck.outcome !== 'pass' && !(input.channel === 'web' && input.bankAttested)) {
    return input.channel === 'web'
      ? refusal('COLLECTION_ATTESTATION_REQUIRED', { attestations: ['bank'] })
      : refusal('COLLECTION_BANK_STALE', { freshness: check.bankCheck.freshness })
  }
  return null
}

export async function runCaseAction(deps: CollectionsServiceDeps, input: CaseActionInput): Promise<CaseActionOutcome> {
  const now = deps.now ? deps.now() : new Date()
  const { db, companyId } = deps
  const log = serviceLog(deps, 'collections/case-actions')

  const row = await loadOpenCaseForInvoice(db, companyId, input.invoiceId)
  if (!row || row.submission_status !== 'registered' || !row.provider_case_ref) return refusal('COLLECTION_CASE_NOT_FOUND')

  const refused = gateRefusal(ACTION_PATHS[input.action], deps)
  if (refused) return refused
  if (!row.actions.includes(input.action)) {
    return refusal('CONNECTOR_COLLECTIONS_ACTION_UNAVAILABLE', { action: input.action, stage: row.stage })
  }
  if (LEDGER_ONLY_CASE_ACTIONS.has(input.action)) {
    // The customer says it is paid: book the payment (it is reported to the provider), or contest it.
    return refusal('COLLECTION_REGISTER_PAYMENT', { invoice_id: row.invoice_id })
  }
  if (input.action === 'start' && !input.handoverChecked) {
    // Starting on a delivered claim is a handover: it runs the handover's checks first (handOverInvoice).
    return refusal('COLLECTION_START_VIA_HANDOVER', { invoice_id: row.invoice_id })
  }

  const message = input.message?.trim() || null
  if (MESSAGE_REQUIRED_ACTIONS.has(input.action) && (!message || message.length < MIN_ACTION_MESSAGE)) {
    return refusal('COLLECTION_ACTION_MESSAGE_REQUIRED', { min: MIN_ACTION_MESSAGE })
  }
  if (input.action === 'start' && !input.step) return refusal('COLLECTION_START_STEP_UNAVAILABLE', { start_step: null })
  const today = todayIsoStockholm(now)
  const until = input.action === 'pause' ? (input.until ?? null) : null
  const pauseWindow = pauseUntilWindow(today)
  if (until !== null && (until < pauseWindow.earliest || until > pauseWindow.latest)) {
    return refusal('COLLECTION_PAUSE_UNTIL_INVALID', { after: today, latest: pauseWindow.latest })
  }
  // Attestations and "not a payment of this invoice" are a person's word, given in the web UI only.
  if (deps.channel === 'agent' && (input.attestations?.bank || (input.dismissedTransactionIds?.length ?? 0) > 0)) {
    return refusal('COLLECTION_ATTESTATION_WEB_ONLY')
  }

  const connection = await loadConnectionById(db, companyId, row.connection_id)
  if (!connection) return refusal('COLLECTIONS_CONNECTION_NOT_FOUND')

  // Withdrawing after the provider's free days may cost the company a fee: the person confirms it.
  let withdrawFee: ReturnType<typeof withdrawFeeInfo> | null = null
  if (input.action === 'withdraw') {
    const provider = await getCollectionsProvider(connection.route)
    withdrawFee = withdrawFeeInfo(row.opened_at, provider?.features.withdrawFreeDays ?? null, now)
    if (withdrawFee.mayApply && !input.feeAcknowledged) {
      return refusal('COLLECTION_WITHDRAW_FEE_UNACKNOWLEDGED', {
        free_days: withdrawFee.freeDays,
        free_until: withdrawFee.freeUntil,
      })
    }
  }

  // Before the provider may keep pursuing the customer: is the invoice still owed, and unpaid in the bank?
  let bankCheckedAt: string | null = null
  if (BANK_CHECKED_ACTIONS.has(input.action)) {
    let check: EscalationCheck
    try {
      check = await loadEscalationCheck(db, { companyId, row, dismissedTransactionIds: input.dismissedTransactionIds ?? [], now })
    } catch (err) {
      if (err instanceof HandoverNotFoundError) return refusal('INVOICE_NOT_FOUND')
      throw err
    }
    const escalation = escalationRefusal(check, { bankAttested: !!input.attestations?.bank, channel: deps.channel })
    if (escalation) return escalation
    bankCheckedAt = check.bankCheck.checkedAt
  }

  if (input.dryRun) {
    return {
      ok: true,
      dryRun: true,
      preview: {
        invoice_id: row.invoice_id,
        case_id: row.id,
        case_number: row.provider_case_number,
        stage: row.stage,
        action: input.action,
        until,
        bank_checked: bankCheckedAt !== null,
        withdraw_fee_may_apply: withdrawFee?.mayApply ?? null,
      },
    }
  }

  const adapter = adapterForConnection(deps, connection)
  const decisions = await countUserActions(db, row.id)
  const request: CollectionsCaseActionRequest = {
    idempotencyKey: `${row.id}:${input.action}:${decisions}`,
    caseRef: row.provider_case_ref,
    action: input.action,
    step: input.action === 'start' ? (input.step ?? null) : null,
    message,
    until,
  }

  try {
    const snapshot = await adapter.caseAction(callContext(companyId, connection), request)
    const applied = await applyCaseSnapshot(db, row, snapshot, { now, userId: deps.actor.userId })
    if (input.action === 'resume' && applied.row.paused_by_sweep) {
      // A person resumed the case: the automatic pause (bank-sweep.ts, reconcile.ts) is over.
      const { error } = await db.from('collection_cases').update({ paused_by_sweep: false, pause_reason: null }).eq('id', row.id)
      if (error) log.warn('collection_cases paused_by_sweep reset failed', { caseId: row.id, error: error.message })
      else applied.row = { ...applied.row, paused_by_sweep: false, pause_reason: null }
    }
    if (bankCheckedAt) {
      const { error } = await db.from('collection_cases').update({ last_bank_checked_at: bankCheckedAt }).eq('id', row.id)
      if (error) log.warn('collection_cases last_bank_checked_at update failed', { caseId: row.id, error: error.message })
    }
    await appendCaseEvents(db, applied.row, [
      {
        kind: 'user_action',
        label: input.action,
        occurredAt: now.toISOString(),
        actorUserId: deps.actor.userId,
        direction: 'internal',
        raw: {
          action: input.action,
          step: request.step,
          until: request.until,
          has_message: message !== null,
          channel: deps.channel,
          ...(bankCheckedAt ? { bank_checked_at: bankCheckedAt, bank_attested: !!input.attestations?.bank } : {}),
          ...(input.dismissedTransactionIds?.length ? { dismissed_transaction_ids: input.dismissedTransactionIds } : {}),
          ...(withdrawFee ? { withdraw_fee_may_apply: withdrawFee.mayApply, withdraw_fee_acknowledged: !!input.feeAcknowledged } : {}),
        },
      },
    ])
    return { ok: true, case: { ...applied.row, last_bank_checked_at: bankCheckedAt ?? applied.row.last_bank_checked_at } }
  } catch (err) {
    if (!isCollectionsError(err)) throw err
    log.warn('collection case action failed', { caseId: row.id, action: input.action, code: err.code })
    return { ok: false, code: err.code, status: err.retryable ? 503 : 409, upstream: err }
  }
}

/**
 * "Skicka till inkasso" from the invoice: a new handover, or, for an invoice
 * the provider only delivered and watches, the start of reminders on that
 * same claim (build spec 3.4).
 */
export async function handOverInvoice(
  deps: CollectionsServiceDeps,
  input: OpenCaseInput & { startStep?: 'reminder' | 'collection' | null },
): Promise<OpenCaseOutcome | CaseActionOutcome> {
  const open = await loadOpenCaseForInvoice(deps.db, deps.companyId, input.invoiceId)
  if (open && open.stage === 'invoice_sent' && open.submission_status === 'registered') {
    // The same checks as a new handover, except that the case exists.
    const refused = gateRefusal('case_start', deps)
    if (refused) return refused
    const connection = await loadLiveConnection(deps.db, deps.companyId)
    if (!connection) return refusal('COLLECTIONS_NOT_ACTIVE')
    const provider = await getCollectionsProvider(connection.route)
    let ctx: Awaited<ReturnType<typeof loadHandoverContext>>
    try {
      ctx = await loadHandoverContext(deps.db, {
        companyId: deps.companyId,
        invoiceId: input.invoiceId,
        connection,
        features: provider?.features ?? null,
        dismissedTransactionIds: input.dismissedTransactionIds,
        purpose: 'collections_check',
        userId: deps.actor.userId,
        now: deps.now ? deps.now() : new Date(),
        log: deps.log,
      })
    } catch (err) {
      if (err instanceof HandoverNotFoundError) return refusal('INVOICE_NOT_FOUND')
      throw err
    }
    const blocks = ctx.eligibility.blocks.filter((b) => b.code !== 'elig_open_case')
    const problem = handoverRefusal({ ...ctx, eligibility: { ...ctx.eligibility, blocks, eligible: blocks.length === 0 } }, input, deps.channel)
    if (problem) return problem
    if (input.dryRun) {
      return { ok: true, dryRun: true, preview: { invoice_id: input.invoiceId, case_id: open.id, action: 'start', start_step: input.startStep ?? 'reminder' } }
    }
    return runCaseAction(deps, {
      invoiceId: input.invoiceId,
      action: 'start',
      step: input.startStep ?? 'reminder',
      attestations: { bank: input.attestations?.bank },
      dismissedTransactionIds: input.dismissedTransactionIds,
      handoverChecked: true,
      dryRun: input.dryRun,
    })
  }
  return openCollectionCase(deps, input)
}
