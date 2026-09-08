/**
 * Matching at arrival: pair a document with its bank transaction the moment
 * the extraction has read it, instead of waiting for someone to open a picker.
 *
 * Three postures, decided per pair:
 *
 *   link     the pair is certain (exact amount, unambiguous, the counterparty
 *            has earned automation) and the document is attached now;
 *   propose  the pair is probable and a human is asked, through the same
 *            pending_operations row the receipt hunt stages;
 *   skip     nothing worth asking about, or a veto.
 *
 * What is borrowed and from where:
 *   - the uniqueness gate (a tie is never resolved by machine), from the
 *     expense tools that publish their rule;
 *   - one-to-one assignment before any decision, from record linkage
 *     (Jaro, 1989): a document links at most once and so does a purchase;
 *   - autonomy earned per counterparty from the company's own confirmations
 *     and declines, from Midday's reconciliation engine;
 *   - hard vetoes above the soft score, and every decision logged whether
 *     acted on or not (shadow mode), from fraud detection.
 *
 * The scoring itself is the shared receipt matcher; nothing here re-weights
 * it. The planner is pure so every rule is unit-testable without a database;
 * `runArrivalMatch` owns the reads and the writes.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { createLogger } from '@/lib/logger'
import { getRiskLevel } from '@/lib/pending-operations/risk-tiers'
import { normalizeCounterpartyName } from '@/lib/bookkeeping/counterparty-templates'
import { resolveSekAmount } from '@/lib/bookkeeping/currency-utils'
import { scoreUnderlagCandidates, type CandidateTransaction } from '@/lib/agent-context/underlag-candidates'
import { completeInboxItemsForBookedTransaction } from '@/lib/transactions/inbox-underlag'
import { adjudicate } from '@/lib/receipt-hunt/adjudicate'
import { attachSekTotals } from '@/lib/receipt-hunt/fx'
import {
  buildAttachPreview,
  buildAttachTitle,
  fetchSuppression,
  resolveOwnerUserId,
  LOOKBACK_MONTHS,
} from '@/lib/receipt-hunt/hunt'
import {
  AMBIGUITY_MARGIN,
  CERTAIN_CONFIDENCE,
  HUNT_MIN_CONFIDENCE,
  UNCERTAIN_FLOOR,
  pairKey,
  type HuntPoolItem,
  type SuppressionSets,
} from '@/lib/receipt-hunt/select'
import { calibratedProbability } from './calibration'
import { fetchRejectedPairs } from './rejections'
import { insertShadowRows, type ShadowDecidedBy, type ShadowDecision, type ShadowRow, type ShadowTrigger } from './shadow-log'

/** Days a document stays in the arrival queue and is rescanned at every bank sync. */
export const ARRIVAL_WINDOW_DAYS = 30

/**
 * Largest purchase the matcher may link on its own, in kronor.
 *
 * Automation by risk: above this a wrong link is expensive enough that a
 * human confirms, however certain the arithmetic. Proposals are unbounded.
 */
export const AUTO_LINK_MAX_SEK = 10_000

/**
 * What a counterparty must have earned before its pairs link unattended:
 * this many confirmed pairings (approved proposals or manual matches) and at
 * most this many declines. Until then every pair is a proposal.
 */
export const AUTONOMY_MIN_CONFIRMED = 3
export const AUTONOMY_MAX_DECLINED = 1

export const ARRIVAL_ACTOR_LABEL = 'Underlagsmatchning'
const OPERATION_TYPE = 'attach_document_to_transaction'
const log = createLogger('underlag/arrival-match')

/**
 * How much the matcher is allowed to do. `act` links and proposes, `propose`
 * never links, `shadow` only logs. Read from ARRIVAL_MATCH_MODE so a deploy
 * can run the whole thing silently against production before it acts.
 */
export type ArrivalMode = 'shadow' | 'propose' | 'act'

export function resolveArrivalMode(raw: string | undefined = process.env.ARRIVAL_MATCH_MODE): ArrivalMode {
  if (raw === 'shadow' || raw === 'propose' || raw === 'act') return raw
  return 'act'
}

