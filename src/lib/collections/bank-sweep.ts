import type { SupabaseClient } from '@supabase/supabase-js'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { createLogger, type Logger } from '@/lib/logger'
import { roundOre } from '@/lib/money'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import {
  classifyBankCandidates,
  loadAllocatedTransactionIds,
  loadUnexplainedInboundRows,
  type BankCandidateReason,
  type BankCandidateRow,
} from './bank-check'
import { appendCaseEvents, applyCaseSnapshot, loadCaseById, normalizeCaseRow, type CollectionCaseRow, type NewCaseEvent } from './case'
import { loadLedgerRemaining } from './case-actions'
import { isCollectionsError } from './errors'
import type { CollectionsAdapter, CollectionsRoute } from './port'
import { HandoverNotFoundError } from './readiness'
import { adapterForConnection, callContext, loadConnectionById } from './service-deps'

const defaultLog = createLogger('collections/bank-sweep')

/**
 * The payment-candidate sweep (build spec 3.4, rule 5: never let the
 * provider escalate an invoice that may already be paid).
 *
 * On every bank ingest (sweep-hook.ts, right after the import answers) and
 * nightly (the sync cron), inbound bank rows the books have not explained
 * are checked against every invoice the provider is pursuing, with the same
 * rules as the handover's bank check (bank-check.ts): the printed OCR or the
 * invoice number in the reference or text, the matcher's own hint, or the
 * customer's name with an amount up to what is left. A row that may pay a
 * case invoice:
 *
 *   - is recorded once per case (collection_sweep_hits), so a person who
 *     says it pays something else is never asked again;
 *   - pauses the case at the provider (an obligation path: it runs whatever
 *     the start gates say), with the case id and the bank row as the
 *     idempotency key, unless the case is already paused or the provider
 *     offers no pause in the current step;
 *   - writes a possible_payment row on the case's trail and an Att göra row
 *     (collection_attention_case_ids, possible_payment).
 *
 * Booking the bank row (to the invoice, which reports the payment to the
 * provider, or to anything else) or saying it pays something else answers
 * it. The case stays paused until a person resumes it or the provider closes
 * it as paid. A pause call that fails is tried again on every sync run.
 */

export const SWEEP_PAUSE_MAX_ATTEMPTS = 8
/** A pause still pending this long after its last write is retried (the first attempt is made at once). */
export const SWEEP_PAUSE_RETRY_AFTER_MS = 2 * 60_000
/** Bank row ids per lookup: well inside PostgREST's query-string limits. */
const ID_CHUNK = 150
/** Open hits answered per sync run. */
const RESOLVE_BATCH = 500

export interface SweepDeps {
  /** Service-role client. */
  db: SupabaseClient
  now?: () => Date
  adapterFor?: (connection: { route: CollectionsRoute }) => CollectionsAdapter | null
  log?: Logger
  /** Wall-clock milliseconds for the budget (default Date.now). */
  clock?: () => number
  /** Stop starting new cases after this long (default: no budget). */
  budgetMs?: number
}

export interface SweepOptions {
  /** Only this company's cases. Required with transactionIds. */
  companyId?: string
  /** Only these bank rows (an ingest). Omitted: every unexplained inbound row since each invoice's date (the nightly run). */
  transactionIds?: readonly string[]
}

export interface SweepSummary {
  cases: number
  hits: number
  paused: number
  /** The case was already paused, or the provider offers no pause in its current step. */
  notPaused: number
  failed: number
}

const emptySummary = (): SweepSummary => ({ cases: 0, hits: 0, paused: 0, notPaused: 0, failed: 0 })

// ---------------------------------------------------------------------------
// Pausing a case without a person (the sweep and the reconcile)
// ---------------------------------------------------------------------------

export type AutomaticPauseReason = 'possible_payment' | 'outstanding_mismatch'
export type AutomaticPauseOutcome = 'paused' | 'already_paused' | 'unavailable' | 'failed'

export interface AutomaticPauseResult {
  outcome: AutomaticPauseOutcome
  row: CollectionCaseRow
  error?: string
}

/**
 * Pause an open case at the provider because the ledger found a reason to
 * stop the next step, and mark it as paused by the ledger
 * (paused_by_sweep, pause_reason). A case already paused, or in a step the
 * provider offers no pause for, is left as it is.
 */
