/**
 * The nightly receipt hunt: pair unbooked card purchases with receipts the
 * company already holds, and stage each pairing for a human to approve.
 *
 * Reads and one write; every judgement lives in `select.ts` so it can be tested
 * without a database. Nothing here books anything: the staged operation is
 * `attach_document_to_transaction`, whose executor links the document to the
 * transaction and leaves the journal untouched.
 *
 * Scope note: candidates are *unbooked* transactions. Posted verifikat missing
 * underlag are a different problem with a different remedy (the
 * `verifikat_missing_document` worklist, pulled at the user's pace) and are
 * deliberately out of reach here.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { getRiskLevel } from '@/lib/pending-operations/risk-tiers'
import { adjudicate } from './adjudicate'
import { attachSekTotals } from './fx'
import {
  CERTAIN_CONFIDENCE,
  MAX_PROPOSALS_PER_RUN,
  UNCERTAIN_FLOOR,
  pairKey,
  selectProposals,
  type HuntPoolItem,
  type HuntProposal,
  type HuntTransaction,
} from './select'

/**
 * Smallest purchase worth hunting a receipt for, in kronor.
 *
 * Not a compliance threshold: BFL wants an underlag whatever the amount. It is
 * a cost boundary, because below it the mail search and the model call cost
 * more than the bookkeeping value of the answer. Small purchases are still
 * counted, and still get asked about in the weekly digest.
 */
export const MIN_AMOUNT_SEK = 100

/** How far back a purchase may be and still be hunted. */
export const LOOKBACK_MONTHS = 12

/** Actor label shown wherever a staged operation names its origin. */
export const HUNT_ACTOR_LABEL = 'Kvittojakten'

const OPERATION_TYPE = 'attach_document_to_transaction'

/** Statuses that mean "this purchase already has a live or settled proposal". */
const CLAIMED_STATUSES = ['pending', 'committing', 'committed'] as const

export interface HuntCompanyResult {
  companyId: string
  candidates: number
  poolSize: number
  proposed: number
  skippedNoOwner?: boolean
  /** Populated on a dry run so the pairings can be inspected before trusting them. */
  proposals?: HuntProposal[]
}

export interface HuntOptions {
  limit?: number
  /**
   * Score and decide, but write nothing.
   *
   * The provkörning the flow concept calls for: a company can see exactly what
   * tonight would propose before anything reaches the granskningskö, and it is
   * how this code is validated against a real ledger without staging a single
   * operation.
   */
  dryRun?: boolean
}

/**
 * Purchases with no receipt that nobody has booked yet. Exported for the
 * agent worklist (agent-worklist.ts), so both engines share one predicate.
 */
export async function fetchCandidateTransactions(
  supabase: SupabaseClient,
  companyId: string,
): Promise<HuntTransaction[]> {
  const since = new Date()
  since.setMonth(since.getMonth() - LOOKBACK_MONTHS)
  const sinceDate = since.toISOString().slice(0, 10)

  const rows = await fetchAllRows<HuntTransaction>((range) =>
    supabase
      .from('transactions')
      .select('id, company_id, date, description, merchant_name, amount, currency, amount_sek, exchange_rate')
      .eq('company_id', companyId)
      .is('journal_entry_id', null)
      .is('document_id', null)
      .eq('is_ignored', false)
      // is_business IS DISTINCT FROM false: NULL is untriaged and true is
      // "business, not yet booked". Only an explicit false means the user
      // called it private, and a private purchase needs no underlag.
      .not('is_business', 'is', false)
      // Outflows only, and amount <= -MIN covers the floor in one filter.
      .lte('amount', -MIN_AMOUNT_SEK)
      .gte('date', sinceDate)
      .order('id', { ascending: true })
      .range(range.from, range.to),
  )
  return rows
}

/**
 * Unconsumed inbox items whose document is still free to attach.
 *
 * Loaded once per company and scored against every candidate, rather than
 * re-queried per transaction: it turns N queries into one and, more
 * importantly, removes the newest-50 truncation that a per-transaction lookup
 * imposes on a company with a deep backlog.
 */
async function fetchPool(
  supabase: SupabaseClient,
  companyId: string,
): Promise<{ pool: HuntPoolItem[]; fileNames: Map<string, string> }> {
  const attachments = await fetchAllRows<{ id: string; file_name: string | null }>((range) =>
    supabase
      .from('document_attachments')
      .select('id, file_name')
      .eq('company_id', companyId)
      .eq('is_current_version', true)
      // A document already anchored to a verifikat is räkenskapsinformation;
      // the executor would 409 rather than move it.
      .is('journal_entry_id', null)
      .order('id', { ascending: true })
      .range(range.from, range.to),
  )
  const fileNames = new Map<string, string>()
  for (const a of attachments) fileNames.set(a.id, a.file_name ?? 'underlag')

  const items = await fetchAllRows<HuntPoolItem>((range) =>
    supabase
      .from('invoice_inbox_items')
      .select('id, document_id, extracted_data, channel_context')
      .eq('company_id', companyId)
      .is('matched_transaction_id', null)
      .is('created_journal_entry_id', null)
      .is('created_supplier_invoice_id', null)
      .not('document_id', 'is', null)
      .order('id', { ascending: true })
      .range(range.from, range.to),
  )

  const pool = items.filter((i) => i.document_id != null && fileNames.has(i.document_id))
  return { pool, fileNames }
}

