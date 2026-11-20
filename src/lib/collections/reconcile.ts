import type { SupabaseClient } from '@supabase/supabase-js'
import type { CollectionsCase } from '@accounted/connect-contract'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { createLogger, type Logger } from '@/lib/logger'
import { roundOre } from '@/lib/money'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { pauseCaseAutomatically } from './bank-sweep'
import {
  RECONCILE_EVENT_PREFIX,
  appendCaseEvents,
  applyCaseSnapshot,
  normalizeCaseRow,
  recordCaseSyncError,
  type CollectionCaseRow,
} from './case'
import { loadLedgerRemaining } from './case-actions'
import { isCollectionsError } from './errors'
import type { CollectionsAdapter, CollectionsRoute } from './port'
import { HandoverNotFoundError } from './readiness'
import { adapterForConnection, callContext, loadConnectionById } from './service-deps'

const defaultLog = createLogger('collections/reconcile')

/**
 * The reconcile of cases under collection (build spec 2.2 and 3.5): the
 * guarantee behind the forwarding triggers and the drain.
 *
 * Every sync run, reconcile_collection_forwards (SQL) makes sure every
 * payment and credit note on a case invoice has its forward row and that a
 * removed payment is reverted, before the drain sends them.
 *
 * Once a day (and every run for a case already flagged), each open case is
 * read from the provider and compared with the books:
 *
 *   - A payment the drain reported that the provider does not list as
 *     received within a day is sent once more, under the same key and with
 *     the same body (Connect answers a repeat with the first result).
 *   - The provider's remaining principal must equal what the books expect:
 *     the customer's share still owed, plus reports not sent yet, less
 *     removed payments the provider still holds and payments the provider
 *     collected itself that are not booked yet. A difference raises an Att
 *     göra row ("Beloppet hos {provider} stämmer inte med fakturan") until
 *     the two agree. A provider that claims MORE than the books (a write-off
 *     or an adjustment with no payment row, which nothing reports) also has
 *     the case paused: it would dun the customer for money that is not owed.
 *     One that claims less is only flagged: the customer is not harmed.
 *
 * Obligation work: it runs whatever the start gates say.
 */

/** A payment report not listed by the provider this long after it was sent is sent once more. */
export const UNACKNOWLEDGED_RESEND_MS = 24 * 3_600_000
/** A forward finished this recently may not show in the snapshot yet: the comparison waits for the next run. */
export const FORWARD_SETTLE_MS = 2 * 60_000

export interface ReconcileDeps {
  /** Service-role client. */
  db: SupabaseClient
  now?: () => Date
  adapterFor?: (connection: { route: CollectionsRoute }) => CollectionsAdapter | null
  log?: Logger
  clock?: () => number
  budgetMs?: number
}

export interface ForwardReconcileSummary {
  createdPayments: number
  createdCredits: number
  reverted: number
  skipped: number
}

/** The forward rows the triggers should have written, written now (reconcile_collection_forwards). */
export async function reconcileForwardRows(
  db: Pick<SupabaseClient, 'rpc'>,
  options: { companyId?: string } = {},
): Promise<ForwardReconcileSummary> {
  const { data, error } = await db.rpc('reconcile_collection_forwards', { p_company_id: options.companyId ?? null })
  if (error) throw new Error(`reconcile_collection_forwards failed: ${error.message}`)
  const counts = (data ?? {}) as Record<string, unknown>
  return {
    createdPayments: Number(counts.created_payments ?? 0),
    createdCredits: Number(counts.created_credits ?? 0),
    reverted: Number(counts.reverted ?? 0),
    skipped: Number(counts.skipped ?? 0),
  }
}

export interface CaseReconcileSummary {
  checked: number
  mismatched: number
  paused: number
  resent: number
  failed: number
  /** False when the budget ran out before every case was checked. */
  complete: boolean
}

interface ForwardStateRow {
  id: string
  kind: 'payment' | 'credit_note'
  invoice_payment_id: string | null
  amount: number | string
  payment_date: string
  status: string
  request_amount: number | string | null
  sent_amount: number | string | null
  forwarded_at: string | null
  acknowledged_at: string | null
  resent_at: string | null
  lease_until: string | null
  updated_at: string
}

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v))

/**
 * What the books expect the provider's remaining principal to be. Pure.
 *
 *   ledgerRemaining   the customer's share still owed by the books
 *   + unsent          payments and credit notes recorded but not reported yet
 *   - heldRemoved     removed payments the provider still counts (revert not done)
 *   - collected       capital the provider collected itself, not booked yet
 */
