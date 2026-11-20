import type { SupabaseClient } from '@supabase/supabase-js'
import type { CollectionsPaymentReceipt } from '@accounted/connect-contract'
import { CONNECTOR_PROTOCOL_ERROR_CODE } from '@/lib/connect/instance/connector-fetch'
import { createLogger, type Logger } from '@/lib/logger'
import { roundOre } from '@/lib/money'
import { appendCaseEvents, loadCaseById, type CollectionCaseRow, type NewCaseEvent } from './case'
import { COLLECTIONS_UNAVAILABLE, isCollectionsError } from './errors'
import type { CollectionsAdapter, CollectionsRoute } from './port'
import { adapterForConnection, callContext, loadConnectionById } from './service-deps'

const defaultLog = createLogger('collections/forwarding')

/**
 * Reporting payments and credit notes to the collections provider (build
 * spec 2.2, collection_payment_forwards).
 *
 * Triggers fill the outbox from every write path (migration
 * 20261012030400_collection_payment_forwards.sql); this drain sends it. It
 * runs from the sync cron every ten minutes and right after a payment route
 * answers (forward-hook.ts), whatever the start gates say: telling the
 * provider that the customer paid is a duty toward an open case, never new
 * work.
 *
 * Each row is claimed under a lease (claim_collection_forwards: at most one
 * row per case per claim, a revert first, then in order), sent once with the
 * row's id as the idempotency key and the invoice_payments row id as the
 * payment's reference at the provider, and finished with the lease token
 * (finish_collection_forward). A report is capped at the provider's remaining
 * principal (its direct-payment call covers principal only); the part above
 * it, and any part the provider still ignores, is recorded on the row, where
 * it raises an Att göra row (collection_attention_case_ids, payment_excess).
 */

/** Attempts before a row is given up on and handed to a person (Att göra, forward_failed). */
export const FORWARD_MAX_ATTEMPTS = 8
/** Rest after the 1st, 2nd, ... failed attempt: 1, 5, 30 minutes, 2 hours, then 12 hours. */
export const FORWARD_BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 12 * 3_600_000] as const
/** Longer than one Connect call (30 s) with room to finish the row. */
export const FORWARD_LEASE_SECONDS = 120
export const FORWARD_CLAIM_LIMIT = 50
/** One row per case per claim, so a case with several rows needs several rounds. */
export const FORWARD_MAX_ROUNDS = 10

/**
 * How long a case closed as paid still takes reports and reverts: the same
 * reach as collection_forward_case_for_invoice and
 * reconcile_collection_forwards (migrations 20261012030400, 20261012030500).
 */
export const CLOSED_PAID_REACH_MS = 90 * 24 * 3_600_000

/** Whether a case closed as paid at `closedAt` is still within that reach. Pure. */
export function withinClosedPaidReach(closedAt: string | null, now: Date): boolean {
  if (!closedAt) return false
  const at = Date.parse(closedAt)
  return Number.isFinite(at) && at > now.getTime() - CLOSED_PAID_REACH_MS
}

/** How long a row rests after its n-th failed attempt (n >= 1). */
export function forwardBackoffMs(attempts: number): number {
  const index = Math.min(Math.max(attempts, 1), FORWARD_BACKOFF_MS.length) - 1
  return FORWARD_BACKOFF_MS[index]!
}

/** A row as claim_collection_forwards hands it out. */
export interface ClaimedForward {
  id: string
  company_id: string
  case_id: string
  kind: 'payment' | 'credit_note'
  invoice_payment_id: string | null
  credit_invoice_id: string | null
  amount: number
  payment_date: string
  status: 'pending' | 'revert_pending'
  attempts: number
  request_amount: number | null
  sent_amount: number | null
  lease_token: string
}

export interface ForwardDrainDeps {
  /** Service-role client. */
  db: SupabaseClient
  now?: () => Date
  adapterFor?: (connection: { route: CollectionsRoute }) => CollectionsAdapter | null
  log?: Logger
  /** Wall-clock milliseconds for the budget (default Date.now). */
  clock?: () => number
  /** Stop claiming new rows after this long (default: no budget). */
  budgetMs?: number
}

export interface ForwardDrainOptions {
  /** Only this company's rows (the after-hook of a payment route). */
  companyId?: string
  limit?: number
  maxRounds?: number
}

export interface ForwardDrainSummary {
  claimed: number
  reported: number
  reverted: number
  skipped: number
  retried: number
  failed: number
  /** Rows whose lease ran out before they were finished: another drain holds them. */
  leaseLost: number
}

