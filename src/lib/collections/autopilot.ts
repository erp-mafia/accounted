import type { SupabaseClient } from '@supabase/supabase-js'
import type { CollectionsFeatures } from '@accounted/connect-contract'
import { addDaysIso, todayIsoStockholm } from '@/lib/dates/iso'
import { createLogger, type Logger } from '@/lib/logger'
import { roundOre } from '@/lib/money'
import { expireStaleDailyBatches, resolveDailyBatchOwner } from '@/lib/pending-operations/daily-batch-staging'
import { getRiskLevel } from '@/lib/pending-operations/risk-tiers'
import { loadCollectionsGateFacts } from './availability'
import { runBankCheck, type BankCheckResult } from './bank-check'
import {
  COLLECTIONS_BATCH_TYPE,
  type BatchExcluded,
  type BatchExcludedReason,
  type BatchItem,
  type BatchParams,
} from './batch'
import { scanCollectionCandidates, type CandidateScanRow } from './candidates'
import { normalizeCaseRow, type CollectionCaseRow } from './case'
import { escalationRefusal, loadEscalationCheck, type EscalationCheck } from './case-actions'
import { getCollectionsProvider } from './catalogue'
import { normalizeConnectionRow, type CollectionConnectionRow } from './connection'
import { collectionsGate, readCollectionsEnv, type CollectionsEnv, type CollectionsGateFacts } from './flags'
import { HandoverNotFoundError } from './readiness'
import { resolveStartStep, startStepsFor } from './start-step'

/**
 * The daily collections batch (build spec 3.6): once a day, per company with
 * an active connection and the ladder set to 'staged', gather the overdue
 * invoices that could be handed over, the delivered invoices whose
 * reminders could start, and the cases waiting for approval of their next
 * step, into ONE staged pending operation for an administrator to review in
 * Att göra.
 *
 * This module only reads and stages. It never calls the provider's case
 * operations (openCase, caseAction): the items are sent by the commit
 * (batch-commit.ts), after a person approved them in the web UI, and every
 * item is checked again there. There is no fully automatic mode (founder
 * decision F5) and every collection notice needs its approval (F16).
 *
 * Selection, per item kind:
 *   open          an owed invoice due on or before today minus the ladder's
 *                 days, eligible (eligibility.ts), delivered (no delivery
 *                 attestation needed: imports are never batched), no
 *                 customer answer to our reminders, the customer not marked
 *                 "Skicka aldrig till inkasso", and a bank check that passed.
 *   start         the same rules for an invoice the provider only delivered
 *                 (a watching case in stage invoice_sent).
 *   approve_step  an open case waiting for approval of a reminder or a
 *                 collection notice, still owed per the books, no payment the
 *                 provider has not heard of, and a bank check that passed.
 * Everything else past the ladder's days is listed as excluded, with one
 * reason, so the person sees why it is not there.
 */

const log = createLogger('collections/autopilot')

/** Bank checks in flight at once while gathering a batch. */
const BANK_CHECK_CONCURRENCY = 4

const DECISION_KINDS = ['approve_reminder', 'approve_collection_notice'] as const
type DecisionKind = (typeof DECISION_KINDS)[number]

export interface GatherBatchInput {
  companyId: string
  connection: Pick<
    CollectionConnectionRow,
    'id' | 'minimum_amount' | 'reminder_fee_terms_since' | 'default_start_step' | 'ladder_days_after_due'
  >
  features: CollectionsFeatures | null
  now: Date
}

export interface GatheredBatch {
  batchDate: string
  /** Invoices due on or before this date are considered. */
  dueOnOrBefore: string
  items: BatchItem[]
  excluded: BatchExcluded[]
}

/** The latest due date the ladder considers today: today minus the days after due. */
export function ladderDueCutoff(today: string, daysAfterDue: number): string {
  return addDaysIso(today, -daysAfterDue)
}

export type ScanDecision =
  | { kind: 'check_bank'; itemKind: 'open' | 'start' }
  | { kind: 'excluded'; itemKind: 'open' | 'start'; reason: BatchExcludedReason; block: string | null }
  /** Already at the provider past delivery: not the batch's business. */
  | { kind: 'ignore' }