export interface ArrivalTransaction extends CandidateTransaction {
  company_id: string
  document_id: string | null
  journal_entry_id: string | null
}

export interface CounterpartyAutonomy {
  confirmed: number
  declined: number
}

export function hasEarnedAutonomy(a: CounterpartyAutonomy | undefined): boolean {
  if (!a) return false
  return a.confirmed >= AUTONOMY_MIN_CONFIRMED && a.declined <= AUTONOMY_MAX_DECLINED
}

/** The key automation is earned on: the bank's name for the counterparty, normalised. */
export function counterpartyKeyOf(tx: Pick<CandidateTransaction, 'merchant_name' | 'description'>): string | null {
  const raw = tx.merchant_name || tx.description || ''
  const key = normalizeCounterpartyName(raw)
  return key.length > 0 ? key : null
}

export type ArrivalReason =
  | 'earned_autonomy'
  | 'not_earned'
  | 'amount_cap'
  | 'inexact_amount'
  | 'ambiguous'
  | 'needs_second_opinion'
  | 'second_opinion_declined'
  | 'below_floor'
  | 'no_candidate'
  | 'mode_shadow'
  | 'mode_propose'

export interface ArrivalDecision {
  inbox_item_id: string
  document_id: string
  transaction_id: string | null
  decision: ShadowDecision
  decided_by: ShadowDecidedBy
  reason: ArrivalReason
  confidence: number | null
  calibrated_p: number | null
  counterparty_key: string | null
  matchReasons: string[]
  /** True for the 0.6 to 0.7 band: proposed only if the adjudicator agrees. */
  needsAdjudication: boolean
  /** Receipt-side facts for the proposal preview. */
  merchant_name: string | null
  receipt_date: string | null
  total_amount: number | null
  currency: string | null
  sek_total: number | null
  /** Strongest competing score on either side, for the log. */
  runner_up: number | null
}

export interface PlanOptions {
  autoLinkMaxSek?: number
  /** Whether a link may be planned at all; false turns every link into a proposal. */
  allowLink?: boolean
}

interface Pair {
  tx: ArrivalTransaction
  item: HuntPoolItem
  confidence: number
  matchReasons: string[]
  merchant_name: string | null
  receipt_date: string | null
  total_amount: number | null
  currency: string | null
}

/**
 * Whether the two sums are the same number. In one currency that is öre-exact:
 * a 5 % tolerance is 2 000 kr on a 40 000 kr invoice, which is a different
 * purchase, not a rounding. Across a rate the matcher's own 1 % band applies,
 * because the spread is a known error rather than a disagreement.
 */
function isExactAmount(p: Pair): boolean {
  if (p.total_amount == null || p.tx.amount == null) return false
  const sameCurrency = (p.currency ?? 'SEK').toUpperCase() === (p.tx.currency ?? 'SEK').toUpperCase()
  if (sameCurrency) return Math.abs(Math.abs(p.tx.amount) - Math.abs(p.total_amount)) < 0.005
  return p.matchReasons.some((r) => r.startsWith('Exakt belopp'))
}

function absSek(tx: ArrivalTransaction): number {
  if (tx.amount == null) return 0
  const sek = (tx.currency ?? 'SEK').toUpperCase() === 'SEK'
    ? tx.amount
    : resolveSekAmount(tx.amount, tx.amount_sek, tx.currency, tx.exchange_rate)
  return Math.abs(sek)
}

/**
 * Decide every document in the batch against every candidate transaction.
 *
 * Pure. The caller has already loaded the pool with SEK totals attached, the
 * transactions in the window, the suppression sets and the autonomy table.
 */