type Outcome = keyof Omit<ForwardDrainSummary, 'claimed'>

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

function normalizeClaimed(raw: Record<string, unknown>): ClaimedForward {
  return {
    ...(raw as unknown as ClaimedForward),
    amount: toNumber(raw.amount) ?? 0,
    attempts: toNumber(raw.attempts) ?? 0,
    request_amount: toNumber(raw.request_amount),
    sent_amount: toNumber(raw.sent_amount),
  }
}

export async function drainCollectionForwards(
  deps: ForwardDrainDeps,
  options: ForwardDrainOptions = {},
): Promise<ForwardDrainSummary> {
  const summary: ForwardDrainSummary = { claimed: 0, reported: 0, reverted: 0, skipped: 0, retried: 0, failed: 0, leaseLost: 0 }
  const clock = deps.clock ?? Date.now
  const started = clock()
  const limit = options.limit ?? FORWARD_CLAIM_LIMIT
  const maxRounds = options.maxRounds ?? FORWARD_MAX_ROUNDS
  const log = deps.log ?? defaultLog

  for (let round = 0; round < maxRounds; round++) {
    if (deps.budgetMs !== undefined && clock() - started > deps.budgetMs) break
    const { data, error } = await deps.db.rpc('claim_collection_forwards', {
      p_limit: limit,
      p_lease_seconds: FORWARD_LEASE_SECONDS,
      p_company_id: options.companyId ?? null,
    })
    if (error) throw new Error(`claim_collection_forwards failed: ${error.message}`)
    const rows = ((data ?? []) as Record<string, unknown>[]).map(normalizeClaimed)
    if (rows.length === 0) break
    summary.claimed += rows.length
    for (const row of rows) {
      let outcome: Outcome
      try {
        outcome = await processForward(deps, row, log)
      } catch (err) {
        // A failure of our own (a lookup, the finish call): leave the lease to
        // run out, so the row is claimed again later.
        log.error('collection forward failed unexpectedly', err as Error, { forwardId: row.id, caseId: row.case_id })
        outcome = 'retried'
      }
      summary[outcome] += 1
    }
  }
  return summary
}

interface FinishInput {
  result: 'reported' | 'reverted' | 'retry' | 'failed' | 'skipped'
  providerRef?: string | null
  sentAmount?: number | null
  ignoredAmount?: number | null
  error?: string | null
  retryAt?: Date | null
}

/** Finish a claimed row; answers its new status, or 'lease_lost'. */
async function finishForward(db: SupabaseClient, row: ClaimedForward, input: FinishInput): Promise<string> {
  const { data, error } = await db.rpc('finish_collection_forward', {
    p_forward_id: row.id,
    p_lease_token: row.lease_token,
    p_result: input.result,
    p_provider_ref: input.providerRef ?? null,
    p_sent_amount: input.sentAmount ?? null,
    p_ignored_amount: input.ignoredAmount ?? null,
    p_error: input.error ?? null,
    p_retry_at: input.retryAt ? input.retryAt.toISOString() : null,
  })
  if (error) throw new Error(`finish_collection_forward failed: ${error.message}`)
  return String(data)
}

/** Codes after which the provider may hold the request although the call failed: never given up on early. */
const AMBIGUOUS_CODES: ReadonlySet<string> = new Set([CONNECTOR_PROTOCOL_ERROR_CODE, 'CONNECTOR_IDEMPOTENCY_IN_FLIGHT'])

/** Whether a failed call is tried again (true) or handed to a person at once (false). */
export function forwardErrorIsRetryable(err: unknown): boolean {
  if (!isCollectionsError(err)) return true
  return err.retryable || err.code === COLLECTIONS_UNAVAILABLE || AMBIGUOUS_CODES.has(err.code)
}

function errorCode(err: unknown): string {
  if (isCollectionsError(err)) return err.code
  return err instanceof Error ? err.message.slice(0, 200) : 'unknown_error'
}

async function failedAttempt(
  deps: ForwardDrainDeps,
  row: ClaimedForward,
  err: unknown,
  log: Logger,
): Promise<Outcome> {
  const now = deps.now ? deps.now() : new Date()
  const code = errorCode(err)
  const giveUp = row.attempts >= FORWARD_MAX_ATTEMPTS || !forwardErrorIsRetryable(err)
  log.warn('collection forward attempt failed', { forwardId: row.id, caseId: row.case_id, attempts: row.attempts, code, giveUp })
  const status = await finishForward(deps.db, row, giveUp
    ? { result: 'failed', error: code }
    : { result: 'retry', error: code, retryAt: new Date(now.getTime() + forwardBackoffMs(row.attempts)) })
  if (status === 'lease_lost') return 'leaseLost'
  return status === 'failed' ? 'failed' : 'retried'
}