/** What the batch does with one scanned invoice before its bank check. Pure. */
export function scanDecision(row: Pick<CandidateScanRow, 'eligibility' | 'openCase' | 'imported' | 'customerExcluded'>): ScanDecision {
  const { eligibility, openCase } = row
  const watching = openCase !== null && openCase.stage === 'invoice_sent' && openCase.submission_status === 'registered'
  if (openCase && !watching) return { kind: 'ignore' }
  const itemKind = watching ? 'start' : 'open'
  const excluded = (reason: BatchExcludedReason, block: string | null = null): ScanDecision => ({ kind: 'excluded', itemKind, reason, block })

  if (row.imported || eligibility.deliveryAttestation === 'imported') return excluded('imported')
  if (row.customerExcluded) return excluded('customer_excluded')
  const blocks = eligibility.blocks.filter((b) => !(watching && b.code === 'elig_open_case'))
  if (blocks.some((b) => b.code === 'elig_below_minimum')) return excluded('below_minimum')
  if (blocks.length > 0) return excluded('ineligible', blocks[0]!.code)
  if (eligibility.deliveryAttestation === 'not_delivered') return excluded('not_delivered')
  if (eligibility.responseAttestation !== null) return excluded('response')
  return { kind: 'check_bank', itemKind }
}

/** The excluded reason for a bank check that did not pass; null when it passed. Pure. */
export function bankExclusion(result: Pick<BankCheckResult, 'outcome'>): BatchExcludedReason | null {
  if (result.outcome === 'pass') return null
  return result.outcome === 'candidates' ? 'candidates' : 'bank_stale'
}

/** The excluded reason for an approve_step escalation the books or the bank refuse; null when it may go ahead. Pure. */
export function decisionExclusion(
  check: Pick<EscalationCheck, 'ledgerRemaining' | 'providerOutstanding' | 'bankCheck'>,
): { reason: BatchExcludedReason; block: string | null } | null {
  const refused = escalationRefusal(check, { bankAttested: false, channel: 'agent' })
  if (!refused) return null
  switch (refused.code) {
    case 'COLLECTION_BANK_CANDIDATES':
      return { reason: 'candidates', block: null }
    case 'COLLECTION_BANK_STALE':
    case 'COLLECTION_ATTESTATION_REQUIRED':
      return { reason: 'bank_stale', block: null }
    case 'COLLECTION_PAYMENT_NOT_REPORTED':
      return { reason: 'ineligible', block: 'payment_not_reported' }
    default:
      return { reason: 'ineligible', block: 'elig_paid' }
  }
}

async function mapLimited<T, R>(list: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(list.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (next < list.length) {
      const index = next++
      out[index] = await fn(list[index]!)
    }
  })
  await Promise.all(workers)
  return out
}

interface DecisionCase {
  row: CollectionCaseRow
  decisionKind: DecisionKind
  invoiceNumber: string | null
  customerName: string | null
  dueDate: string | null
  customerExcluded: boolean
}

async function loadDecisionCases(db: Pick<SupabaseClient, 'from'>, companyId: string): Promise<DecisionCase[]> {
  const { data, error } = await db
    .from('collection_cases')
    .select('*')
    .eq('company_id', companyId)
    .eq('is_open', true)
    .eq('stage', 'awaiting_decision')
    .eq('submission_status', 'registered')
    .in('decision_kind', [...DECISION_KINDS])
  if (error) throw new Error(`collection_cases decision lookup failed: ${error.message}`)
  const rows = ((data ?? []) as Record<string, unknown>[]).map(normalizeCaseRow)
  if (rows.length === 0) return []
  const { data: invoices, error: invoiceError } = await db
    .from('invoices')
    .select('id, invoice_number, due_date, customer:customers(name, collections_excluded)')
    .eq('company_id', companyId)
    .in('id', rows.map((r) => r.invoice_id))
  if (invoiceError) throw new Error(`decision invoices lookup failed: ${invoiceError.message}`)
  type InvoiceRow = { id: string; invoice_number: string | null; due_date: string | null; customer: unknown }
  const byId = new Map(((invoices ?? []) as InvoiceRow[]).map((i) => [i.id, i]))
  return rows.map((row) => {
    const invoice = byId.get(row.invoice_id)
    const rawCustomer = invoice?.customer
    const customer = (Array.isArray(rawCustomer) ? rawCustomer[0] : rawCustomer) as { name?: string; collections_excluded?: boolean } | null | undefined
    return {
      row,
      decisionKind: row.decision_kind as DecisionKind,
      invoiceNumber: invoice?.invoice_number ?? null,
      customerName: customer?.name ?? null,
      dueDate: invoice?.due_date ?? null,
      customerExcluded: customer?.collections_excluded === true,
    }
  })
}