export function planArrivalMatches(
  items: readonly HuntPoolItem[],
  transactions: readonly ArrivalTransaction[],
  suppression: SuppressionSets,
  autonomy: ReadonlyMap<string, CounterpartyAutonomy>,
  options: PlanOptions = {},
): ArrivalDecision[] {
  const autoLinkMaxSek = options.autoLinkMaxSek ?? AUTO_LINK_MAX_SEK
  const allowLink = options.allowLink ?? true

  const pool = items.filter((i) => i.document_id != null)
  const decisions: ArrivalDecision[] = []
  if (pool.length === 0) return decisions

  // Every comparable pair, scored by the shared matcher. Vetoes first: a
  // purchase that already carries a document, a purchase with a live
  // proposal, a document already spoken for, and a pair a human said no to
  // are out before any score is read.
  const pairs: Pair[] = []
  for (const tx of transactions) {
    if (tx.amount == null || tx.amount >= 0 || !tx.date) continue
    if (tx.document_id) continue
    if (suppression.claimedTransactionIds.has(tx.id)) continue
    const scored = scoreUnderlagCandidates(tx, pool as never[])
    for (const c of scored) {
      if (!c.document_id) continue
      if (c.amountSource === 'prominent') continue
      if (suppression.claimedDocumentIds.has(c.document_id)) continue
      if (suppression.rejectedPairs.has(pairKey(tx.id, c.document_id))) continue
      const item = pool.find((i) => i.id === c.inbox_item_id)
      if (!item) continue
      pairs.push({
        tx,
        item,
        confidence: c.confidence,
        matchReasons: c.matchReasons,
        merchant_name: c.merchant_name,
        receipt_date: c.receipt_date,
        total_amount: c.total_amount,
        currency: c.currency,
      })
    }
  }

  // Runner-up per document and per purchase, read before assignment so a
  // pair that wins by a hair is still called ambiguous.
  const bestByItem = new Map<string, number[]>()
  const bestByTx = new Map<string, number[]>()
  for (const p of pairs) {
    bestByItem.set(p.item.id, [...(bestByItem.get(p.item.id) ?? []), p.confidence])
    bestByTx.set(p.tx.id, [...(bestByTx.get(p.tx.id) ?? []), p.confidence])
  }
  const runnerUp = (list: number[] | undefined, winner: number): number | null => {
    if (!list) return null
    const sorted = [...list].sort((a, b) => b - a)
    const idx = sorted.indexOf(winner)
    const rest = sorted.filter((_, i) => i !== idx)
    return rest.length > 0 ? rest[0] : null
  }

  // One-to-one assignment: strongest pairs first, each document and each
  // purchase taken at most once. Greedy on a sorted list is the assignment
  // for well-separated scores, and ties are handled by the margin below.
  const sorted = [...pairs].sort((a, b) => b.confidence - a.confidence)
  const takenItems = new Set<string>()
  const takenTx = new Set<string>()
  const assigned: Pair[] = []
  for (const p of sorted) {
    if (takenItems.has(p.item.id) || takenTx.has(p.tx.id)) continue
    takenItems.add(p.item.id)
    takenTx.add(p.tx.id)
    assigned.push(p)
  }

  for (const p of assigned) {
    const itemRunnerUp = runnerUp(bestByItem.get(p.item.id), p.confidence)
    const txRunnerUp = runnerUp(bestByTx.get(p.tx.id), p.confidence)
    const strongestRival = Math.max(itemRunnerUp ?? -1, txRunnerUp ?? -1)
    const ambiguous = strongestRival >= 0 && p.confidence - strongestRival < AMBIGUITY_MARGIN
    const key = counterpartyKeyOf(p.tx)
    const base = {
      inbox_item_id: p.item.id,
      document_id: p.item.document_id as string,
      transaction_id: p.tx.id,
      confidence: p.confidence,
      calibrated_p: calibratedProbability(p.confidence),
      counterparty_key: key,
      matchReasons: p.matchReasons,
      merchant_name: p.merchant_name,
      receipt_date: p.receipt_date,
      total_amount: p.total_amount,
      currency: p.currency,
      sek_total: p.item.sek_total ?? null,
      runner_up: strongestRival >= 0 ? strongestRival : null,
      needsAdjudication: false,
    }

    if (ambiguous) {
      decisions.push({ ...base, decision: 'skip', decided_by: 'veto', reason: 'ambiguous' })
      continue
    }
    if (p.confidence < UNCERTAIN_FLOOR) {
      decisions.push({ ...base, decision: 'skip', decided_by: 'matcher', reason: 'below_floor' })
      continue
    }

    const exact = isExactAmount(p)
    const certain = p.confidence >= CERTAIN_CONFIDENCE
    if (certain && exact) {
      if (!allowLink) {
        decisions.push({ ...base, decision: 'propose', decided_by: 'matcher', reason: 'mode_propose' })
      } else if (absSek(p.tx) > autoLinkMaxSek) {
        decisions.push({ ...base, decision: 'propose', decided_by: 'veto', reason: 'amount_cap' })
      } else if (key && hasEarnedAutonomy(autonomy.get(key))) {
        decisions.push({ ...base, decision: 'link', decided_by: 'autonomy', reason: 'earned_autonomy' })
      } else {
        decisions.push({ ...base, decision: 'propose', decided_by: 'autonomy', reason: 'not_earned' })
      }
      continue
    }
    if (certain) {
      decisions.push({ ...base, decision: 'propose', decided_by: 'matcher', reason: 'inexact_amount' })
      continue
    }
    if (p.confidence >= HUNT_MIN_CONFIDENCE) {
      decisions.push({ ...base, decision: 'propose', decided_by: 'matcher', reason: 'inexact_amount' })
      continue
    }
    decisions.push({
      ...base,
      decision: 'propose',
      decided_by: 'adjudicator',
      reason: 'needs_second_opinion',
      needsAdjudication: true,
    })
  }

  // Documents nothing paired with: logged as skips so recall is measurable.
  for (const item of pool) {
    if (takenItems.has(item.id)) continue
    decisions.push({
      inbox_item_id: item.id,
      document_id: item.document_id as string,
      transaction_id: null,
      decision: 'skip',
      decided_by: 'matcher',
      reason: 'no_candidate',
      confidence: null,
      calibrated_p: null,
      counterparty_key: null,
      matchReasons: [],
      needsAdjudication: false,
      merchant_name: null,
      receipt_date: null,
      total_amount: null,
      currency: null,
      sek_total: null,
      runner_up: null,
    })
  }

  return decisions
}