/** Fix the request amount for this row's key before the first call goes out. */
async function fixRequestAmount(db: SupabaseClient, row: ClaimedForward, amount: number): Promise<boolean> {
  const { data, error } = await db
    .from('collection_payment_forwards')
    .update({ request_amount: amount })
    .eq('id', row.id)
    .eq('lease_token', row.lease_token)
    .is('request_amount', null)
    .select('id')
  if (error) throw new Error(`collection_payment_forwards update failed: ${error.message}`)
  return Array.isArray(data) && data.length === 1
}

/**
 * The provider's remaining principal as the books last heard it, moved by
 * what this drain reported since. The next case read overwrites it with the
 * provider's own figure.
 */
async function moveRemainingPrincipal(db: SupabaseClient, caseRow: CollectionCaseRow, delta: number): Promise<void> {
  if (caseRow.outstanding_principal === null || delta === 0) return
  const next = roundOre(Math.max(0, caseRow.outstanding_principal + delta))
  const { error } = await db.from('collection_cases').update({ outstanding_principal: next }).eq('id', caseRow.id)
  if (error) defaultLog.warn('collection case remaining principal not updated', { caseId: caseRow.id, error: error.message })
}

async function recordEvents(db: SupabaseClient, caseRow: CollectionCaseRow, events: NewCaseEvent[], log: Logger): Promise<void> {
  try {
    await appendCaseEvents(db, caseRow, events)
  } catch (err) {
    // The row is finished; its timeline entry is a convenience the next
    // attempt does not repeat (the refs make a re-run idempotent anyway).
    log.warn('collection forward event not recorded', { caseId: caseRow.id, error: err instanceof Error ? err.message : String(err) })
  }
}

/**
 * The amount a report may carry: capped at the provider's remaining
 * principal when the books know it. The rest is what the provider would
 * ignore anyway.
 */
export function cappedForwardAmount(amount: number, remainingPrincipal: number | null): number {
  const whole = roundOre(amount)
  if (remainingPrincipal === null) return whole
  return roundOre(Math.max(0, Math.min(whole, roundOre(remainingPrincipal))))
}

