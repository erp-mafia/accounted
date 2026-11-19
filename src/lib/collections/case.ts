import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  CollectionsAction,
  CollectionsCase,
  CollectionsCloseReason,
  CollectionsDecisionKind,
  CollectionsStage,
} from '@accounted/connect-contract'
import { eventBus } from '@/lib/events'
import { createLogger } from '@/lib/logger'
import { roundOre } from '@/lib/money'
import { stripPersonalNumbers, stripPersonalNumbersDeep } from './personal-number'
import type { BankCheckSnapshot } from './bank-check'
import type { ForwardIssueView } from './forwarding'
import type { PossiblePaymentView } from './bank-sweep'
import { recordCollectedPayments } from './collected-payment-record'

const log = createLogger('collections/case')

/**
 * A collection case as the ledger stores it (collection_cases, migration
 * 20261012030200), the view the invoice page renders, and the one function
 * that writes what the provider says about a case (applyCaseSnapshot): the
 * open-case service, the actions, the on-demand refresh and the sync cron
 * all go through it, so a snapshot reads the same whoever fetched it.
 */

export type SubmissionStatus = 'preparing' | 'submitted' | 'registered' | 'failed'

export interface CollectionCaseRow {
  id: string
  company_id: string
  invoice_id: string
  connection_id: string
  origin: 'handover' | 'batch' | 'distribution'
  start_step: 'invoice' | 'reminder' | 'collection'
  submission_status: SubmissionStatus
  submission_request: Record<string, unknown> | null
  submission_attempts: number
  provider_case_ref: string | null
  provider_case_number: string | null
  parent_case_ref: string | null
  stage: CollectionsStage
  decision_kind: CollectionsDecisionKind | null
  is_open: boolean
  close_reason: CollectionsCloseReason | null
  provider_state: string | null
  provider_state_label: string | null
  next_action_date: string | null
  next_action_label: string | null
  actions: CollectionsAction[]
  claim_amount: number
  currency: 'SEK'
  outstanding_principal: number | null
  outstanding_total: number | null
  bank_check: BankCheckSnapshot
  last_bank_checked_at: string | null
  paused_by_sweep: boolean
  /** Why the ledger paused the case on its own: 'possible_payment' (bank-sweep.ts) or 'outstanding_mismatch' (reconcile.ts). */
  pause_reason: string | null
  /** The provider's remaining principal minus what the books expect, at the last reconcile; null while they agree. */
  outstanding_mismatch: number | null
  outstanding_expected: number | null
  last_reconciled_at: string | null
  opened_by: string | null
  opened_at: string
  closed_at: string | null
  last_synced_at: string | null
  sync_error: string | null
  pending_operation_id: string | null
  created_at: string
  updated_at: string
}

const toNumber = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))

/** numeric columns arrive as strings from some drivers: one shape here. */
export function normalizeCaseRow(raw: Record<string, unknown>): CollectionCaseRow {
  const row = raw as unknown as CollectionCaseRow
  return {
    ...row,
    claim_amount: Number(row.claim_amount),
    outstanding_principal: toNumber(row.outstanding_principal),
    outstanding_total: toNumber(row.outstanding_total),
    outstanding_mismatch: toNumber(row.outstanding_mismatch),
    outstanding_expected: toNumber(row.outstanding_expected),
    last_reconciled_at: row.last_reconciled_at ?? null,
    paused_by_sweep: row.paused_by_sweep === true,
    pause_reason: row.pause_reason ?? null,
    submission_attempts: Number(row.submission_attempts ?? 0),
    actions: (row.actions ?? []) as CollectionsAction[],
  }
}

/** The invoice's open case (any submission status), or null. */
export async function loadOpenCaseForInvoice(
  db: Pick<SupabaseClient, 'from'>,
  companyId: string,
  invoiceId: string,
): Promise<CollectionCaseRow | null> {
  const { data, error } = await db
    .from('collection_cases')
    .select('*')
    .eq('company_id', companyId)
    .eq('invoice_id', invoiceId)
    .eq('is_open', true)
    .maybeSingle()
  if (error) throw new Error(`collection_cases lookup failed: ${error.message}`)
  return data ? normalizeCaseRow(data as Record<string, unknown>) : null
}