// ── Reads ──────────────────────────────────────────────────────────────

async function fetchArrivalPool(
  supabase: SupabaseClient,
  companyId: string,
  inboxItemIds?: readonly string[],
): Promise<{ pool: HuntPoolItem[]; fileNames: Map<string, string> }> {
  const since = new Date()
  since.setDate(since.getDate() - ARRIVAL_WINDOW_DAYS)

  let query = supabase
    .from('invoice_inbox_items')
    .select('id, document_id, extracted_data, channel_context, created_at')
    .eq('company_id', companyId)
    .is('matched_transaction_id', null)
    .is('created_journal_entry_id', null)
    .is('created_supplier_invoice_id', null)
    .not('document_id', 'is', null)
  query = inboxItemIds && inboxItemIds.length > 0
    ? query.in('id', [...inboxItemIds])
    : query.gte('created_at', since.toISOString())
  const { data: items, error } = await query.order('id', { ascending: true }).limit(500)
  if (error) throw new Error(`arrival pool read failed: ${error.message}`)
  const rows = (items ?? []) as Array<HuntPoolItem & { created_at: string }>
  if (rows.length === 0) return { pool: [], fileNames: new Map() }

  const docIds = rows.map((r) => r.document_id as string)
  const { data: docs, error: docError } = await supabase
    .from('document_attachments')
    .select('id, file_name, journal_entry_id, is_current_version')
    .eq('company_id', companyId)
    .in('id', docIds)
  if (docError) throw new Error(`arrival document read failed: ${docError.message}`)
  const fileNames = new Map<string, string>()
  for (const d of (docs ?? []) as Array<{ id: string; file_name: string | null; journal_entry_id: string | null; is_current_version: boolean }>) {
    // A document already anchored to a verifikat is räkenskapsinformation and stays where it is.
    if (!d.is_current_version || d.journal_entry_id) continue
    fileNames.set(d.id, d.file_name ?? 'underlag')
  }
  const pool = rows.filter((r) => r.document_id != null && fileNames.has(r.document_id))
  return { pool, fileNames }
}

/**
 * Purchases a document could belong to: outflows without a document, booked
 * or not. The receipt hunt stops at unbooked rows; at arrival the verifikat
 * that was posted without its underlag is exactly the row the document is
 * for, and attaching it there is the compliant outcome.
 */