/**
 * Gather today's batch for one company: reads only (the books, the bank,
 * the case rows). The bank check runs per invoice, as at a handover.
 */
export async function gatherDailyBatch(db: Pick<SupabaseClient, 'from'>, input: GatherBatchInput): Promise<GatheredBatch> {
  const { companyId, connection, now } = input
  const today = todayIsoStockholm(now)
  const dueOnOrBefore = ladderDueCutoff(today, connection.ladder_days_after_due)
  const items: BatchItem[] = []
  const excluded: BatchExcluded[] = []

  const scanned = await scanCollectionCandidates(db, {
    companyId,
    connection,
    features: input.features,
    now,
    dueOnOrBefore,
  })
  const toCheck: Array<{ row: CandidateScanRow; itemKind: 'open' | 'start' }> = []
  for (const row of scanned) {
    const decision = scanDecision(row)
    if (decision.kind === 'ignore') continue
    if (decision.kind === 'excluded') {
      excluded.push({
        kind: decision.itemKind,
        invoice_id: row.invoice.id,
        invoice_number: row.candidate.invoice_number,
        customer_name: row.candidate.customer_name,
        due_date: row.candidate.due_date,
        reason: decision.reason,
        block: decision.block,
      })
      continue
    }
    toCheck.push({ row, itemKind: decision.itemKind })
  }

  const checked = await mapLimited(toCheck, BANK_CHECK_CONCURRENCY, async ({ row, itemKind }) => {
    const result = await runBankCheck(db, {
      companyId,
      invoice: row.invoice,
      customerName: row.candidate.customer_name,
      remaining: row.eligibility.claim.remaining,
      dismissedTransactionIds: [],
      today,
      now,
    })
    return { row, itemKind, exclusion: bankExclusion(result) }
  })
  for (const { row, itemKind, exclusion } of checked) {
    const base = {
      kind: itemKind,
      invoice_id: row.invoice.id,
      invoice_number: row.candidate.invoice_number,
      customer_name: row.candidate.customer_name,
      due_date: row.candidate.due_date,
    }
    if (exclusion) {
      excluded.push({ ...base, reason: exclusion, block: null })
      continue
    }
    items.push({
      ...base,
      case_id: itemKind === 'start' ? (row.openCase?.id ?? null) : null,
      remaining_amount: roundOre(row.eligibility.claim.remaining),
      start_step:
        resolveStartStep(
          connection.default_start_step,
          startStepsFor(input.features?.startSteps ?? ['reminder', 'collection'], row.eligibility.reminderFeeAgreed),
        ) ?? connection.default_start_step,
      decision_kind: null,
      reminder_fee_agreed: row.eligibility.reminderFeeAgreed,
      bank_check: 'pass',
    })
  }

  const decisions = await loadDecisionCases(db, companyId)
  for (const decision of decisions) {
    const { row } = decision
    // The provider no longer offers the approval (it moved on): nothing to propose.
    if (!row.actions.includes('approve_step')) continue
    const base = {
      kind: 'approve_step' as const,
      invoice_id: row.invoice_id,
      invoice_number: decision.invoiceNumber,
      customer_name: decision.customerName,
      due_date: decision.dueDate,
    }
    if (decision.customerExcluded) {
      excluded.push({ ...base, reason: 'customer_excluded', block: null })
      continue
    }
    let check: EscalationCheck
    try {
      check = await loadEscalationCheck(db, { companyId, row, dismissedTransactionIds: [], now })
    } catch (err) {
      if (err instanceof HandoverNotFoundError) continue
      throw err
    }
    const exclusion = decisionExclusion(check)
    if (exclusion) {
      excluded.push({ ...base, ...exclusion })
      continue
    }
    items.push({
      ...base,
      due_date: decision.dueDate ?? check.invoice.due_date,
      case_id: row.id,
      remaining_amount: roundOre(check.ledgerRemaining),
      start_step: null,
      decision_kind: decision.decisionKind,
      reminder_fee_agreed: null,
      bank_check: 'pass',
    })
  }

  return { batchDate: today, dueOnOrBefore, items, excluded }
}

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------

