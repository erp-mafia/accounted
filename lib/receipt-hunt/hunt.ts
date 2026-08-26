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
import { adjudicate } from './adjudicate'
import { attachSekTotals } from './fx'
import { extractMailDocuments } from './mail-intelligence'
import {
  CERTAIN_CONFIDENCE,
  MAX_PROPOSALS_PER_RUN,
  UNCERTAIN_FLOOR,
  canHaveEmailReceipt,
  receiptIdentity,
  worthFetching,
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
 * Deliberately generous. The lesson from production email search is that recall
 * is won by loosening retrieval and letting the model filter, not by tightening
 * the query: a hit that never gets retrieved cannot be recovered downstream,
 * while an irrelevant one is cheap to reject.
 */
export const MAX_CANDIDATES_PER_MERCHANT = 25

/**
 * Receipts fetched in one run.
 *
 * A cap on how much of a mailbox can land in Underlag on any one night, not a
 * judgement about what is worth having: a company that pays the same supplier
 * monthly genuinely has twelve receipts, and the rest wait for tomorrow.
 */
export const MAX_RECEIPTS_PER_RUN = (() => {
  const parsed = Number(process.env.RECEIPT_HUNT_MAX_RECEIPTS)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 25
})()

/**
 * Mails read by the model in one run.
 *
 * The searches are deliberately broad and overlap heavily, so this is the real
 * cost boundary: one call carrying this many mail bodies, rather than a call
 * per mail.
 */
export const MAX_MAILS_READ_PER_RUN = (() => {
  const parsed = Number(process.env.RECEIPT_HUNT_MAX_MAILS)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 40
})()

/**
 * Mails per extraction call.
 *
 * The model reads bodies, so a single call carrying 150 of them would be both
 * enormous and fragile: one malformed reply loses the whole sweep. Chunking
 * keeps each call small enough to be reliable and lets a backfill read a whole
 * mailbox, which a first run on an existing company needs.
 */
export const MAILS_PER_EXTRACTION_CALL = 25

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
  /** Purchases whose merchant we searched the mailboxes for. */
  searched: number
  /** Documents the model judged to be an underlag. */
  withCandidates: number
  /** Receipts actually fetched and filed, ready for the amount match. */
  ingested: number
  /**
   * Connections that refused a search during this run.
   *
   * Non-zero means "we could not read a mailbox", which is not the same as
   * "the mailbox held nothing". The caller must not report the second when the
   * first happened, and must not treat the run as finished.
   */
  searchFailures: number
  candidates: Array<{
    /** Merchant the model resolved the bank descriptor to. */
    merchant: string
    mailbox: string
    subject: string | null
    from: string | null
    receivedAt: string | null
    /** The attachment chosen as the underlag. */
    fileName: string | null
    /** What the model says the document is. */
    reason: string
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
   * Mails read in one run, overriding the environment default.
   *
   * The cap is what bounds cost, and it interacts with the largest-first
   * ordering: a low cap spends the whole budget on the biggest purchases,
   * which on a real ledger are the least likely to have a findable receipt.
   */
  maxMails?: number
  /**
   * Receipts fetched in one run, overriding the environment default.
   *
   * A person pressing a button wants a pass that ends, reports, and can be
   * repeated. The nightly default is a different budget from a manual one.
   */
  maxReceipts?: number
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
    searchMail = false,
    mailSearchLimit = MAX_MAIL_SEARCHES_PER_RUN,
    maxReceipts = MAX_RECEIPTS_PER_RUN,
    maxMails = MAX_MAILS_READ_PER_RUN,
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

  // Mail is harvested BEFORE the pool is read, so a receipt fetched tonight is
  // paired tonight rather than a night later.
  //
  // The mailbox leg only finds documents; it does not decide what they belong
  // to. That question needs the amount, and the amount is inside the PDF, not
  // in a Gmail preview. So the receipt is filed, the extraction that already
  // runs on upload reads its amount, and the pairing below is the same
  // deterministic amount-and-merchant match used for every other underlag.
  let mail: MailHuntSummary | undefined
  if (searchMail) {
    try {
      mail = await harvestReceiptsFromMail(
        supabase,
        companyId,
        userId,
        transactions.filter((t) => !suppression.claimedTransactionIds.has(t.id)),
        mailSearchLimit,
        dryRun,
        maxReceipts,
        maxMails,
      )
    } finally {
      // Cached messages carry their bodies. A body is read to extract fields
      // and must not outlive the run that read it, including when the run
      // fails partway.
      getMailSearchService().releaseCache?.()
    }
  }

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
    mail,
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
    const hunted = proposal.mailProvenance != null
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
        // Where it came from, when the hunt fetched it out of a mailbox. The
        // reviewer should be able to see that this document was not uploaded
        // by a human without having to go looking.
        mail_mailbox: proposal.mailProvenance?.mailbox,
        mail_subject: proposal.mailProvenance?.subject,
        mail_from: proposal.mailProvenance?.from,
      },
      actor_type: 'cron',
      actor_label: HUNT_ACTOR_LABEL,
      risk_level: riskLevel,
      agent_metadata: {
        source: hunted ? 'receipt_hunt_mail' : 'receipt_hunt',
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
 * Ask the connected mailboxes about purchases nothing in Underlag explained.
 *
 * Read-only and bounded: the largest amounts first, capped per run, and the
 * whole thing degrades to an empty summary when no mail extension is loaded or
 * no mailbox is connected. Finding a candidate is NOT the same as having the
 * receipt: ingesting it is the next step and stays behind human approval.
 */
/**
 * Vendor and total of every receipt the hunt has already filed.
 *
 * The per-run key only stops duplicates inside one pass. Across passes the
 * check was the message and attachment, which does not recognise the same
 * purchase arriving as an invoice in one mail and a receipt in another: those
 * have different file keys and were fetched twice, filling the pool with
 * identical candidates the matcher then refuses to choose between.
 */
async function fetchAlreadyHeld(
  supabase: SupabaseClient,
  companyId: string,
): Promise<Set<string>> {
  const rows = await fetchAllRows<{ extracted_data: unknown; channel_context: unknown }>((range) =>
    supabase
      .from('invoice_inbox_items')
      .select('extracted_data, channel_context')
      .eq('company_id', companyId)
      .eq('source', 'mail_hunt')
      .order('id', { ascending: true })
      .range(range.from, range.to),
  )

  const held = new Set<string>()
  for (const row of rows) {
    const data = row.extracted_data as
      | {
          supplier?: { name?: string }
          invoice?: { currency?: string; invoiceDate?: string | null }
          totals?: { total?: number }
        }
      | null
    // Prefer the identity written when the receipt was filed: it came from the
    // same reading that the incoming candidate's does, so the two compare
    // exactly. Rows filed before that was stored fall back to the extraction,
    // which is weaker but better than nothing.
    const stored = row.channel_context as { receipt_identity?: string } | null
    if (stored?.receipt_identity) {
      held.add(stored.receipt_identity)
      continue
    }
    const key = receiptIdentity({
      vendor: data?.supplier?.name ?? null,
      amount: data?.totals?.total ?? null,
      currency: data?.invoice?.currency ?? null,
      date: data?.invoice?.invoiceDate ?? null,
    })
    if (key.includes('::file::')) continue
    held.add(key)
  }
  return held
}

async function harvestReceiptsFromMail(
  supabase: SupabaseClient,
  companyId: string,
  userId: string | null,
  purchases: readonly HuntTransaction[],
  limit: number,
  dryRun: boolean,
  maxReceipts: number,
  maxMails: number,
): Promise<MailHuntSummary> {
  const service = getMailSearchService()
  const summary: MailHuntSummary = { searched: 0, withCandidates: 0, ingested: 0, searchFailures: 0, candidates: [] }
  if (!service.isConfigured() || purchases.length === 0) return summary

  // Salary and tax runs are a company's largest outgoing rows, so without this
  // they eat the whole search budget hunting receipts that cannot exist.
  const searchable = [...purchases]
    .filter((t) => canHaveEmailReceipt(t.merchant_name || t.description))
    .sort((a, b) => Math.abs(b.amount ?? 0) - Math.abs(a.amount ?? 0))
    .slice(0, limit)
    .filter((t): t is HuntTransaction & { amount: number; date: string } =>
      t.amount != null && Boolean(t.date),
    )
  if (searchable.length === 0) return summary
  summary.searched = searchable.length

  // Retrieval is deterministic: amount in every format a receipt might write
  // it, OR the merchant tokens left after the bank's noise is stripped. No
  // model is involved in deciding what to search for, because a wrong guess
  // here is invisible and a broad query is cheap.
  const byMessage = new Map<string, Awaited<ReturnType<typeof service.search>>[number]>()
  // Which purchase's search turned each mail up. The query was that purchase's
  // amount or its merchant tokens, so the hit is itself a signal, and it is the
  // only one that survives a supplier the bank and the invoice name differently.
  const retrievedBy = new Map<string, HuntTransaction[]>()
  for (const tx of searchable) {
    const found = await service.search(companyId, {
      merchant: normalizeForMatch(tx.merchant_name || tx.description || ''),
      amount: Math.abs(tx.amount),
      currency: tx.currency ?? 'SEK',
      date: tx.date,
      useDateWindow: false,
      limit: MAX_CANDIDATES_PER_MERCHANT,
    })
    // Accumulated across every merchant searched in this run: one refusal is
    // enough to make "found nothing" a lie.
    summary.searchFailures += service.searchFailureCount?.() ?? 0
    // The same mail answers several purchases from one supplier; it is read once.
    for (const c of found) {
      if (!byMessage.has(c.messageId)) byMessage.set(c.messageId, c)
      const already = retrievedBy.get(c.messageId)
      if (already) already.push(tx)
      else retrievedBy.set(c.messageId, [tx])
    }
  }
  if (byMessage.size === 0) return summary

  const mails = [...byMessage.values()].slice(0, maxMails)
  // Everything read from here on is released in the finally below: mail bodies
  // are read to extract fields and must not outlive this run.
  const toReview = mails.map((c) => ({
    messageId: c.messageId,
    mailbox: c.mailbox,
    subject: c.subject,
    from: c.from,
    receivedAt: c.receivedAt,
    bodyText: c.bodyText ?? null,
    attachmentNames: c.attachmentNames ?? [],
  }))

  // Read in chunks so a sweep over a whole mailbox stays within one model call's
  // useful size, and so one bad reply costs a chunk rather than the run.
  const documents: Awaited<ReturnType<typeof extractMailDocuments>> = []
  for (let i = 0; i < toReview.length; i += MAILS_PER_EXTRACTION_CALL) {
    documents.push(...(await extractMailDocuments(toReview.slice(i, i + MAILS_PER_EXTRACTION_CALL))))
  }
  if (documents.length === 0) return summary

  // The gate before spending a download: the amount when the body stated it,
  // otherwise the vendor and the date. This is not the match. The real amount
  // comes out of the PDF once it is fetched, and the ordinary matcher pairs it
  // on the next few lines of huntCompany like any other underlag.
  const wanted = documents.filter((doc) =>
    worthFetching(doc, searchable, retrievedBy.get(doc.messageId) ?? []),
  )

  // Seeded with what is already filed, so a press spends its budget on
  // documents the company does not have rather than refetching its own.
  const claimedFiles = await fetchAlreadyHeld(supabase, companyId)
  for (const doc of wanted) {
    const candidate = byMessage.get(doc.messageId)
    if (!candidate) continue

    // One underlag per purchase: see receiptIdentity for why neither the
    // filename nor the message identifies anything here.
    const fileKey = receiptIdentity(doc)
    if (claimedFiles.has(fileKey)) continue
    claimedFiles.add(fileKey)
    summary.withCandidates++

    summary.candidates.push({
      merchant: doc.vendor ?? '(okänd)',
      mailbox: candidate.mailbox,
      subject: candidate.subject,
      from: candidate.from,
      receivedAt: candidate.receivedAt,
      fileName: doc.attachmentName,
      reason: `${doc.amount ?? '?'} ${doc.currency ?? ''} ${doc.date ?? 'utan datum'}`,
    })

    // A dry run reports what it decided and fetches nothing: the point of a
    // provkörning is that no mailbox content is copied anywhere.
    if (dryRun || !userId) continue
    if (candidate.attachmentIds.length === 0) continue
    if (summary.ingested >= maxReceipts) break

    const names = candidate.attachmentNames ?? []
    const at = doc.attachmentName ? names.indexOf(doc.attachmentName) : 0
    const index = at >= 0 ? at : 0
    const ingested = await ingestMailCandidate(
      supabase,
      companyId,
      userId,
      {
        ...candidate,
        attachmentIds: [candidate.attachmentIds[index] ?? candidate.attachmentIds[0]],
        attachmentNames: [names[index] ?? names[0] ?? ''],
      },
      fileKey,
    )
    if (ingested) summary.ingested++
  }
  return summary
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