export function expectedProviderPrincipal(input: {
  ledgerRemaining: number
  forwards: ReadonlyArray<Pick<ForwardStateRow, 'status' | 'amount' | 'request_amount' | 'sent_amount' | 'forwarded_at'>>
  collectedUnbooked: number
}): number {
  let unsent = 0
  let heldRemoved = 0
  for (const f of input.forwards) {
    if (f.status === 'pending' || (f.status === 'failed' && f.forwarded_at === null)) {
      unsent += f.request_amount !== null && f.request_amount !== undefined ? num(f.request_amount) : num(f.amount)
    } else if (f.status === 'revert_pending' || (f.status === 'failed' && f.forwarded_at !== null)) {
      heldRemoved += f.sent_amount !== null && f.sent_amount !== undefined ? num(f.sent_amount) : num(f.amount)
    }
  }
  return roundOre(Math.max(0, input.ledgerRemaining + unsent - heldRemoved - input.collectedUnbooked))
}

/** The provider's collected capital the books have not booked yet (no collections payment row carries its ref). */
async function collectedUnbooked(
  db: SupabaseClient,
  row: CollectionCaseRow,
  snapshot: Pick<CollectionsCase, 'collectedPayments'>,
): Promise<number> {
  const collected = snapshot.collectedPayments.filter((p) => roundOre(p.capitalPaid) > 0)
  if (collected.length === 0) return 0
  const { data, error } = await db
    .from('invoice_payments')
    .select('external_ref')
    .eq('company_id', row.company_id)
    .eq('invoice_id', row.invoice_id)
    .eq('source', 'collections')
  if (error) throw new Error(`invoice_payments lookup failed: ${error.message}`)
  const booked = new Set(((data ?? []) as { external_ref: string | null }[]).map((p) => p.external_ref).filter(Boolean))
  return roundOre(collected.filter((p) => !booked.has(p.paymentRef)).reduce((sum, p) => sum + roundOre(p.capitalPaid), 0))
}

/**
 * Reconcile open cases: every one (the daily run) or only those already
 * flagged (every other run, so a fixed difference clears quickly).
 */
