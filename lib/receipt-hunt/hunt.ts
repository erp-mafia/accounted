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
import { getMailSearchService } from '@/lib/mail-search/service'
import { ingestMailCandidate } from './ingest'
import { normalizeForMatch } from '@/lib/documents/core-receipt-matcher'
import {
  assignReceipts,
  planMerchantGroups,
  type PurchaseDescriptor,
} from './mail-intelligence'
import {
  MAX_PROPOSALS_PER_RUN,
  canHaveEmailReceipt,
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

/**
 * Purchases to search the mailboxes for in one run.
 *
 * Each search is a provider round-trip per connected mailbox, so this bounds
 * both latency and API quota. Largest amounts go first, and the rest wait for
 * tomorrow night rather than being dropped.
 */
export const MAX_MAIL_SEARCHES_PER_RUN = 15

/**
 * Hits pulled per merchant before the model is asked to choose.
 *
 * A merchant-name search without a date window is broad on purpose, so this is
 * the budget for that breadth: enough that the right receipt is in the set,
 * few enough that one review call can weigh them all.
 */
export const MAX_CANDIDATES_PER_MERCHANT = 12

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
  /** What the mailbox search found, when a mail connection exists. */
  mail?: MailHuntSummary
}

export interface MailHuntSummary {
  /** Purchases we searched the mailboxes for. */
  searched: number
  /** Purchases where at least one message looked like it could be the receipt. */
  withCandidates: number
  /** Receipts actually fetched and filed as underlag, ready to be paired. */
  ingested: number
  candidates: Array<{
    transactionId: string
    merchant: string | null
    amount: number
    mailbox: string
    subject: string | null
    from: string | null
    receivedAt: string | null
    attachmentCount: number
    bodyIsReceipt: boolean
    /** Merchant the model resolved the bank descriptor to. */
    brand?: string
    /** How sure the model was that this mail is the receipt for this charge. */
    confidence?: number
    /** Why, in one sentence, for the human who approves it. */
    reason?: string
  }>
}

export interface HuntOptions {
  limit?: number
  /**
   * Also search connected mailboxes for the purchases nothing in Underlag
   * could explain. Off by default so the nightly sweep's cost stays opt-in
   * while the connector is piloted.
   */
  searchMail?: boolean
  /** How many unexplained purchases to search mail for in one run. */
  mailSearchLimit?: number
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

/** Purchases with no receipt that nobody has booked yet. */
async function fetchCandidateTransactions(
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
  const rejectedPairs = new Set<string>()
  for (const row of rows) {
    const txId = row.params?.transaction_id
    const docId = row.params?.document_id
    if (!txId) continue
    if (row.status === 'rejected') {
      if (docId) rejectedPairs.add(pairKey(txId, docId))
    } else {
      claimedTransactionIds.add(txId)
    }
  }
  return { claimedTransactionIds, rejectedPairs }
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
    searchMail = false,
    mailSearchLimit = MAX_MAIL_SEARCHES_PER_RUN,
  } = options
  const [transactions, { pool, fileNames }, suppression] = await Promise.all([
    fetchCandidateTransactions(supabase, companyId),
    fetchPool(supabase, companyId),
    fetchSuppression(supabase, companyId),
  ])

  const base: HuntCompanyResult = {
    companyId,
    candidates: transactions.length,
    poolSize: pool.length,
    proposed: 0,
  }
  if (transactions.length === 0 || pool.length === 0) return base

  const proposals = selectProposals(transactions, pool, suppression, limit)

  // Resolved before the mail leg, because ingesting a receipt needs an owner to
  // attribute the document to.
  const userId = await resolveOwnerUserId(supabase, companyId)

  // Mail is searched only for what Underlag could NOT explain: a purchase that
  // already has a receipt in hand needs no mailbox read, and not reading is the
  // privacy promise the consent screen makes.
  const explained = new Set(proposals.map((p) => p.transaction_id))
  const mailLeg = searchMail
    ? await searchMailForUnexplained(
        supabase,
        companyId,
        userId,
        transactions.filter((t) => !explained.has(t.id) && !suppression.claimedTransactionIds.has(t.id)),
        mailSearchLimit,
        dryRun,
      )
    : { summary: undefined, proposals: [] as MailProposal[] }
  const mail = mailLeg.summary

  const totalProposals = proposals.length + mailLeg.proposals.length
  if (totalProposals === 0) return { ...base, mail }
  if (dryRun) return { ...base, proposed: proposals.length, proposals, mail }