async function fetchArrivalTransactions(
  supabase: SupabaseClient,
  companyId: string,
): Promise<ArrivalTransaction[]> {
  const since = new Date()
  since.setMonth(since.getMonth() - LOOKBACK_MONTHS)
  const sinceDate = since.toISOString().slice(0, 10)
  return fetchAllRows<ArrivalTransaction>((range) =>
    supabase
      .from('transactions')
      .select('id, company_id, date, description, merchant_name, amount, currency, amount_sek, exchange_rate, document_id, journal_entry_id')
      .eq('company_id', companyId)
      .is('document_id', null)
      .eq('is_ignored', false)
      .not('is_business', 'is', false)
      .lt('amount', 0)
      .gte('date', sinceDate)
      .order('id', { ascending: true })
      .range(range.from, range.to),
  )
}

function chunk<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

async function keysForTransactionIds(
  supabase: SupabaseClient,
  companyId: string,
  ids: readonly string[],
): Promise<Map<string, string | null>> {
  const keys = new Map<string, string | null>()
  for (const part of chunk([...new Set(ids)], 200)) {
    const { data } = await supabase
      .from('transactions')
      .select('id, merchant_name, description')
      .eq('company_id', companyId)
      .in('id', part)
    for (const row of (data ?? []) as Array<{ id: string; merchant_name: string | null; description: string | null }>) {
      keys.set(row.id, counterpartyKeyOf(row))
    }
  }
  return keys
}

/**
 * What each counterparty has earned in this company: confirmed pairings
 * (documents matched to its purchases, by hand or by an approved proposal)
 * against declines (rejected proposals and manual unmatches).
 */
export async function fetchCounterpartyAutonomy(
  supabase: SupabaseClient,
  companyId: string,
): Promise<Map<string, CounterpartyAutonomy>> {
  const [matched, rejected, rejectedOps] = await Promise.all([
    fetchAllRows<{ matched_transaction_id: string }>((range) =>
      supabase
        .from('invoice_inbox_items')
        .select('matched_transaction_id')
        .eq('company_id', companyId)
        .not('matched_transaction_id', 'is', null)
        .order('id', { ascending: true })
        .range(range.from, range.to),
    ),
    fetchAllRows<{ transaction_id: string }>((range) =>
      supabase
        .from('document_match_rejections')
        .select('transaction_id')
        .eq('company_id', companyId)
        .order('id', { ascending: true })
        .range(range.from, range.to),
    ),
    fetchAllRows<{ params: { transaction_id?: string } | null }>((range) =>
      supabase
        .from('pending_operations')
        .select('params')
        .eq('company_id', companyId)
        .eq('operation_type', OPERATION_TYPE)
        .eq('status', 'rejected')
        .order('id', { ascending: true })
        .range(range.from, range.to),
    ),
  ])

  const confirmedIds = matched.map((m) => m.matched_transaction_id)
  const declinedIds = [
    ...rejected.map((r) => r.transaction_id),
    ...rejectedOps.map((r) => r.params?.transaction_id).filter((id): id is string => !!id),
  ]
  const keys = await keysForTransactionIds(supabase, companyId, [...confirmedIds, ...declinedIds])

  const table = new Map<string, CounterpartyAutonomy>()
  const bump = (id: string, field: keyof CounterpartyAutonomy) => {
    const key = keys.get(id)
    if (!key) return
    const entry = table.get(key) ?? { confirmed: 0, declined: 0 }
    entry[field] += 1
    table.set(key, entry)
  }
  for (const id of confirmedIds) bump(id, 'confirmed')
  for (const id of declinedIds) bump(id, 'declined')
  return table
}

// ── Writes ─────────────────────────────────────────────────────────────

/**
 * Attach the document to the transaction the way the manual match route does:
 * the inbox row points at the transaction, the transaction carries the
 * document, and a transaction that is already booked completes the item
 * against its verifikat. Returns false when someone matched the item first.
 */