async function processForward(deps: ForwardDrainDeps, row: ClaimedForward, log: Logger): Promise<Outcome> {
  const now = deps.now ? deps.now() : new Date()
  const caseRow = await loadCaseById(deps.db, row.company_id, row.case_id)
  if (!caseRow || !caseRow.provider_case_ref) {
    const status = await finishForward(deps.db, row, { result: 'skipped', error: 'case_missing' })
    return status === 'lease_lost' ? 'leaseLost' : 'skipped'
  }
  // A case the provider closed for any reason but payment holds nothing more
  // to collect: nothing to report or drop. A case closed as paid still takes
  // a revert (an unmatched payment reopens the claim) and what follows it,
  // for as long as a new payment row on the invoice is still reported to it
  // (collection_forward_case_for_invoice: 90 days). Past that, a revert
  // would reopen the claim while the rematched payment never follows it, and
  // the customer would be dunned for an invoice that is paid.
  if (!caseRow.is_open && (caseRow.close_reason !== 'paid' || !withinClosedPaidReach(caseRow.closed_at, now))) {
    const status = await finishForward(deps.db, row, { result: 'skipped', error: 'case_closed' })
    return status === 'lease_lost' ? 'leaseLost' : 'skipped'
  }

  const connection = await loadConnectionById(deps.db, caseRow.company_id, caseRow.connection_id)
  if (!connection) return failedAttempt(deps, row, new Error('collection connection missing'), log)

  let adapter: CollectionsAdapter
  try {
    adapter = adapterForConnection(deps, connection)
  } catch (err) {
    return failedAttempt(deps, row, err, log)
  }
  const ctx = callContext(caseRow.company_id, connection)
  const caseRef = caseRow.provider_case_ref

  if (row.status === 'revert_pending') {
    const amount = roundOre(row.sent_amount ?? row.amount)
    if (amount > 0) {
      try {
        await adapter.revertPayment(ctx, {
          idempotencyKey: `${row.id}:revert`,
          caseRef,
          paymentRef: row.invoice_payment_id!,
          date: row.payment_date,
          amount,
          description: null,
        })
      } catch (err) {
        return failedAttempt(deps, row, err, log)
      }
    }
    const status = await finishForward(deps.db, row, { result: 'reverted' })
    if (status === 'lease_lost') return 'leaseLost'
    await moveRemainingPrincipal(deps.db, caseRow, amount)
    await recordEvents(deps.db, caseRow, [
      {
        kind: 'payment_reverted',
        label: 'reverted',
        occurredAt: now.toISOString(),
        direction: 'internal',
        amount,
        providerEventRef: `forward:${row.id}:reverted`,
      },
    ], log)
    return 'reverted'
  }

  // A report. The amount is fixed at the first attempt so every retry sends
  // the same body under the same key.
  let requestAmount = row.request_amount
  if (requestAmount === null) {
    const capped = cappedForwardAmount(row.amount, caseRow.outstanding_principal)
    if (capped <= 0) {
      const status = await finishForward(deps.db, row, {
        result: 'skipped',
        ignoredAmount: roundOre(row.amount),
        error: 'above_remaining_principal',
      })
      if (status === 'lease_lost') return 'leaseLost'
      await recordEvents(deps.db, caseRow, [excessEvent(row, roundOre(row.amount), now)], log)
      return 'skipped'
    }
    if (!(await fixRequestAmount(deps.db, row, capped))) {
      // The lease ran out between the claim and here.
      return 'leaseLost'
    }
    requestAmount = capped
  }

  let receipt: CollectionsPaymentReceipt
  try {
    receipt =
      row.kind === 'payment'
        ? await adapter.registerPayment(ctx, {
            idempotencyKey: row.id,
            caseRef,
            paymentRef: row.invoice_payment_id!,
            date: row.payment_date,
            amount: requestAmount,
            description: null,
          })
        : await adapter.registerCreditNote(ctx, {
            idempotencyKey: row.id,
            caseRef,
            creditRef: row.credit_invoice_id!,
            date: row.payment_date,
            amount: requestAmount,
          })
  } catch (err) {
    return failedAttempt(deps, row, err, log)
  }
  if (!receipt.accepted) {
    return failedAttempt(deps, row, new Error('provider_not_accepted'), log)
  }

  const providerIgnored = roundOre(Math.min(requestAmount, Math.max(0, receipt.ignoredAmount)))
  const sent = roundOre(requestAmount - providerIgnored)
  const ignored = roundOre(roundOre(row.amount) - sent)
  const status = await finishForward(deps.db, row, {
    result: 'reported',
    providerRef: receipt.providerRef,
    sentAmount: sent,
    ignoredAmount: ignored,
  })
  if (status === 'lease_lost') return 'leaseLost'
  await moveRemainingPrincipal(deps.db, caseRow, -sent)
  const events: NewCaseEvent[] = []
  if (sent > 0) {
    events.push({
      kind: row.kind === 'payment' ? 'payment_forwarded' : 'credit_forwarded',
      label: row.kind === 'payment' ? 'reported' : 'credit',
      occurredAt: now.toISOString(),
      direction: 'internal',
      amount: sent,
      providerEventRef: `forward:${row.id}:reported`,
    })
  }
  if (ignored > 0) events.push(excessEvent(row, ignored, now))
  await recordEvents(deps.db, caseRow, events, log)
  return 'reported'
}

function excessEvent(row: ClaimedForward, amount: number, now: Date): NewCaseEvent {
  return {
    kind: row.kind === 'payment' ? 'payment_forwarded' : 'credit_forwarded',
    label: 'excess',
    occurredAt: now.toISOString(),
    direction: 'internal',
    amount,
    providerEventRef: `forward:${row.id}:excess`,
  }
}

/**
 * Write the payments and credit notes the handover request already reported
 * (priorPayments, priorCredits) as forwarded, before the registration is
 * stored (seed_collection_forwards).
 */
export async function seedForwardsAtRegistration(
  db: Pick<SupabaseClient, 'rpc'>,
  caseId: string,
  request: {
    priorPayments: ReadonlyArray<{ paymentRef: string; date: string; amount: number }>
    priorCredits: ReadonlyArray<{ creditRef: string; date: string; amount: number }>
  },
): Promise<void> {
  if (request.priorPayments.length === 0 && request.priorCredits.length === 0) return
  const { error } = await db.rpc('seed_collection_forwards', {
    p_case_id: caseId,
    p_payments: request.priorPayments,
    p_credits: request.priorCredits,
  })
  if (error) throw new Error(`seed_collection_forwards failed: ${error.message}`)
}