export async function pauseCaseAutomatically(
  deps: Pick<SweepDeps, 'db' | 'now' | 'adapterFor' | 'log'>,
  row: CollectionCaseRow,
  input: { idempotencyKey: string; reason: AutomaticPauseReason },
): Promise<AutomaticPauseResult> {
  const log = deps.log ?? defaultLog
  if (!row.is_open || row.submission_status !== 'registered' || !row.provider_case_ref) return { outcome: 'unavailable', row }
  if (row.stage === 'paused') return { outcome: 'already_paused', row }
  if (!row.actions.includes('pause')) return { outcome: 'unavailable', row }
  const now = deps.now ? deps.now() : new Date()
  try {
    const connection = await loadConnectionById(deps.db, row.company_id, row.connection_id)
    if (!connection) return { outcome: 'failed', row, error: 'COLLECTIONS_CONNECTION_NOT_FOUND' }
    const adapter = adapterForConnection(deps, connection)
    const snapshot = await adapter.caseAction(callContext(row.company_id, connection), {
      idempotencyKey: input.idempotencyKey,
      caseRef: row.provider_case_ref,
      action: 'pause',
      step: null,
      message: null,
      until: null,
    })
    const applied = await applyCaseSnapshot(deps.db, row, snapshot, { now })
    if (!applied.row.is_open) return { outcome: 'unavailable', row: applied.row }
    const { error } = await deps.db
      .from('collection_cases')
      .update({ paused_by_sweep: true, pause_reason: input.reason })
      .eq('id', row.id)
    if (error) throw new Error(`collection_cases update failed: ${error.message}`)
    return { outcome: 'paused', row: { ...applied.row, paused_by_sweep: true, pause_reason: input.reason } }
  } catch (err) {
    const code = isCollectionsError(err) ? err.code : err instanceof Error ? err.message.slice(0, 200) : 'unknown_error'
    log.warn('collection case not paused automatically', { caseId: row.id, reason: input.reason, code })
    return { outcome: 'failed', row, error: code }
  }
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

/** Open cases the provider holds: the only ones the sweep can pause. */
async function loadSweepCases(db: SupabaseClient, companyId: string | undefined): Promise<CollectionCaseRow[]> {
  const rows = await fetchAllRows<Record<string, unknown>>(({ from, to }) => {
    let query = db
      .from('collection_cases')
      .select('*')
      .eq('is_open', true)
      .eq('submission_status', 'registered')
    if (companyId) query = query.eq('company_id', companyId)
    return query.order('id', { ascending: true }).range(from, to)
  })
  return rows.map(normalizeCaseRow)
}

/** The given bank rows that are inbound and still unexplained by the books. */
async function loadGivenInboundRows(
  db: SupabaseClient,
  companyId: string,
  transactionIds: readonly string[],
): Promise<BankCandidateRow[]> {
  const rows: BankCandidateRow[] = []
  const ids = [...new Set(transactionIds)]
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const { data, error } = await db
      .from('open_bank_rows')
      .select('id, date, amount, description, original_description, merchant_name, reference, potential_invoice_id')
      .eq('company_id', companyId)
      .in('id', ids.slice(i, i + ID_CHUNK))
      .gt('amount', 0)
      .is('invoice_id', null)
      .is('supplier_invoice_id', null)
    if (error) throw new Error(`transactions lookup failed: ${error.message}`)
    rows.push(...((data ?? []) as BankCandidateRow[]))
  }
  if (rows.length === 0) return rows
  const allocated = await loadAllocatedTransactionIds(db, companyId, rows.map((r) => r.id))
  return rows.filter((r) => !allocated.has(r.id))
}

interface HitRow {
  id: string
  case_id: string
  transaction_id: string
  amount: number | string
  transaction_date: string
  reason: BankCandidateReason
  status: 'open' | 'booked' | 'dismissed' | 'closed'
  pause_state: 'pending' | 'paused' | 'already_paused' | 'unavailable' | 'failed'
  pause_attempts: number
  pause_error: string | null
  created_at: string
  updated_at: string
}

/**
 * Check inbound bank rows against the invoices under collection: the given
 * rows of one company (an ingest), or every unexplained row of every open
 * case (the nightly run). A failing case never stops the rest.
 */