/**
 * What this company has already been asked, so it is never asked twice.
 *
 * Derived from `pending_operations` history rather than a table of its own:
 * the answers already live there, terminal rows are immutable, and a rejection
 * is exactly the durable "no" the hunt must respect.
 */
async function fetchSuppression(supabase: SupabaseClient, companyId: string) {
  const rows = await fetchAllRows<{
    id: string
    status: string
    params: { transaction_id?: string; document_id?: string } | null
  }>((range) =>
    supabase
      .from('pending_operations')
      .select('id, status, params')
      .eq('company_id', companyId)
      .eq('operation_type', OPERATION_TYPE)
      .in('status', [...CLAIMED_STATUSES, 'rejected'])
      .order('id', { ascending: true })
      .range(range.from, range.to),
  )

  const claimedTransactionIds = new Set<string>()
  const claimedDocumentIds = new Set<string>()
  const rejectedPairs = new Set<string>()
  for (const row of rows) {
    const txId = row.params?.transaction_id
    const docId = row.params?.document_id
    if (!txId) continue
    if (row.status === 'rejected') {
      if (docId) rejectedPairs.add(pairKey(txId, docId))
    } else {
      claimedTransactionIds.add(txId)
      // A receipt already offered to one purchase is spoken for. Within a run
      // spentDocumentIds handles this, but nothing carried it across runs, so
      // one H&M receipt was proposed for a -358 purchase on one night and a
      // -354 purchase on the next. Approving both would put the same underlag
      // on two verifikat.
      if (docId) claimedDocumentIds.add(docId)
    }
  }
  return { claimedTransactionIds, claimedDocumentIds, rejectedPairs }
}

/**
 * Owner to hang the staged operation on.
 *
 * `pending_operations.user_id` is NOT NULL and drives who sees the proposal.
 * Falling back to any member rather than failing keeps single-admin companies
 * working; a company with no members has nobody to ask and is skipped.
 */
async function resolveOwnerUserId(
  supabase: SupabaseClient,
  companyId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from('company_members')
    .select('user_id, role')
    .eq('company_id', companyId)
    .order('role', { ascending: true })
    .limit(50)
  if (!data || data.length === 0) return null
  const owner = (data as Array<{ user_id: string; role: string }>).find((m) => m.role === 'owner')
  return owner?.user_id ?? (data[0] as { user_id: string }).user_id
}

function buildTitle(proposal: HuntProposal, fileName: string, tx: HuntTransaction): string {
  const counterparty = proposal.merchant_name || tx.merchant_name || tx.description || 'okänd motpart'
  return `Koppla underlag: ${fileName} → ${counterparty}`
}

/**
 * Preview payload for `AttachDocumentPreview`.
 *
 * `existing_document_is_rakenskapsinformation` is set explicitly even though
 * these transactions have no document: the component treats an absent value as
 * potentially destructive, which would put a warning on a proposal that
 * overwrites nothing.
 */
function buildPreview(
  proposal: HuntProposal,
  fileName: string,
  tx: HuntTransaction,
): Record<string, unknown> {
  return {
    transaction_description: tx.description,
    transaction_amount: tx.amount,
    transaction_currency: tx.currency ?? 'SEK',
    transaction_date: tx.date,
    document_file_name: fileName,
    document_vendor_name: proposal.merchant_name,
    document_amount: proposal.total_amount,
    document_currency: proposal.currency,
    document_invoice_date: proposal.receipt_date,
    will_overwrite_existing: false,
    existing_document_file_name: null,
    existing_document_is_rakenskapsinformation: false,
    match_confidence: proposal.confidence,
    match_reasons: proposal.matchReasons,
  }
}

/**
 * Hunt one company. Returns what it looked at and what it proposed.
 *
 * `runId` ties every proposal from one night together so a run can be read back
 * (and, later, replayed) from `agent_metadata`.
 */