/**
 * Who the batch is staged under (pending_operations.user_id is NOT NULL):
 * the person who turned the ladder on while they are still a member, else
 * the company's owner. Approval is a separate question (an administrator).
 */
export function resolveBatchOwner(db: Pick<SupabaseClient, 'from'>, companyId: string, ladderEnabledBy: string | null): Promise<string | null> {
  return resolveDailyBatchOwner(db, companyId, ladderEnabledBy)
}

/**
 * Reject a pending batch once it has waited DAILY_BATCH_EXPIRY_HOURS (less
 * the run slack): the company's own (companyId), or every company's (null, the
 * cron's sweep, which also reaches a company whose gates or connection no
 * longer let the batch be approved). Returns how many were rejected.
 */
export function expireStaleBatches(db: Pick<SupabaseClient, 'from'>, companyId: string | null, now: Date): Promise<number> {
  return expireStaleDailyBatches(db, COLLECTIONS_BATCH_TYPE, companyId, now)
}

export type StageBatchOutcome =
  | { status: 'staged'; operationId: string; items: number; excluded: number; expired: number }
  | { status: 'empty'; excluded: number; expired: number }
  | { status: 'pending_exists'; operationId: string; expired: number }
  | { status: 'already_staged'; expired: number }
  | { status: 'no_owner'; expired: number }

export interface StageBatchInput {
  companyId: string
  connection: CollectionConnectionRow
  features: CollectionsFeatures | null
  now: Date
}

/** Swedish, as every staged operation's title (the /pending list is in Swedish). */
export function batchTitle(batchDate: string, count: number): string {
  return `Inkassoomgång ${batchDate}: ${count} ${count === 1 ? 'faktura' : 'fakturor'} att granska`
}

/**
 * Stage today's batch for one company, unless one is pending or today's was
 * already staged (the unique indexes of 20261012030600 hold the same rule
 * against two racing runs). An empty batch stages nothing.
 */
export async function stageDailyBatch(db: Pick<SupabaseClient, 'from'>, input: StageBatchInput): Promise<StageBatchOutcome> {
  const { companyId, connection, now } = input
  const expired = await expireStaleBatches(db, companyId, now)
  const batchDate = todayIsoStockholm(now)

  const { data: existing, error: existingError } = await db
    .from('pending_operations')
    .select('id, status, params')
    .eq('company_id', companyId)
    .eq('operation_type', COLLECTIONS_BATCH_TYPE)
    .in('status', ['pending', 'committing'])
    .limit(1)
  if (existingError) throw new Error(`collections batch lookup failed: ${existingError.message}`)
  const open = (existing ?? [])[0] as { id: string } | undefined
  if (open) return { status: 'pending_exists', operationId: open.id, expired }

  // Today's batch, whatever became of it (approved, rejected, failed): one per day.
  const { data: recent, error: recentError } = await db
    .from('pending_operations')
    .select('id, params')
    .eq('company_id', companyId)
    .eq('operation_type', COLLECTIONS_BATCH_TYPE)
    .gte('created_at', new Date(now.getTime() - 2 * 86_400_000).toISOString())
  if (recentError) throw new Error(`collections batch lookup failed: ${recentError.message}`)
  const stagedToday = ((recent ?? []) as Array<{ params: { batch_date?: unknown } | null }>).some((r) => r.params?.batch_date === batchDate)
  if (stagedToday) return { status: 'already_staged', expired }

  const gathered = await gatherDailyBatch(db, { companyId, connection, features: input.features, now })
  if (gathered.items.length === 0) return { status: 'empty', excluded: gathered.excluded.length, expired }

  const owner = await resolveBatchOwner(db, companyId, connection.ladder_enabled_by)
  if (!owner) return { status: 'no_owner', expired }

  const params: BatchParams = {
    batch_date: gathered.batchDate,
    connection_id: connection.id,
    items: gathered.items,
    excluded: gathered.excluded,
  }
  const counts = { open: 0, start: 0, approve_step: 0 }
  for (const item of gathered.items) counts[item.kind] += 1
  const { data: inserted, error: insertError } = await db
    .from('pending_operations')
    .insert({
      company_id: companyId,
      user_id: owner,
      operation_type: COLLECTIONS_BATCH_TYPE,
      status: 'pending',
      title: batchTitle(gathered.batchDate, gathered.items.length),
      params,
      preview_data: {
        batch_date: gathered.batchDate,
        due_on_or_before: gathered.dueOnOrBefore,
        item_count: gathered.items.length,
        excluded_count: gathered.excluded.length,
        counts,
        remaining_total: roundOre(gathered.items.reduce((sum, item) => sum + item.remaining_amount, 0)),
        provider: connection.display_name,
      },
      actor_type: 'cron',
      actor_label: 'Daglig inkassoomgång',
      risk_level: getRiskLevel(COLLECTIONS_BATCH_TYPE),
      agent_metadata: { source: 'collections_ladder' },
      created_at: now.toISOString(),
    })
    .select('id')
    .single()
  if (insertError) {
    // Another run staged it first (one pending batch per company, one per day).
    if ((insertError as { code?: string }).code === '23505') return { status: 'already_staged', expired }
    throw new Error(`collections batch staging failed: ${insertError.message}`)
  }
  return {
    status: 'staged',
    operationId: (inserted as { id: string }).id,
    items: gathered.items.length,
    excluded: gathered.excluded.length,
    expired,
  }
}