export async function sweepCollectionPayments(deps: SweepDeps, options: SweepOptions = {}): Promise<SweepSummary> {
  const summary = emptySummary()
  const log = deps.log ?? defaultLog
  if (options.transactionIds && !options.companyId) throw new Error('A sweep of given bank rows names their company')
  if (options.transactionIds && options.transactionIds.length === 0) return summary

  const cases = await loadSweepCases(deps.db, options.companyId)
  if (cases.length === 0) return summary
  const given = options.transactionIds
    ? await loadGivenInboundRows(deps.db, options.companyId!, options.transactionIds)
    : null
  if (given && given.length === 0) return summary

  const clock = deps.clock ?? Date.now
  const started = clock()
  for (const row of cases) {
    if (deps.budgetMs !== undefined && clock() - started > deps.budgetMs) break
    summary.cases++
    try {
      await sweepCase(deps, row, given, summary, log)
    } catch (err) {
      summary.failed++
      log.warn('collection case sweep failed', { caseId: row.id, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return summary
}

async function sweepCase(
  deps: SweepDeps,
  row: CollectionCaseRow,
  given: BankCandidateRow[] | null,
  summary: SweepSummary,
  log: Logger,
): Promise<void> {
  const now = deps.now ? deps.now() : new Date()
  let ledger: Awaited<ReturnType<typeof loadLedgerRemaining>>
  try {
    ledger = await loadLedgerRemaining(deps.db, row.company_id, row.invoice_id)
  } catch (err) {
    if (err instanceof HandoverNotFoundError) return
    throw err
  }
  const { invoice, customerRow } = ledger
  const rows = given
    ? given.filter((r) => r.date >= invoice.invoice_date)
    : await loadUnexplainedInboundRows(deps.db, row.company_id, invoice, todayIsoStockholm(now))
  if (rows.length === 0) return

  const { data: known, error: knownError } = await deps.db
    .from('collection_sweep_hits')
    .select('transaction_id')
    .eq('case_id', row.id)
  if (knownError) throw new Error(`collection_sweep_hits lookup failed: ${knownError.message}`)
  const answered = [
    ...((known ?? []) as { transaction_id: string }[]).map((h) => h.transaction_id),
    // What the person said at the handover: "this bank row is not a payment of the invoice".
    ...(row.bank_check?.dismissed ?? []).map((d) => d.transaction_id),
  ]
  const matched = classifyBankCandidates(rows, {
    invoice,
    customerName: typeof customerRow?.name === 'string' ? customerRow.name : null,
    // A name match counts up to the larger of the two: what the customer may still pay either of us.
    remaining: roundOre(Math.max(ledger.ledgerRemaining, row.outstanding_principal ?? row.claim_amount)),
    dismissedTransactionIds: answered,
  }).filter((c) => !c.dismissed)
  if (matched.length === 0) return
  const allocated = given ? new Set<string>() : await loadAllocatedTransactionIds(deps.db, row.company_id, matched.map((c) => c.transactionId))
  const fresh = matched.filter((c) => !allocated.has(c.transactionId))
  if (fresh.length === 0) return

  // One object literal per hit, so the schema guard checks every column; the
  // conflict target drops a hit another sweep recorded first.
  for (const c of fresh) {
    const { error: insertError } = await deps.db.from('collection_sweep_hits').upsert(
      {
        company_id: row.company_id,
        case_id: row.id,
        transaction_id: c.transactionId,
        reason: c.reason,
        amount: roundOre(c.amount),
        transaction_date: c.date,
        status: 'open',
        pause_state: 'pending',
        pause_attempts: 0,
      },
      { onConflict: 'case_id,transaction_id', ignoreDuplicates: true },
    )
    if (insertError) throw new Error(`collection_sweep_hits insert failed: ${insertError.message}`)
  }
  // Another sweep may have recorded some of them first: act only on the ones still waiting for a pause.
  const { data: waiting, error: waitingError } = await deps.db
    .from('collection_sweep_hits')
    .select('id, case_id, transaction_id, amount, transaction_date, reason, status, pause_state, pause_attempts, pause_error, created_at, updated_at')
    .eq('case_id', row.id)
    .eq('status', 'open')
    .eq('pause_state', 'pending')
    .eq('pause_attempts', 0)
    .in('transaction_id', fresh.map((c) => c.transactionId))
  if (waitingError) throw new Error(`collection_sweep_hits lookup failed: ${waitingError.message}`)
  const hits = (waiting ?? []) as HitRow[]
  if (hits.length === 0) return
  summary.hits += hits.length
  log.info('possible payment of an invoice under collection', { caseId: row.id, hits: hits.length })
  const outcome = await pauseForHits(deps, row, hits, now)
  if (outcome === 'paused') summary.paused++
  else if (outcome === 'failed') summary.failed++
  else summary.notPaused++
}

/** Pause the case for its new hits (one call for all of them) and record what happened on each. */
async function pauseForHits(
  deps: SweepDeps,
  row: CollectionCaseRow,
  hits: readonly HitRow[],
  now: Date,
): Promise<AutomaticPauseOutcome> {
  const first = [...hits].sort((a, b) => (a.transaction_id < b.transaction_id ? -1 : 1))[0]!
  const result = await pauseCaseAutomatically(deps, row, {
    idempotencyKey: `${row.id}:sweep:${first.transaction_id}`,
    reason: 'possible_payment',
  })
  const failed = result.outcome === 'failed'
  const { error } = await deps.db
    .from('collection_sweep_hits')
    .update({
      pause_state: result.outcome,
      pause_attempts: 1,
      pause_error: failed ? (result.error ?? 'unknown_error').slice(0, 200) : null,
      paused_at: result.outcome === 'paused' ? now.toISOString() : null,
    })
    .in('id', hits.map((h) => h.id))
  if (error) throw new Error(`collection_sweep_hits update failed: ${error.message}`)
  await recordHitEvents(deps, result.row, hits.map((hit) => ({
    kind: 'possible_payment',
    label: result.outcome,
    occurredAt: now.toISOString(),
    direction: 'internal',
    amount: roundOre(Number(hit.amount)),
    providerEventRef: `sweep:${hit.id}`,
    raw: { transaction_id: hit.transaction_id, transaction_date: hit.transaction_date, reason: hit.reason },
  })))
  return result.outcome
}

async function recordHitEvents(deps: Pick<SweepDeps, 'db' | 'log'>, row: CollectionCaseRow, events: NewCaseEvent[]): Promise<void> {
  try {
    await appendCaseEvents(deps.db, row, events)
  } catch (err) {
    // The hit and the pause are recorded; the trail row is repeated by nothing, so log it.
    ;(deps.log ?? defaultLog).warn('collection sweep event not recorded', {
      caseId: row.id,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

// ---------------------------------------------------------------------------
// Every sync run: retry failed pauses, answer hits whose bank row was booked
// ---------------------------------------------------------------------------

export interface SweepUpkeepSummary {
  retried: number
  paused: number
  resolved: number
}

/**
 * Upkeep of the open hits, every sync run: a pause that failed (or never
 * finished) is tried again with the same key, and a hit whose bank row the
 * books now explain, or whose case closed, is answered.
 */
export async function sweepUpkeep(deps: SweepDeps, options: { companyId?: string } = {}): Promise<SweepUpkeepSummary> {
  const summary: SweepUpkeepSummary = { retried: 0, paused: 0, resolved: 0 }
  const now = deps.now ? deps.now() : new Date()
  let query = deps.db
    .from('collection_sweep_hits')
    .select('company_id, id, case_id, transaction_id, amount, transaction_date, reason, status, pause_state, pause_attempts, pause_error, created_at, updated_at')
    .eq('status', 'open')
    .order('created_at', { ascending: true })
    .limit(RESOLVE_BATCH)
  if (options.companyId) query = query.eq('company_id', options.companyId)
  const { data, error } = await query
  if (error) throw new Error(`collection_sweep_hits lookup failed: ${error.message}`)
  const open = (data ?? []) as Array<HitRow & { company_id: string }>
  if (open.length === 0) return summary

  // Hits whose bank row is booked, ignored, private or gone.
  const byCompany = new Map<string, string[]>()
  for (const hit of open) byCompany.set(hit.company_id, [...(byCompany.get(hit.company_id) ?? []), hit.transaction_id])
  const stillOpen = new Set<string>()
  for (const [companyId, ids] of byCompany) {
    for (const r of await loadGivenInboundRows(deps.db, companyId, ids)) stillOpen.add(r.id)
  }
  const booked = open.filter((h) => !stillOpen.has(h.transaction_id))
  if (booked.length > 0) {
    const { error: bookedError } = await deps.db
      .from('collection_sweep_hits')
      .update({ status: 'booked', resolved_at: now.toISOString() })
      .in('id', booked.map((h) => h.id))
      .eq('status', 'open')
    if (bookedError) throw new Error(`collection_sweep_hits update failed: ${bookedError.message}`)
    summary.resolved += booked.length
  }

  // Pauses to try again, one call per case: a call that failed or never
  // finished, and a case whose step offered no pause (it may offer one now).
  // A case that was already paused is the person's own pause: left alone.
  const retryBefore = now.getTime() - SWEEP_PAUSE_RETRY_AFTER_MS
  const due = open.filter(
    (h) =>
      stillOpen.has(h.transaction_id) &&
      (((h.pause_state === 'failed' || h.pause_state === 'pending') && h.pause_attempts < SWEEP_PAUSE_MAX_ATTEMPTS) ||
        h.pause_state === 'unavailable') &&
      Date.parse(h.updated_at) <= retryBefore,
  )
  const byCase = new Map<string, Array<HitRow & { company_id: string }>>()
  for (const hit of due) byCase.set(hit.case_id, [...(byCase.get(hit.case_id) ?? []), hit])
  for (const [caseId, hits] of byCase) {
    const row = await loadCaseById(deps.db, hits[0]!.company_id, caseId)
    if (!row || !row.is_open) continue
    const first = [...hits].sort((a, b) => (a.transaction_id < b.transaction_id ? -1 : 1))[0]!
    const result = await pauseCaseAutomatically(deps, row, {
      idempotencyKey: `${row.id}:sweep:${first.transaction_id}`,
      reason: 'possible_payment',
    })
    // Still no pause in this step: nothing was called, nothing changes.
    if (result.outcome === 'unavailable' && hits.every((h) => h.pause_state === 'unavailable')) continue
    summary.retried++
    const called = result.outcome === 'paused' || result.outcome === 'failed'
    for (const hit of hits) {
      const { error: updateError } = await deps.db
        .from('collection_sweep_hits')
        .update({
          pause_state: result.outcome,
          pause_attempts: hit.pause_attempts + (called ? 1 : 0),
          pause_error: result.outcome === 'failed' ? (result.error ?? 'unknown_error').slice(0, 200) : null,
          paused_at: result.outcome === 'paused' ? now.toISOString() : null,
        })
        .eq('id', hit.id)
      if (updateError) throw new Error(`collection_sweep_hits update failed: ${updateError.message}`)
    }
    if (result.outcome === 'paused') {
      summary.paused++
      await recordHitEvents(deps, result.row, hits.map((hit) => ({
        kind: 'possible_payment',
        label: 'paused',
        occurredAt: now.toISOString(),
        direction: 'internal',
        amount: roundOre(Number(hit.amount)),
        providerEventRef: `sweep:${hit.id}:paused`,
      })))
    }
  }

  // Hits on cases the provider closed meanwhile.
  const caseIds = [...new Set(open.filter((h) => stillOpen.has(h.transaction_id)).map((h) => h.case_id))]
  for (let i = 0; i < caseIds.length; i += ID_CHUNK) {
    const { data: closed, error: closedError } = await deps.db
      .from('collection_cases')
      .select('id')
      .in('id', caseIds.slice(i, i + ID_CHUNK))
      .eq('is_open', false)
    if (closedError) throw new Error(`collection_cases lookup failed: ${closedError.message}`)
    const closedIds = ((closed ?? []) as { id: string }[]).map((c) => c.id)
    if (closedIds.length === 0) continue
    const { data: updated, error: updateError } = await deps.db
      .from('collection_sweep_hits')
      .update({ status: 'closed', resolved_at: now.toISOString() })
      .in('case_id', closedIds)
      .eq('status', 'open')
      .select('id')
    if (updateError) throw new Error(`collection_sweep_hits update failed: ${updateError.message}`)
    summary.resolved += (updated ?? []).length
  }
  return summary
}

// ---------------------------------------------------------------------------
// What a person sees and does (the case card)
// ---------------------------------------------------------------------------

/** A bank row that may pay the invoice, still unanswered. */
export interface PossiblePaymentView {
  id: string
  transactionId: string
  date: string
  amount: number
  reason: BankCandidateReason
  /** What the sweep did at the provider. */
  pauseState: HitRow['pause_state']
}

/** The open hits of a case whose bank row is still unexplained, oldest first. */
export async function loadPossiblePayments(
  db: Pick<SupabaseClient, 'from'>,
  companyId: string,
  caseId: string,
): Promise<PossiblePaymentView[]> {
  const { data, error } = await db
    .from('collection_sweep_hits')
    .select('id, case_id, transaction_id, amount, transaction_date, reason, status, pause_state, pause_attempts, pause_error, created_at, updated_at')
    .eq('company_id', companyId)
    .eq('case_id', caseId)
    .eq('status', 'open')
    .order('transaction_date', { ascending: true })
    .limit(50)
  if (error) throw new Error(`collection_sweep_hits lookup failed: ${error.message}`)
  const hits = (data ?? []) as HitRow[]
  if (hits.length === 0) return []
  // A row booked since the last upkeep is answered already: do not ask about it.
  const { data: rows, error: rowsError } = await db
    .from('open_bank_rows')
    .select('id')
    .eq('company_id', companyId)
    .in('id', hits.map((h) => h.transaction_id))
    .is('invoice_id', null)
    .is('supplier_invoice_id', null)
  if (rowsError) throw new Error(`transactions lookup failed: ${rowsError.message}`)
  const unexplained = new Set(((rows ?? []) as { id: string }[]).map((r) => r.id))
  return hits
    .filter((h) => unexplained.has(h.transaction_id))
    .map((h) => ({
      id: h.id,
      transactionId: h.transaction_id,
      date: h.transaction_date,
      amount: roundOre(Number(h.amount)),
      reason: h.reason,
      pauseState: h.pause_state,
    }))
}

export type PossiblePaymentOutcome =
  | { ok: true }
  | { ok: false; code: 'COLLECTION_POSSIBLE_PAYMENT_NOT_FOUND' | 'COLLECTION_POSSIBLE_PAYMENT_NOT_ACTIONABLE' }

/**
 * A person's answer to a possible payment: the bank row pays something else.
 * The hit leaves Att göra; the case stays paused until the person resumes it
 * (the card offers Återuppta). Obligation work: it runs whatever the start
 * gates say.
 */
export async function dismissPossiblePayment(
  db: Pick<SupabaseClient, 'from'>,
  input: { companyId: string; invoiceId: string; hitId: string; userId: string; now?: Date },
): Promise<PossiblePaymentOutcome> {
  const now = input.now ?? new Date()
  const { data, error } = await db
    .from('collection_sweep_hits')
    .select('id, case_id, transaction_id, amount, transaction_date, reason, status, pause_state, pause_attempts, pause_error, created_at, updated_at')
    .eq('company_id', input.companyId)
    .eq('id', input.hitId)
    .maybeSingle()
  if (error) throw new Error(`collection_sweep_hits lookup failed: ${error.message}`)
  if (!data) return { ok: false, code: 'COLLECTION_POSSIBLE_PAYMENT_NOT_FOUND' }
  const hit = data as unknown as HitRow
  const row = await loadCaseById(db, input.companyId, hit.case_id)
  if (!row || row.invoice_id !== input.invoiceId) return { ok: false, code: 'COLLECTION_POSSIBLE_PAYMENT_NOT_FOUND' }
  const { data: updated, error: updateError } = await db
    .from('collection_sweep_hits')
    .update({ status: 'dismissed', resolved_at: now.toISOString(), resolved_by: input.userId })
    .eq('id', hit.id)
    .eq('status', 'open')
    .select('id')
  if (updateError) throw new Error(`collection_sweep_hits update failed: ${updateError.message}`)
  if (!Array.isArray(updated) || updated.length !== 1) return { ok: false, code: 'COLLECTION_POSSIBLE_PAYMENT_NOT_ACTIONABLE' }
  await recordHitEvents({ db: db as SupabaseClient }, row, [
    {
      kind: 'possible_payment',
      label: 'dismissed',
      occurredAt: now.toISOString(),
      direction: 'internal',
      amount: roundOre(Number(hit.amount)),
      actorUserId: input.userId,
      providerEventRef: `sweep:${hit.id}:dismissed`,
    },
  ])
  return { ok: true }
}