export async function huntCompany(
  supabase: SupabaseClient,
  companyId: string,
  runId: string,
  options: HuntOptions = {},
): Promise<HuntCompanyResult> {
  const {
    limit = MAX_PROPOSALS_PER_RUN,
    dryRun = false,
  } = options

  const [transactions, suppression] = await Promise.all([
    fetchCandidateTransactions(supabase, companyId),
    fetchSuppression(supabase, companyId),
  ])
  if (transactions.length === 0) {
    return { companyId, candidates: 0, poolSize: 0, proposed: 0 }
  }

  // Ingesting a receipt needs an owner to attribute the document to.
  const userId = await resolveOwnerUserId(supabase, companyId)

  const { pool: rawPool, fileNames } = await fetchPool(supabase, companyId)

  // A receipt in USD or EUR carries a number the bank statement never shows.
  // Resolving it into kronor is what lets the ordinary matcher weigh the
  // amount at all; without it those pairs are refused, which on a SaaS-heavy
  // ledger is most of them.
  const pool = await attachSekTotals(supabase, rawPool)

  const base: HuntCompanyResult = {
    companyId,
    candidates: transactions.length,
    poolSize: pool.length,
    proposed: 0,
  }
  if (pool.length === 0) return base

  // Collect the whole band the formula can speak to, then split it: what it is
  // sure of goes straight through, what it is not gets a second opinion.
  const scored = selectProposals(transactions, pool, suppression, limit, UNCERTAIN_FLOOR)
  const certain = scored.filter((p) => p.confidence >= CERTAIN_CONFIDENCE)
  const uncertain = scored.filter((p) => p.confidence < CERTAIN_CONFIDENCE)

  // Adjudicated on a dry run too. A provkörning is supposed to show exactly
  // what a real run would propose, and skipping the second opinion would show
  // a different, smaller answer than the one that lands.
  const byIdForPairs = new Map(transactions.map((t) => [t.id, t]))
  const verdicts = await adjudicate(
        uncertain.map((p) => {
          const tx = byIdForPairs.get(p.transaction_id) as HuntTransaction
          return {
            key: `${p.transaction_id}::${p.document_id}`,
            purchase: {
              description: tx.merchant_name || tx.description || '',
              amount: Math.abs(tx.amount ?? 0),
              currency: tx.currency ?? 'SEK',
              date: tx.date ?? '',
            },
            receipt: {
              vendor: p.merchant_name,
              total: p.total_amount,
              currency: p.currency,
              sekTotal: p.sek_total ?? null,
              date: p.receipt_date,
              fileName: fileNames.get(p.document_id) ?? null,
            },
            confidence: p.confidence,
            matchReasons: p.matchReasons,
      }
    }),
  )

  const accepted = new Map(verdicts.map((v) => [v.key, v.reason]))
  const adjudicated = uncertain
    .filter((p) => accepted.has(`${p.transaction_id}::${p.document_id}`))
    .map((p) => ({
      ...p,
      // The verdict replaces the arithmetic's reasons, because it is what a
      // human is being asked to check. The score stays as the formula computed
      // it, unflattered: it is a real record of what the arithmetic made of
      // the pair, and dressing it up would hide the very uncertainty that sent
      // the pair for a second opinion.
      matchReasons: [accepted.get(`${p.transaction_id}::${p.document_id}`) as string],
      wasAdjudicated: true,
    }))

  const proposals = [...certain, ...adjudicated]
  if (proposals.length === 0) return base
  if (dryRun) return { ...base, proposed: proposals.length, proposals }
  if (!userId) return { ...base, skippedNoOwner: true }

  const byId = new Map(transactions.map((t) => [t.id, t]))
  const riskLevel = getRiskLevel(OPERATION_TYPE)

  const rows = proposals.map((proposal) => {
    const tx = byId.get(proposal.transaction_id) as HuntTransaction
    const fileName = fileNames.get(proposal.document_id) ?? 'underlag'
    return {
      company_id: companyId,
      user_id: userId,
      operation_type: OPERATION_TYPE,
      title: buildTitle(proposal, fileName, tx),
      params: {
        transaction_id: proposal.transaction_id,
        document_id: proposal.document_id,
      },
      preview_data: {
        ...buildPreview(proposal, fileName, tx),
      },
      actor_type: 'cron',
      actor_label: HUNT_ACTOR_LABEL,
      risk_level: riskLevel,
      agent_metadata: {
        source: 'receipt_hunt',
        run_id: runId,
        inbox_item_id: proposal.inbox_item_id,
        confidence: proposal.confidence,
        match_reasons: proposal.matchReasons,
        // Which instrument decided: the arithmetic alone, or a second opinion
        // on a pair the arithmetic could not settle.
        decided_by: proposal.wasAdjudicated ? 'adjudicator' : 'matcher',
      },
    }
  })

  const { error } = await supabase.from('pending_operations').insert(rows)
  if (error) throw new Error(`Failed to stage receipt-hunt proposals: ${error.message}`)

  return { ...base, proposed: rows.length }
}

/**
 * Companies the hunt may run for.
 *
 * An explicit allowlist while the feature is piloted, and fail-safe by
 * construction: an unset variable hunts nobody rather than everybody.
 */
export function resolveAllowlist(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
}