  if (!userId) return { ...base, skippedNoOwner: true, mail }

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
      preview_data: buildPreview(proposal, fileName, tx),
      actor_type: 'cron',
      actor_label: HUNT_ACTOR_LABEL,
      risk_level: riskLevel,
      agent_metadata: {
        source: 'receipt_hunt',
        run_id: runId,
        inbox_item_id: proposal.inbox_item_id,
        confidence: proposal.confidence,
        match_reasons: proposal.matchReasons,
      },
    }
  })

  // Receipts fetched out of a mailbox this run. Same operation type and the
  // same human gate; what differs is the evidence, which names the mailbox and
  // the message instead of a similarity score.
  const mailRows = mailLeg.proposals.map((proposal) => {
    const tx = byId.get(proposal.transactionId) as HuntTransaction
    return {
      company_id: companyId,
      user_id: userId,
      operation_type: OPERATION_TYPE,
      title: `Koppla underlag: ${proposal.fileName} → ${tx.merchant_name || tx.description || 'köp'}`,
      params: {
        transaction_id: proposal.transactionId,
        document_id: proposal.documentId,
      },
      preview_data: {
        transaction_description: tx.description,
        transaction_amount: tx.amount,
        transaction_currency: tx.currency ?? 'SEK',
        transaction_date: tx.date,
        document_file_name: proposal.fileName,
        document_vendor_name: proposal.from,
        document_amount: null,
        document_currency: null,
        document_invoice_date: proposal.receivedAt,
        will_overwrite_existing: false,
        existing_document_file_name: null,
        existing_document_is_rakenskapsinformation: false,
        // What the user needs to judge it: where it came from and why we looked.
        mail_mailbox: proposal.mailbox,
        mail_subject: proposal.subject,
        mail_from: proposal.from,
        // The reason in words, so approving is checking an argument rather
        // than trusting a number.
        mail_match_reason: proposal.reason,
      },
      actor_type: 'cron',
      actor_label: HUNT_ACTOR_LABEL,
      risk_level: riskLevel,
      agent_metadata: {
        source: 'receipt_hunt_mail',
        run_id: runId,
        inbox_item_id: proposal.inboxItemId,
        mailbox: proposal.mailbox,
        mail_subject: proposal.subject,
        confidence: proposal.confidence,
        match_reasons: [proposal.reason],
      },
    }
  })

  const allRows = [...rows, ...mailRows]
  const { error } = await supabase.from('pending_operations').insert(allRows)
  if (error) throw new Error(`Failed to stage receipt-hunt proposals: ${error.message}`)

  return { ...base, proposed: allRows.length, mail }
}

/** A receipt pulled out of a mailbox, already filed and awaiting its pairing. */
interface MailProposal {
  transactionId: string
  documentId: string
  inboxItemId: string
  fileName: string
  mailbox: string
  subject: string | null
  from: string | null
  receivedAt: string | null
  /** The model's own confidence and its one-sentence reason, shown to the human. */
  confidence: number
  reason: string
}

/**
 * Ask the connected mailboxes about purchases nothing in Underlag explained.
 *
 * Read-only and bounded: the largest amounts first, capped per run, and the
 * whole thing degrades to an empty summary when no mail extension is loaded or
 * no mailbox is connected. Finding a candidate is NOT the same as having the
 * receipt: ingesting it is the next step and stays behind human approval.
 */