export async function reconcileCases(
  deps: ReconcileDeps,
  options: { only: 'all' | 'mismatched'; companyId?: string },
): Promise<CaseReconcileSummary> {
  const summary: CaseReconcileSummary = { checked: 0, mismatched: 0, paused: 0, resent: 0, failed: 0, complete: true }
  const log = deps.log ?? defaultLog
  const raw = await fetchAllRows<Record<string, unknown>>(({ from, to }) => {
    let query = deps.db
      .from('collection_cases')
      .select('*')
      .eq('is_open', true)
      .eq('submission_status', 'registered')
    if (options.only === 'mismatched') query = query.not('outstanding_mismatch', 'is', null)
    if (options.companyId) query = query.eq('company_id', options.companyId)
    return query.order('id', { ascending: true }).range(from, to)
  })
  const clock = deps.clock ?? Date.now
  const started = clock()
  for (const row of raw.map(normalizeCaseRow)) {
    if (deps.budgetMs !== undefined && clock() - started > deps.budgetMs) {
      summary.complete = false
      break
    }
    try {
      await reconcileCase(deps, row, summary, log)
    } catch (err) {
      summary.failed++
      log.warn('collection case reconcile failed', { caseId: row.id, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return summary
}

async function reconcileCase(deps: ReconcileDeps, row: CollectionCaseRow, summary: CaseReconcileSummary, log: Logger): Promise<void> {
  if (!row.provider_case_ref) return
  const now = deps.now ? deps.now() : new Date()
  const connection = await loadConnectionById(deps.db, row.company_id, row.connection_id)
  if (!connection) return
  const adapter = adapterForConnection(deps, connection)
  const ctx = callContext(row.company_id, connection)

  // 1. What the provider says now (this also acknowledges the reports it lists).
  let snapshot: CollectionsCase
  let current: CollectionCaseRow
  try {
    snapshot = await adapter.getCase(ctx, { caseRef: row.provider_case_ref })
    current = (await applyCaseSnapshot(deps.db, row, snapshot, { now })).row
  } catch (err) {
    if (!isCollectionsError(err)) throw err
    summary.failed++
    await recordCaseSyncError(deps.db, row, err.code)
    return
  }
  summary.checked++
  if (!current.is_open) return

  const { data: forwardData, error: forwardError } = await deps.db
    .from('collection_payment_forwards')
    .select('id, kind, invoice_payment_id, amount, payment_date, status, request_amount, sent_amount, forwarded_at, acknowledged_at, resent_at, lease_until, updated_at')
    .eq('case_id', row.id)
  if (forwardError) throw new Error(`collection_payment_forwards lookup failed: ${forwardError.message}`)
  const forwards = (forwardData ?? []) as ForwardStateRow[]

  // 2. Reports the provider has not listed within a day: once more, same key, same body.
  const resendBefore = now.getTime() - UNACKNOWLEDGED_RESEND_MS
  for (const f of forwards) {
    if (
      f.kind !== 'payment' ||
      f.status !== 'forwarded' ||
      f.acknowledged_at !== null ||
      f.resent_at !== null ||
      f.request_amount === null ||
      !f.invoice_payment_id ||
      !f.forwarded_at ||
      Date.parse(f.forwarded_at) > resendBefore
    ) {
      continue
    }
    try {
      await adapter.registerPayment(ctx, {
        idempotencyKey: f.id,
        caseRef: row.provider_case_ref,
        paymentRef: f.invoice_payment_id,
        date: f.payment_date,
        amount: roundOre(num(f.request_amount)),
        description: null,
      })
      summary.resent++
    } catch (err) {
      log.warn('collection forward resend failed', { forwardId: f.id, code: isCollectionsError(err) ? err.code : String(err) })
    }
    // Once only, whatever the answer: the comparison below catches a report that never arrived.
    const { error } = await deps.db
      .from('collection_payment_forwards')
      .update({ resent_at: now.toISOString() })
      .eq('id', f.id)
      .is('resent_at', null)
    if (error) throw new Error(`collection_payment_forwards update failed: ${error.message}`)
  }

  // 3. The provider's remaining principal against the books. A forward in
  // flight, or finished a moment ago, may not show in the snapshot yet. Only
  // a live lease counts as in flight: a drain that died leaves a lease that
  // ran out (on a row skipped meanwhile, for good), which must not hold the
  // comparison off forever.
  const settling = forwards.some(
    (f) =>
      (f.lease_until !== null && Date.parse(f.lease_until) > now.getTime()) ||
      now.getTime() - Date.parse(f.updated_at) < FORWARD_SETTLE_MS,
  )
  if (settling) return
  let ledgerRemaining: number
  try {
    ledgerRemaining = (await loadLedgerRemaining(deps.db, row.company_id, row.invoice_id)).ledgerRemaining
  } catch (err) {
    if (err instanceof HandoverNotFoundError) return
    throw err
  }
  const expected = expectedProviderPrincipal({
    ledgerRemaining,
    forwards,
    collectedUnbooked: await collectedUnbooked(deps.db, current, snapshot),
  })
  const provider = roundOre(snapshot.outstandingPrincipal)
  const difference = roundOre(provider - expected)
  const mismatch = Math.abs(difference) >= 0.01 ? difference : null
  const wasFlagged = row.outstanding_mismatch !== null
  const today = todayIsoStockholm(now)

  const { error: updateError } = await deps.db
    .from('collection_cases')
    .update({
      outstanding_mismatch: mismatch,
      outstanding_expected: mismatch === null ? null : expected,
      last_reconciled_at: now.toISOString(),
    })
    .eq('id', row.id)
  if (updateError) throw new Error(`collection_cases update failed: ${updateError.message}`)

  if (mismatch === null) {
    if (wasFlagged) {
      await appendCaseEvents(deps.db, current, [
        {
          kind: 'other',
          label: 'cleared',
          occurredAt: now.toISOString(),
          direction: 'internal',
          providerEventRef: `${RECONCILE_EVENT_PREFIX}${row.id}:${now.toISOString()}:cleared`,
        },
      ])
    }
    return
  }
  summary.mismatched++
  if (wasFlagged && row.outstanding_mismatch === mismatch) return

  // New, or a different difference: the provider claims more than the books -> pause.
  let label: 'mismatch' | 'mismatch_paused' = 'mismatch'
  if (mismatch > 0) {
    const paused = await pauseCaseAutomatically(deps, current, {
      idempotencyKey: `${row.id}:reconcile:${today}`,
      reason: 'outstanding_mismatch',
    })
    if (paused.outcome === 'paused') {
      summary.paused++
      label = 'mismatch_paused'
    }
  }
  log.warn('collection case outstanding differs from the books', { caseId: row.id, difference: mismatch })
  await appendCaseEvents(deps.db, current, [
    {
      kind: 'other',
      label,
      occurredAt: now.toISOString(),
      direction: 'internal',
      amount: mismatch,
      providerEventRef: `${RECONCILE_EVENT_PREFIX}${row.id}:${now.toISOString()}:${label}`,
      raw: { provider_outstanding: provider, expected, ledger_remaining: ledgerRemaining },
    },
  ])
}