export async function linkInboxItemToTransaction(
  supabase: SupabaseClient,
  companyId: string,
  link: { inboxItemId: string; documentId: string; transactionId: string },
): Promise<boolean> {
  const { data: claimed, error } = await supabase
    .from('invoice_inbox_items')
    .update({ matched_transaction_id: link.transactionId })
    .eq('id', link.inboxItemId)
    .eq('company_id', companyId)
    .is('matched_transaction_id', null)
    .select('id')
  if (error) throw new Error(`arrival link failed: ${error.message}`)
  if (!Array.isArray(claimed) || claimed.length === 0) return false

  const { error: txError } = await supabase
    .from('transactions')
    .update({ document_id: link.documentId })
    .eq('id', link.transactionId)
    .eq('company_id', companyId)
    .is('document_id', null)
  if (txError) {
    log.error('tx.document_id mirror failed', { message: txError.message, transactionId: link.transactionId })
  }
  await completeInboxItemsForBookedTransaction(supabase, companyId, link.transactionId)
  return true
}

export interface ArrivalRunOptions {
  trigger: ShadowTrigger
  /** Restrict the run to these items; otherwise every unconsumed item in the window. */
  inboxItemIds?: readonly string[]
  /** The person whose action started the run, when there is one. */
  actorUserId?: string | null
  /** Plan and log nothing, write nothing. */
  dryRun?: boolean
  mode?: ArrivalMode
  runId?: string
}

export interface ArrivalRunSummary {
  companyId: string
  runId: string
  mode: ArrivalMode
  items: number
  transactions: number
  linked: number
  proposed: number
  skipped: number
  decisions: ArrivalDecision[]
}

/**
 * Run the matcher for one company: read, plan, act according to the mode,
 * and log every decision.
 */