// ---------------------------------------------------------------------------
// What a person sees and does about a forward (the case card, Att göra)
// ---------------------------------------------------------------------------

interface ForwardRow {
  id: string
  case_id: string
  kind: 'payment' | 'credit_note'
  amount: number | string
  payment_date: string
  status: string
  attempts: number
  last_error: string | null
  ignored_amount: number | string | null
  forwarded_at: string | null
  attention_resolved_at: string | null
}

/** A forward a person should know about. */
export interface ForwardIssueView {
  id: string
  kind: 'payment' | 'credit_note'
  /**
   * failed:   the drain gave up (Att göra until retried or marked handled).
   * excess:   part of it is above what the provider still claims, so the
   *           customer may have paid twice (Att göra until marked handled).
   * retrying: the last attempt failed and the next one is scheduled.
   */
  issue: 'failed' | 'excess' | 'retrying'
  /** Whether the report or its revert (the payment was removed) is the one that failed. */
  operation: 'report' | 'revert'
  amount: number
  ignoredAmount: number | null
  paymentDate: string
  lastError: string | null
}

export function forwardIssueOf(row: ForwardRow): ForwardIssueView | null {
  const ignored = toNumber(row.ignored_amount)
  const operation: ForwardIssueView['operation'] =
    row.status === 'revert_pending' || (row.status === 'failed' && row.forwarded_at !== null) ? 'revert' : 'report'
  let issue: ForwardIssueView['issue'] | null = null
  if (row.attention_resolved_at === null && row.status === 'failed') issue = 'failed'
  else if (row.attention_resolved_at === null && (row.status === 'forwarded' || row.status === 'skipped') && (ignored ?? 0) > 0) issue = 'excess'
  else if ((row.status === 'pending' || row.status === 'revert_pending') && row.last_error !== null && row.attempts > 0) issue = 'retrying'
  if (!issue) return null
  return {
    id: row.id,
    kind: row.kind,
    issue,
    operation,
    amount: toNumber(row.amount) ?? 0,
    ignoredAmount: ignored,
    paymentDate: row.payment_date,
    lastError: row.last_error,
  }
}

/** The forwards of every case the invoice had that a person should know about, newest first. */
export async function loadForwardIssues(
  db: Pick<SupabaseClient, 'from'>,
  companyId: string,
  invoiceId: string,
): Promise<ForwardIssueView[]> {
  const { data: cases, error: casesError } = await db
    .from('collection_cases')
    .select('id')
    .eq('company_id', companyId)
    .eq('invoice_id', invoiceId)
  if (casesError) throw new Error(`collection_cases lookup failed: ${casesError.message}`)
  const caseIds = ((cases ?? []) as { id: string }[]).map((c) => c.id)
  if (caseIds.length === 0) return []
  const { data, error } = await db
    .from('collection_payment_forwards')
    .select('id, case_id, kind, amount, payment_date, status, attempts, last_error, ignored_amount, forwarded_at, attention_resolved_at')
    .eq('company_id', companyId)
    .in('case_id', caseIds)
    .order('created_at', { ascending: false })
    .limit(200)
  if (error) throw new Error(`collection_payment_forwards lookup failed: ${error.message}`)
  return ((data ?? []) as ForwardRow[]).map(forwardIssueOf).filter((v): v is ForwardIssueView => v !== null)
}

/** Where a case's reports stand for the card and its refresh. */
export interface CaseForwardState {
  /** A report or revert due now has not reached the provider yet (the drain runs after the request). */
  inFlight: boolean
  /** A report or revert reached the provider after the stored snapshot: the snapshot's amounts are out of date. */
  reportedSince: boolean
}

export const NO_CASE_FORWARDS: CaseForwardState = { inFlight: false, reportedSince: false }

export function caseForwardState(
  rows: ReadonlyArray<{ status: string; next_attempt_at: string | null; forwarded_at: string | null; reverted_at: string | null }>,
  snapshotAt: string | null,
  now: Date,
): CaseForwardState {
  const since = snapshotAt === null ? null : Date.parse(snapshotAt)
  const after = (at: string | null) => at !== null && (since === null || Date.parse(at) > since)
  return {
    inFlight: rows.some(
      (r) => (r.status === 'pending' || r.status === 'revert_pending') && (r.next_attempt_at === null || Date.parse(r.next_attempt_at) <= now.getTime()),
    ),
    reportedSince: rows.some((r) => (r.status === 'forwarded' && after(r.forwarded_at)) || (r.status === 'reverted' && after(r.reverted_at))),
  }
}