async function searchMailForUnexplained(
  supabase: SupabaseClient,
  companyId: string,
  userId: string | null,
  unexplained: readonly HuntTransaction[],
  limit: number,
  dryRun: boolean,
): Promise<{ summary: MailHuntSummary; proposals: MailProposal[] }> {
  const service = getMailSearchService()
  const summary: MailHuntSummary = { searched: 0, withCandidates: 0, ingested: 0, candidates: [] }
  const proposals: MailProposal[] = []
  if (!service.isConfigured() || unexplained.length === 0) return { summary, proposals }

  // Salary and tax runs are a company's largest outgoing rows, so without this
  // they eat the whole search budget hunting receipts that cannot exist, and
  // their descriptions ("Lön Juli Jakob") search for a person's name and match
  // half the mailbox.
  const byLargest = [...unexplained]
    .filter((t) => canHaveEmailReceipt(t.merchant_name || t.description))
    .sort((a, b) => Math.abs(b.amount ?? 0) - Math.abs(a.amount ?? 0))
    .slice(0, limit)
    .filter((t): t is HuntTransaction & { amount: number; date: string } =>
      t.amount != null && Boolean(t.date),
    )
  if (byLargest.length === 0) return { summary, proposals }

  const descriptors: PurchaseDescriptor[] = byLargest.map((t) => ({
    id: t.id,
    description: t.merchant_name || t.description || '',
    amount: Math.abs(t.amount),
    currency: t.currency ?? 'SEK',
    date: t.date,
  }))
  const byId = new Map(byLargest.map((t) => [t.id, t]))
  const descriptorById = new Map(descriptors.map((d) => [d.id, d]))

  // One model call resolves every descriptor to a merchant and groups the
  // repeats. Six Anthropic subscriptions become one search and one decision
  // instead of six of each, which is both cheaper and more accurate: the model
  // can use the constraint that each receipt belongs to exactly one charge.
  const groups = await planMerchantGroups(descriptors)

  for (const group of groups) {
    const members = group.transactionIds
      .map((id) => descriptorById.get(id))
      .filter((d): d is PurchaseDescriptor => d != null)
    if (members.length === 0) continue
    summary.searched += members.length

    // Searched on the merchant's name across the whole mailbox. The date window
    // is deliberately off: these receipts arrive by being forwarded, so they
    // carry the forwarding date. Precision is restored by the model below, not
    // by the query.
    const newest = members.reduce((a, b) => (a.date > b.date ? a : b))
    const found = await service.search(companyId, {
      merchant: normalizeForMatch(members[0].description),
      amount: members[0].amount,
      currency: members[0].currency,
      date: newest.date,
      aliases: group.aliases,
      useDateWindow: false,
      limit: MAX_CANDIDATES_PER_MERCHANT,
    })
    if (found.length === 0) continue

    const assignments = await assignReceipts(
      group.brand,
      members,
      found.map((c) => ({
        messageId: c.messageId,
        mailbox: c.mailbox,
        subject: c.subject,
        from: c.from,
        receivedAt: c.receivedAt,
        snippet: c.snippet ?? null,
        attachmentNames: c.attachmentNames ?? [],
      })),
    )
    if (assignments.length === 0) continue
    summary.withCandidates += assignments.length

    const foundById = new Map(found.map((c) => [c.messageId, c]))
    for (const assignment of assignments) {
      const candidate = foundById.get(assignment.messageId)
      const tx = byId.get(assignment.transactionId)
      if (!candidate || !tx) continue

      summary.candidates.push({
        transactionId: tx.id,
        merchant: tx.merchant_name || tx.description,
        amount: tx.amount,
        mailbox: candidate.mailbox,
        subject: candidate.subject,
        from: candidate.from,
        receivedAt: candidate.receivedAt,
        attachmentCount: candidate.attachmentIds.length,
        bodyIsReceipt: candidate.bodyIsReceipt,
        brand: group.brand,
        confidence: assignment.confidence,
        reason: assignment.reason,
      })

      // A dry run reports what it decided and fetches nothing: the point of a
      // provkörning is that no mailbox content is copied anywhere.
      if (dryRun || !userId) continue
      if (candidate.attachmentIds.length === 0) continue

      // Narrow the candidate to the one file the model picked before it is
      // fetched. A batch forward carries receipts for several purchases, so
      // "the message" is not the underlag; the chosen attachment is.
      const names = candidate.attachmentNames ?? []
      const chosen = assignment.attachmentName ? names.indexOf(assignment.attachmentName) : 0
      const index = chosen >= 0 ? chosen : 0
      const ingested = await ingestMailCandidate(supabase, companyId, userId, {
        ...candidate,
        attachmentIds: [candidate.attachmentIds[index] ?? candidate.attachmentIds[0]],
        attachmentNames: [names[index] ?? names[0] ?? ''],
      })
      if (!ingested) continue
      summary.ingested++

      // No re-matching: the model decided this message is the receipt for this
      // charge, and that decision is written onto the proposal in words so the
      // human approving it can check the reasoning rather than a bare score.
      proposals.push({
        transactionId: tx.id,
        documentId: ingested.documentId,
        inboxItemId: ingested.inboxItemId,
        fileName: ingested.fileName,
        mailbox: ingested.mailbox,
        subject: candidate.subject,
        from: candidate.from,
        receivedAt: candidate.receivedAt,
        confidence: assignment.confidence,
        reason: assignment.reason,
      })
    }
  }
  return { summary, proposals }
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