// ---------------------------------------------------------------------------
// The cron
// ---------------------------------------------------------------------------

export interface LadderCronSummary {
  enabled: boolean
  companies: number
  staged: number
  empty: number
  pendingExists: number
  alreadyStaged: number
  noOwner: number
  expired: number
  gated: number
  failed: number
}

export interface LadderCronDeps {
  db: SupabaseClient
  env?: CollectionsEnv
  now?: () => Date
  log?: Logger
  loadFacts?: (db: SupabaseClient, companyId: string) => Promise<CollectionsGateFacts>
  providerFeatures?: (connection: CollectionConnectionRow) => Promise<CollectionsFeatures | null>
}

/**
 * GET /api/collections/ladder/cron: stage the day's batch for every company
 * whose connection is active with the ladder set to 'staged' and whose start
 * gates say yes (kill switch, pilot list, COLLECTIONS_LADDER_ENABLED, the
 * paid capability or a sandbox on the fake provider). Off entirely while
 * COLLECTIONS_ENABLED or COLLECTIONS_LADDER_ENABLED is unset: no query runs.
 */
export async function runLadderCron(deps: LadderCronDeps): Promise<LadderCronSummary> {
  const env = deps.env ?? readCollectionsEnv()
  const logger = deps.log ?? log
  const summary: LadderCronSummary = {
    enabled: env.enabled && env.ladderEnabled,
    companies: 0,
    staged: 0,
    empty: 0,
    pendingExists: 0,
    alreadyStaged: 0,
    noOwner: 0,
    expired: 0,
    gated: 0,
    failed: 0,
  }
  if (!summary.enabled) return summary

  // Every company's batch left waiting 72 hours, also where the gates, the
  // connection or the ladder setting no longer let it be approved.
  summary.expired += await expireStaleBatches(deps.db, null, deps.now ? deps.now() : new Date())

  const { data, error } = await deps.db
    .from('collection_connections')
    .select('*')
    .eq('state', 'active')
    .eq('ladder_mode', 'staged')
  if (error) throw new Error(`collection_connections lookup failed: ${error.message}`)
  const connections = ((data ?? []) as Record<string, unknown>[]).map(normalizeConnectionRow)
  const loadFacts = deps.loadFacts ?? loadCollectionsGateFacts
  const providerFeatures =
    deps.providerFeatures ?? (async (connection: CollectionConnectionRow) => (await getCollectionsProvider(connection.route))?.features ?? null)

  for (const connection of connections) {
    summary.companies += 1
    const companyId = connection.company_id
    try {
      const facts = await loadFacts(deps.db, companyId)
      if (!collectionsGate('daily_batch', facts, env).allowed) {
        summary.gated += 1
        continue
      }
      const outcome = await stageDailyBatch(deps.db, {
        companyId,
        connection,
        features: await providerFeatures(connection),
        now: deps.now ? deps.now() : new Date(),
      })
      summary.expired += outcome.expired
      if (outcome.status === 'staged') summary.staged += 1
      else if (outcome.status === 'empty') summary.empty += 1
      else if (outcome.status === 'pending_exists') summary.pendingExists += 1
      else if (outcome.status === 'already_staged') summary.alreadyStaged += 1
      else summary.noOwner += 1
    } catch (err) {
      summary.failed += 1
      logger.error('collections batch failed for a company', err as Error, { companyId })
    }
  }
  return summary
}