export async function runArrivalMatch(
  supabase: SupabaseClient,
  companyId: string,
  options: ArrivalRunOptions,
): Promise<ArrivalRunSummary> {
  const mode = options.mode ?? resolveArrivalMode()
  const runId = options.runId ?? randomUUID()
  const dryRun = options.dryRun ?? false

  const { pool: rawPool, fileNames } = await fetchArrivalPool(supabase, companyId, options.inboxItemIds)
  const base: ArrivalRunSummary = {
    companyId, runId, mode, items: rawPool.length, transactions: 0, linked: 0, proposed: 0, skipped: 0, decisions: [],
  }
  if (rawPool.length === 0) return base

  const [pool, transactions, huntSuppression, rejected, autonomy] = await Promise.all([
    attachSekTotals(supabase, rawPool),
    fetchArrivalTransactions(supabase, companyId),
    fetchSuppression(supabase, companyId),
    fetchRejectedPairs(supabase, companyId),
    fetchCounterpartyAutonomy(supabase, companyId),
  ])
  const suppression: SuppressionSets = {
    claimedTransactionIds: huntSuppression.claimedTransactionIds,
    claimedDocumentIds: huntSuppression.claimedDocumentIds,
    rejectedPairs: new Set([...huntSuppression.rejectedPairs, ...rejected]),
  }

  const decisions = planArrivalMatches(pool, transactions, suppression, autonomy, {
    allowLink: mode === 'act',
  })
  base.transactions = transactions.length
  base.decisions = decisions

  // The 0.6 to 0.7 band gets the same second opinion the hunt gives it. A
  // dry run asks too, so the preview shows what a real run would stage.
  const txById = new Map(transactions.map((t) => [t.id, t]))
  const uncertain = decisions.filter((d) => d.needsAdjudication && d.transaction_id)
  if (uncertain.length > 0) {
    const verdicts = await adjudicate(
      uncertain.map((d) => {
        const tx = txById.get(d.transaction_id as string) as ArrivalTransaction
        return {
          key: `${d.transaction_id}::${d.document_id}`,
          purchase: {
            description: tx.merchant_name || tx.description || '',
            amount: Math.abs(tx.amount ?? 0),
            currency: tx.currency ?? 'SEK',
            date: tx.date ?? '',
          },
          receipt: {
            vendor: d.merchant_name,
            total: d.total_amount,
            currency: d.currency,
            sekTotal: d.sek_total,
            date: d.receipt_date,
            fileName: fileNames.get(d.document_id) ?? null,
          },
          confidence: d.confidence ?? 0,
          matchReasons: d.matchReasons,
        }
      }),
    )
    const accepted = new Map(verdicts.map((v) => [v.key, v.reason]))
    for (const d of uncertain) {
      const reason = accepted.get(`${d.transaction_id}::${d.document_id}`)
      if (reason) {
        d.matchReasons = [reason]
      } else {
        d.decision = 'skip'
        d.reason = 'second_opinion_declined'
      }
    }
  }

  if (dryRun) {
    for (const d of decisions) {
      if (d.decision === 'link') base.linked++
      else if (d.decision === 'propose') base.proposed++
      else base.skipped++
    }
    return base
  }

  const shadowRows: ShadowRow[] = []
  const proposals: ArrivalDecision[] = []
  for (const d of decisions) {
    let acted = false
    if (d.decision === 'link' && mode === 'act' && d.transaction_id) {
      acted = await linkInboxItemToTransaction(supabase, companyId, {
        inboxItemId: d.inbox_item_id,
        documentId: d.document_id,
        transactionId: d.transaction_id,
      })
      if (acted) base.linked++
    } else if (d.decision === 'propose' && mode !== 'shadow' && d.transaction_id) {
      proposals.push(d)
      acted = true
    } else if (d.decision === 'skip') {
      base.skipped++
    }
    shadowRows.push({
      company_id: companyId,
      user_id: options.actorUserId ?? null,
      run_id: runId,
      trigger: options.trigger,
      inbox_item_id: d.inbox_item_id,
      document_id: d.document_id,
      transaction_id: d.transaction_id,
      counterparty_key: d.counterparty_key,
      confidence: d.confidence,
      calibrated_p: d.calibrated_p,
      components: { match_reasons: d.matchReasons, runner_up: d.runner_up, sek_total: d.sek_total },
      decision: mode === 'shadow' ? d.decision : d.decision,
      decided_by: d.decided_by,
      reason: mode === 'shadow' && d.decision !== 'skip' ? 'mode_shadow' : d.reason,
      acted,
    })
  }

  if (proposals.length > 0) {
    const userId = options.actorUserId ?? (await resolveOwnerUserId(supabase, companyId))
    if (userId) {
      const rows = proposals.map((d) => {
        const tx = txById.get(d.transaction_id as string) as ArrivalTransaction
        const fileName = fileNames.get(d.document_id) ?? 'underlag'
        const receipt = {
          transaction_id: d.transaction_id as string,
          document_id: d.document_id,
          inbox_item_id: d.inbox_item_id,
          confidence: d.confidence ?? 0,
          matchReasons: d.matchReasons,
          merchant_name: d.merchant_name,
          receipt_date: d.receipt_date,
          total_amount: d.total_amount,
          currency: d.currency,
          sek_total: d.sek_total,
          mailProvenance: null,
        }
        return {
          company_id: companyId,
          user_id: userId,
          operation_type: OPERATION_TYPE,
          title: buildAttachTitle(receipt, fileName, tx),
          params: { transaction_id: d.transaction_id, document_id: d.document_id },
          preview_data: buildAttachPreview(receipt, fileName, tx),
          actor_type: options.trigger === 'arrival' && options.actorUserId ? 'user' : 'cron',
          actor_label: ARRIVAL_ACTOR_LABEL,
          risk_level: getRiskLevel(OPERATION_TYPE),
          agent_metadata: {
            source: 'arrival_match',
            run_id: runId,
            trigger: options.trigger,
            inbox_item_id: d.inbox_item_id,
            confidence: d.confidence,
            calibrated_p: d.calibrated_p,
            match_reasons: d.matchReasons,
            decided_by: d.decided_by,
            reason: d.reason,
            counterparty_key: d.counterparty_key,
          },
        }
      })
      const { error } = await supabase.from('pending_operations').insert(rows)
      if (error) throw new Error(`Failed to stage arrival proposals: ${error.message}`)
      base.proposed = rows.length
    }
  }

  await insertShadowRows(supabase, shadowRows)
  return base
}