/** The invoice's open case, else its most recent one (a closed or refused case keeps its card). */
export async function loadCurrentCaseForInvoice(
  db: Pick<SupabaseClient, 'from'>,
  companyId: string,
  invoiceId: string,
): Promise<CollectionCaseRow | null> {
  const { data, error } = await db
    .from('collection_cases')
    .select('*')
    .eq('company_id', companyId)
    .eq('invoice_id', invoiceId)
    .neq('submission_status', 'preparing')
    .order('is_open', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(1)
  if (error) throw new Error(`collection_cases lookup failed: ${error.message}`)
  const row = ((data ?? []) as Record<string, unknown>[])[0]
  return row ? normalizeCaseRow(row) : null
}

export async function loadCaseById(
  db: Pick<SupabaseClient, 'from'>,
  companyId: string | null,
  caseId: string,
): Promise<CollectionCaseRow | null> {
  let query = db.from('collection_cases').select('*').eq('id', caseId)
  if (companyId) query = query.eq('company_id', companyId)
  const { data, error } = await query.maybeSingle()
  if (error) throw new Error(`collection_cases lookup failed: ${error.message}`)
  return data ? normalizeCaseRow(data as Record<string, unknown>) : null
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type CaseEventKind =
  | 'stage'
  | 'letter'
  | 'sms'
  | 'call'
  | 'payment'
  | 'note'
  | 'decision'
  | 'user_action'
  | 'payment_forwarded'
  | 'payment_reverted'
  | 'credit_forwarded'
  | 'possible_payment'
  | 'sync_error'
  | 'other'

export interface CaseEventRow {
  id: string
  case_id: string
  occurred_at: string
  kind: CaseEventKind | string
  stage_from: string | null
  stage_to: string | null
  direction: 'to_debtor' | 'from_debtor' | 'internal' | null
  label: string
  amount: number | null
  actor_user_id: string | null
  provider_event_ref: string | null
}

export interface NewCaseEvent {
  kind: CaseEventKind
  label: string
  occurredAt: string
  stageFrom?: string | null
  stageTo?: string | null
  direction?: CaseEventRow['direction']
  amount?: number | null
  actorUserId?: string | null
  providerEventRef?: string | null
  raw?: Record<string, unknown> | null
}

const MAX_LABEL = 500

/**
 * Append trail rows; a provider event already recorded for the case is
 * skipped (re-reads are idempotent). A re-read brings the provider's whole
 * timeline again, so the events the trail already holds are looked up first
 * and only the new ones are written, each as one object literal so the schema
 * guard checks every column. The conflict target still drops a provider event
 * a concurrent reader wrote in between; the index is not partial and NULLs
 * are distinct in it, so the ledger's own rows (no provider ref) always land.
 */
export async function appendCaseEvents(
  db: Pick<SupabaseClient, 'from'>,
  row: Pick<CollectionCaseRow, 'id' | 'company_id'>,
  events: readonly NewCaseEvent[],
): Promise<void> {
  if (events.length === 0) return
  // The case's recorded provider events (not an in-list: a long timeline
  // would outgrow the URL). A read capped short only means a few more
  // upserts, which the conflict target drops.
  let known = new Set<string>()
  if (events.some((e) => (e.providerEventRef ?? null) !== null)) {
    const { data, error } = await db
      .from('collection_case_events')
      .select('provider_event_ref')
      .eq('case_id', row.id)
      .not('provider_event_ref', 'is', null)
    if (error) throw new Error(`collection_case_events lookup failed: ${error.message}`)
    known = new Set(((data ?? []) as { provider_event_ref: string }[]).map((r) => r.provider_event_ref))
  }
  // Provider events first, then the ledger's own rows, as before.
  const ordered = [
    ...events.filter((e) => (e.providerEventRef ?? null) !== null),
    ...events.filter((e) => (e.providerEventRef ?? null) === null),
  ]
  for (const e of ordered) {
    const providerEventRef = e.providerEventRef ?? null
    if (providerEventRef !== null && known.has(providerEventRef)) continue
    const { error } = await db.from('collection_case_events').upsert(
      {
        company_id: row.company_id,
        case_id: row.id,
        occurred_at: e.occurredAt,
        kind: e.kind,
        stage_from: e.stageFrom ?? null,
        stage_to: e.stageTo ?? null,
        direction: e.direction ?? null,
        label: stripPersonalNumbers(e.label).slice(0, MAX_LABEL) || e.kind,
        amount: e.amount === null || e.amount === undefined ? null : roundOre(e.amount),
        actor_user_id: e.actorUserId ?? null,
        provider_event_ref: providerEventRef,
        raw: e.raw ? stripPersonalNumbersDeep(e.raw) : null,
      },
      { onConflict: 'case_id,provider_event_ref', ignoreDuplicates: true },
    )
    if (error) throw new Error(`collection_case_events insert failed: ${error.message}`)
  }
}

export async function loadCaseEvents(
  db: Pick<SupabaseClient, 'from'>,
  caseId: string,
  limit = 200,
): Promise<CaseEventRow[]> {
  const { data, error } = await db
    .from('collection_case_events')
    .select('id, case_id, occurred_at, kind, stage_from, stage_to, direction, label, amount, actor_user_id, provider_event_ref')
    .eq('case_id', caseId)
    .order('occurred_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(`collection_case_events lookup failed: ${error.message}`)
  return ((data ?? []) as CaseEventRow[]).map((e) => ({ ...e, amount: toNumber(e.amount) }))
}

/** How many decisions the company has taken on the case: the idempotency key of the next action counts them. */
export async function countUserActions(db: Pick<SupabaseClient, 'from'>, caseId: string): Promise<number> {
  const { count, error } = await db
    .from('collection_case_events')
    .select('id', { count: 'exact', head: true })
    .eq('case_id', caseId)
    .eq('kind', 'user_action')
  if (error) throw new Error(`collection_case_events count failed: ${error.message}`)
  return count ?? 0
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

/** The columns a provider snapshot sets on the case. Pure. */
export function snapshotCasePatch(row: CollectionCaseRow, snapshot: CollectionsCase, now: Date): Record<string, unknown> {
  const at = now.toISOString()
  const closing = row.is_open && !snapshot.isOpen
  const reopening = !row.is_open && snapshot.isOpen
  return {
    submission_status: 'registered',
    submission_request: null,
    provider_case_ref: row.provider_case_ref ?? snapshot.caseRef,
    provider_case_number: snapshot.caseNumber,
    parent_case_ref: snapshot.parentCaseRef,
    stage: snapshot.stage,
    decision_kind: snapshot.stage === 'awaiting_decision' ? snapshot.decisionKind : null,
    is_open: snapshot.isOpen,
    close_reason: snapshot.isOpen ? null : snapshot.closeReason,
    closed_at: closing ? at : reopening ? null : row.closed_at,
    provider_state: snapshot.providerState,
    provider_state_label: stripPersonalNumbers(snapshot.providerStateLabel).slice(0, MAX_LABEL),
    next_action_date: snapshot.nextActionDate,
    next_action_label: snapshot.nextActionLabel ? stripPersonalNumbers(snapshot.nextActionLabel).slice(0, MAX_LABEL) : null,
    actions: snapshot.isOpen ? snapshot.actions : [],
    outstanding_principal: roundOre(snapshot.outstandingPrincipal),
    outstanding_total: roundOre(snapshot.outstandingTotal),
    last_synced_at: at,
    sync_error: null,
    // A closed case holds nothing to pause or reconcile.
    ...(snapshot.isOpen ? {} : { paused_by_sweep: false, pause_reason: null, outstanding_mismatch: null }),
  }
}

/**
 * Ledger-written trail rows carry a reference with one of these prefixes;
 * their label is a key the case card translates.
 */
export const COLLECTED_EVENT_PREFIX = 'collected:'
export const RECONCILE_EVENT_PREFIX = 'reconcile:'

/**
 * The provider's timeline as trail rows (deduplicated on the provider's
 * event id when written), and the payments the customer made to the
 * provider itself, read out once each: what the provider says it collected
 * (its own payment list, never the payments the ledger reported). Booking
 * them is a separate step. Pure.
 */
export function snapshotEvents(snapshot: CollectionsCase): NewCaseEvent[] {
  const events: NewCaseEvent[] = snapshot.events.map((e) => ({
    kind: e.kind,
    label: e.label || e.kind,
    occurredAt: e.occurredAt,
    direction: e.direction,
    amount: e.amount,
    providerEventRef: e.eventRef,
  }))
  for (const p of snapshot.collectedPayments) {
    if (!p.paymentRef || !(roundOre(p.total) > 0 || roundOre(p.capitalPaid) > 0)) continue
    events.push({
      kind: 'payment',
      label: 'collected',
      occurredAt: `${p.paidAt}T12:00:00.000Z`,
      direction: 'from_debtor',
      amount: roundOre(p.total > 0 ? p.total : p.capitalPaid),
      providerEventRef: `${COLLECTED_EVENT_PREFIX}${p.paymentRef}`.slice(0, 128),
      raw: {
        capital_paid: roundOre(p.capitalPaid),
        to_creditor_other: roundOre(p.toCreditorOther),
        to_agency: roundOre(p.toAgency),
      },
    })
  }
  return events
}

/** Provider event kinds that mark a move to a new stage. */
const TRANSITION_EVENT_KINDS: ReadonlySet<string> = new Set(['stage', 'letter', 'decision'])

/**
 * The newest provider event this read brings for the first time that marks
 * a stage move, or null. Events already recorded for the case are not new:
 * they marked an earlier move.
 */
async function transitionMarker(
  db: Pick<SupabaseClient, 'from'>,
  caseId: string,
  events: NewCaseEvent[],
): Promise<NewCaseEvent | null> {
  const candidates = events.filter((e) => e.providerEventRef && TRANSITION_EVENT_KINDS.has(e.kind))
  if (candidates.length === 0) return null
  const { data, error } = await db
    .from('collection_case_events')
    .select('provider_event_ref')
    .eq('case_id', caseId)
    .in('provider_event_ref', candidates.map((e) => e.providerEventRef as string))
  if (error) throw new Error(`collection_case_events lookup failed: ${error.message}`)
  const seen = new Set(((data ?? []) as { provider_event_ref: string }[]).map((r) => r.provider_event_ref))
  const fresh = candidates.filter((e) => !seen.has(e.providerEventRef as string))
  return fresh.reduce<NewCaseEvent | null>((newest, e) => (!newest || e.occurredAt >= newest.occurredAt ? e : newest), null)
}

export interface ApplySnapshotResult {
  row: CollectionCaseRow
  stageChanged: boolean
  closed: boolean
}

/**
 * Store what the provider says about a case: the stage, the decision it
 * waits for, the actions it offers, the amounts, its timeline. The stage
 * transition is written as a conditional update on the stage the caller
 * read, so two concurrent readers record one stage event, not two.
 */
export async function applyCaseSnapshot(
  db: Pick<SupabaseClient, 'from'>,
  row: CollectionCaseRow,
  snapshot: CollectionsCase,
  options: { now?: Date; userId?: string | null } = {},
): Promise<ApplySnapshotResult> {
  const now = options.now ?? new Date()
  const patch = snapshotCasePatch(row, snapshot, now)
  // The patch written out key by key, one object literal, so the schema guard
  // checks every column. `guarded` adds the conditional part: the stage and
  // open flag the caller read.
  const writeSnapshot = (guarded: boolean) => {
    let query = db
      .from('collection_cases')
      .update({
        submission_status: patch.submission_status,
        submission_request: patch.submission_request,
        provider_case_ref: patch.provider_case_ref,
        provider_case_number: patch.provider_case_number,
        parent_case_ref: patch.parent_case_ref,
        stage: patch.stage,
        decision_kind: patch.decision_kind,
        is_open: patch.is_open,
        close_reason: patch.close_reason,
        closed_at: patch.closed_at,
        provider_state: patch.provider_state,
        provider_state_label: patch.provider_state_label,
        next_action_date: patch.next_action_date,
        next_action_label: patch.next_action_label,
        actions: patch.actions,
        outstanding_principal: patch.outstanding_principal,
        outstanding_total: patch.outstanding_total,
        last_synced_at: patch.last_synced_at,
        sync_error: patch.sync_error,
        // Set only when the snapshot closes the case; undefined never goes on the wire.
        paused_by_sweep: patch.paused_by_sweep,
        pause_reason: patch.pause_reason,
        outstanding_mismatch: patch.outstanding_mismatch,
      })
      .eq('id', row.id)
    if (guarded) query = query.eq('stage', row.stage).eq('is_open', row.is_open)
    return query.select('*').maybeSingle()
  }
  const { data, error } = await writeSnapshot(true)
  if (error) throw new Error(`collection_cases update failed: ${error.message}`)

  let updated: CollectionCaseRow
  let won = true
  if (data) {
    updated = normalizeCaseRow(data as Record<string, unknown>)
  } else {
    // Someone else moved the case first: write the same snapshot without the transition.
    won = false
    const { data: again, error: againError } = await writeSnapshot(false)
    if (againError) throw new Error(`collection_cases update failed: ${againError.message}`)
    if (!again) throw new Error(`collection case ${row.id} disappeared`)
    updated = normalizeCaseRow(again as Record<string, unknown>)
  }

  const stageChanged = won && (row.stage !== updated.stage || row.is_open !== updated.is_open)
  const closed = won && row.is_open && !updated.is_open
  const events = snapshotEvents(snapshot)
  if (stageChanged) {
    // The provider's timeline is the record: a letter, a stage or a decision
    // it reports with this read marks the transition, and that row carries
    // it. A row of our own only when the provider reported none, so a letter
    // never shows twice.
    const transition = { stageFrom: row.stage, stageTo: updated.stage }
    const marker = await transitionMarker(db, updated.id, events)
    if (marker) Object.assign(marker, transition)
    else {
      events.push({
        kind: 'stage',
        label: updated.provider_state_label || updated.stage,
        occurredAt: now.toISOString(),
        direction: 'internal',
        ...transition,
      })
    }
  }
  await appendCaseEvents(db, updated, events)
  await acknowledgeReportedPayments(db, updated, snapshot, now)
  // What the customer paid the provider itself, kept for its booking
  // (collected-payments.ts). Best-effort: the next read records it again.
  try {
    await recordCollectedPayments(db, updated, snapshot)
  } catch (err) {
    log.warn('collected payments not recorded', { caseId: updated.id, error: err instanceof Error ? err.message : String(err) })
  }

  // The person who acted, else (a change the sync read) the person who handed the invoice over.
  const eventUserId = options.userId ?? updated.opened_by
  if (stageChanged && eventUserId) {
    try {
      await eventBus.emit({
        type: closed ? 'collection.case_closed' : 'collection.case_updated',
        payload: {
          caseId: updated.id,
          invoiceId: updated.invoice_id,
          stage: updated.stage,
          previousStage: row.stage,
          closeReason: updated.close_reason,
          companyId: updated.company_id,
          userId: eventUserId,
        },
      })
    } catch (err) {
      log.warn('collection case event emit failed', { caseId: updated.id, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return { row: updated, stageChanged, closed }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Mark the payment reports the provider lists as its own (the snapshot's
 * reportedPayments) as acknowledged on their forward rows
 * (collection_payment_forwards). Best-effort: the next read repeats it.
 */
export async function acknowledgeReportedPayments(
  db: Pick<SupabaseClient, 'from'>,
  caseRow: Pick<CollectionCaseRow, 'id'>,
  snapshot: Pick<CollectionsCase, 'reportedPayments'>,
  now: Date,
): Promise<void> {
  const refs = [...new Set(snapshot.reportedPayments.map((p) => p.paymentRef).filter((ref) => UUID_RE.test(ref)))]
  if (refs.length === 0) return
  try {
    const { error } = await db
      .from('collection_payment_forwards')
      .update({ acknowledged_at: now.toISOString() })
      .eq('case_id', caseRow.id)
      .eq('kind', 'payment')
      .in('invoice_payment_id', refs)
      .in('status', ['forwarded', 'revert_pending'])
      .is('acknowledged_at', null)
    if (error) log.warn('collection forwards not acknowledged', { caseId: caseRow.id, error: error.message })
  } catch (err) {
    log.warn('collection forwards not acknowledged', { caseId: caseRow.id, error: err instanceof Error ? err.message : String(err) })
  }
}

/** Record that reading or retrying a case failed, without touching what the provider last said. */
export async function recordCaseSyncError(
  db: Pick<SupabaseClient, 'from'>,
  row: Pick<CollectionCaseRow, 'id'>,
  code: string,
): Promise<void> {
  const { error } = await db.from('collection_cases').update({ sync_error: code.slice(0, 200) }).eq('id', row.id)
  if (error) log.warn('collection_cases sync_error update failed', { caseId: row.id, error: error.message })
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

/** The case as the invoice page renders it: never the provider's handle or the in-flight request. */
export interface CollectionCaseView {
  id: string
  invoiceId: string
  origin: CollectionCaseRow['origin']
  startStep: CollectionCaseRow['start_step']
  submissionStatus: SubmissionStatus
  caseNumber: string | null
  merged: boolean
  stage: CollectionsStage
  decisionKind: CollectionsDecisionKind | null
  isOpen: boolean
  closeReason: CollectionsCloseReason | null
  providerStateLabel: string | null
  nextActionDate: string | null
  nextActionLabel: string | null
  actions: CollectionsAction[]
  claimAmount: number
  outstandingPrincipal: number | null
  outstandingTotal: number | null
  pausedBySweep: boolean
  /** Why the ledger paused the case on its own (with pausedBySweep). */
  pauseReason: 'possible_payment' | 'outstanding_mismatch' | null
  /** The provider claims a different principal than the books expect (reconcile.ts); null while they agree. */
  outstandingMismatch: { provider: number; expected: number } | null
  /** Bank rows the sweep found that may pay the invoice, still unanswered (bank-sweep.ts). */
  possiblePayments: PossiblePaymentView[]
  openedAt: string
  closedAt: string | null
  lastSyncedAt: string | null
  syncError: string | null
  /** Payment and credit-note reports to the provider a person should know about (forwarding.ts). */
  forwardIssues: ForwardIssueView[]
  /**
   * A payment or credit-note report is on its way to the provider: the
   * amounts shown predate it, and the page reads the case again shortly.
   */
  forwardsInFlight: boolean
  events: Array<{
    id: string
    occurredAt: string
    kind: string
    stageFrom: string | null
    stageTo: string | null
    direction: CaseEventRow['direction']
    label: string
    /** For a row the ledger wrote itself: the message key its label stands for. */
    labelKey: string | null
    amount: number | null
  }>
}

/** The message key of a ledger-written trail row, or null for the provider's own rows (shown as written). Pure. */
export function eventLabelKey(event: Pick<CaseEventRow, 'kind' | 'label' | 'provider_event_ref'>): string | null {
  const ref = event.provider_event_ref ?? ''
  if (event.kind === 'user_action') return `event_action_${event.label}`
  if (event.kind === 'payment_forwarded' || event.kind === 'payment_reverted' || event.kind === 'credit_forwarded') {
    return `event_forward_${event.kind}_${event.label}`
  }
  if (event.kind === 'possible_payment') return `event_possible_payment_${event.label}`
  if (ref.startsWith(COLLECTED_EVENT_PREFIX)) return 'event_collected'
  if (ref.startsWith(RECONCILE_EVENT_PREFIX)) return `event_reconcile_${event.label}`
  return null
}

const PAUSE_REASONS: ReadonlySet<string> = new Set(['possible_payment', 'outstanding_mismatch'])

export function caseView(
  row: CollectionCaseRow,
  events: readonly CaseEventRow[],
  forwardIssues: readonly ForwardIssueView[] = [],
  possiblePayments: readonly PossiblePaymentView[] = [],
  extras: { forwardsInFlight?: boolean } = {},
): CollectionCaseView {
  return {
    id: row.id,
    invoiceId: row.invoice_id,
    origin: row.origin,
    startStep: row.start_step,
    submissionStatus: row.submission_status,
    caseNumber: row.provider_case_number,
    merged: row.parent_case_ref !== null,
    stage: row.stage,
    decisionKind: row.decision_kind,
    isOpen: row.is_open,
    closeReason: row.close_reason,
    providerStateLabel: row.provider_state_label,
    nextActionDate: row.next_action_date,
    nextActionLabel: row.next_action_label,
    actions: row.is_open && row.submission_status === 'registered' ? row.actions : [],
    claimAmount: row.claim_amount,
    outstandingPrincipal: row.outstanding_principal,
    outstandingTotal: row.outstanding_total,
    pausedBySweep: row.paused_by_sweep,
    pauseReason: row.paused_by_sweep && row.pause_reason && PAUSE_REASONS.has(row.pause_reason)
      ? (row.pause_reason as 'possible_payment' | 'outstanding_mismatch')
      : null,
    outstandingMismatch:
      row.is_open && row.outstanding_mismatch !== null && row.outstanding_expected !== null
        ? { provider: roundOre(row.outstanding_expected + row.outstanding_mismatch), expected: row.outstanding_expected }
        : null,
    possiblePayments: row.is_open ? [...possiblePayments] : [],
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    lastSyncedAt: row.last_synced_at,
    syncError: row.sync_error,
    forwardIssues: [...forwardIssues],
    forwardsInFlight: extras.forwardsInFlight ?? false,
    events: withHandoverEvent(
      row,
      events.map((e) => ({
        id: e.id,
        occurredAt: e.occurred_at,
        kind: e.kind,
        stageFrom: e.stage_from,
        stageTo: e.stage_to,
        direction: e.direction,
        label: e.label,
        labelKey: eventLabelKey(e),
        amount: e.amount,
      })),
    ),
  }
}

/**
 * The handover itself on the trail, newest first like the rest: the case row
 * records when the company sent the invoice and where it starts, no event row
 * does (the provider's timeline begins at its own first step). Shown once the
 * provider registered the claim. Pure.
 */
function withHandoverEvent(
  row: Pick<CollectionCaseRow, 'id' | 'opened_at' | 'start_step' | 'submission_status' | 'claim_amount'>,
  events: CollectionCaseView['events'],
): CollectionCaseView['events'] {
  if (!row.opened_at || row.submission_status !== 'registered') return events
  const label = `handover_${row.start_step}`
  const handover: CollectionCaseView['events'][number] = {
    id: `handover:${row.id}`,
    occurredAt: row.opened_at,
    kind: 'user_action',
    stageFrom: null,
    stageTo: null,
    direction: 'internal',
    label,
    labelKey: `event_action_${label}`,
    amount: row.claim_amount,
  }
  const at = events.findIndex((e) => e.occurredAt < handover.occurredAt)
  return at === -1 ? [...events, handover] : [...events.slice(0, at), handover, ...events.slice(at)]
}