export async function loadCaseForwardState(
  db: Pick<SupabaseClient, 'from'>,
  companyId: string,
  caseId: string,
  snapshotAt: string | null,
  now: Date,
): Promise<CaseForwardState> {
  const { data, error } = await db
    .from('collection_payment_forwards')
    .select('status, next_attempt_at, forwarded_at, reverted_at')
    .eq('company_id', companyId)
    .eq('case_id', caseId)
  if (error) throw new Error(`collection_payment_forwards lookup failed: ${error.message}`)
  return caseForwardState(
    (data ?? []) as Array<{ status: string; next_attempt_at: string | null; forwarded_at: string | null; reverted_at: string | null }>,
    snapshotAt,
    now,
  )
}

export type ForwardIssueAction = 'retry' | 'resolve'

export type ForwardIssueOutcome = { ok: true } | { ok: false; code: 'COLLECTION_FORWARD_NOT_FOUND' | 'COLLECTION_FORWARD_NOT_ACTIONABLE' }

/**
 * A person's answer to a forward issue: try a failed report or revert again
 * (it goes back in the outbox with a fresh attempt count), or mark a failed
 * or partly ignored one as handled (it leaves Att göra). Obligation work: it
 * runs whatever the start gates say.
 */
export async function actOnForwardIssue(
  db: Pick<SupabaseClient, 'from'>,
  input: { companyId: string; invoiceId: string; forwardId: string; action: ForwardIssueAction; userId: string; now?: Date },
): Promise<ForwardIssueOutcome> {
  const { data, error } = await db
    .from('collection_payment_forwards')
    .select('id, case_id, kind, amount, payment_date, status, attempts, last_error, ignored_amount, forwarded_at, attention_resolved_at')
    .eq('company_id', input.companyId)
    .eq('id', input.forwardId)
    .maybeSingle()
  if (error) throw new Error(`collection_payment_forwards lookup failed: ${error.message}`)
  if (!data) return { ok: false, code: 'COLLECTION_FORWARD_NOT_FOUND' }
  const row = data as unknown as ForwardRow
  // The forward must be one of this invoice's cases (the route names the invoice).
  const { data: owner, error: ownerError } = await db
    .from('collection_cases')
    .select('id')
    .eq('company_id', input.companyId)
    .eq('id', row.case_id)
    .eq('invoice_id', input.invoiceId)
    .maybeSingle()
  if (ownerError) throw new Error(`collection_cases lookup failed: ${ownerError.message}`)
  if (!owner) return { ok: false, code: 'COLLECTION_FORWARD_NOT_FOUND' }
  const issue = forwardIssueOf(row)

  if (input.action === 'retry') {
    if (issue?.issue !== 'failed') return { ok: false, code: 'COLLECTION_FORWARD_NOT_ACTIONABLE' }
    const { data: updated, error: updateError } = await db
      .from('collection_payment_forwards')
      .update({
        status: row.forwarded_at === null ? 'pending' : 'revert_pending',
        attempts: 0,
        next_attempt_at: null,
        last_error: null,
      })
      .eq('id', row.id)
      .eq('status', 'failed')
      .select('id')
    if (updateError) throw new Error(`collection_payment_forwards update failed: ${updateError.message}`)
    return Array.isArray(updated) && updated.length === 1 ? { ok: true } : { ok: false, code: 'COLLECTION_FORWARD_NOT_ACTIONABLE' }
  }

  if (issue?.issue !== 'failed' && issue?.issue !== 'excess') return { ok: false, code: 'COLLECTION_FORWARD_NOT_ACTIONABLE' }
  const { data: updated, error: updateError } = await db
    .from('collection_payment_forwards')
    .update({ attention_resolved_at: (input.now ?? new Date()).toISOString(), attention_resolved_by: input.userId })
    .eq('id', row.id)
    .is('attention_resolved_at', null)
    .select('id')
  if (updateError) throw new Error(`collection_payment_forwards update failed: ${updateError.message}`)
  return Array.isArray(updated) && updated.length === 1 ? { ok: true } : { ok: false, code: 'COLLECTION_FORWARD_NOT_ACTIONABLE' }
}
