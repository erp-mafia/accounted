/**
 * Periodic reconciliation of inbox items stranded on booked transactions
 * (#1548, the follow-up to the 2026-08-12 "booked items stuck in Att göra"
 * fix).
 *
 * An item whose matched transaction is booked should have its document
 * anchored to that verifikat (BFL 5 kap 6-7 §) and, where the UNIQUE
 * created_journal_entry_id allows, carry the stamp. Two things leave an
 * item behind that only a re-run repairs or a human resolves:
 *
 *  - transient: linkToJournalEntry failed at propagation time (a DB blip).
 *    Re-running the same propagation links it.
 *  - locked: the verifikat sits in a closed or locked period, so the link is
 *    rejected by enforce_period_lock_documents every time. Counted, not
 *    retried: only unlocking the period (or a human) resolves it.
 *  - permanent: the item's document is already anchored to a DIFFERENT
 *    verifikat. Never stolen; the run counts and logs it so it is visible
 *    outside ad-hoc log greps, and the inbox keeps the item in "Att göra"
 *    (underlag_status enrichment) until someone decides.
 *
 * The scan reads every matched, unconsumed item (cheap: four columns per
 * row) and bounds the WORK instead: at most `maxItems` unlinked items are
 * linked per run. Capping the read would starve the tail: healthy matched
 * items and samlingsverifikat siblings never leave the candidate set, so a
 * read cap keyed on id would revisit the same window every night.
 *
 * This is the one implementation the daily cron
 * (app/api/extensions/invoice-inbox/underlag-reconcile/cron) and the manual
 * script (scripts/backfill-inbox-booked-underlag.ts) share. It never throws:
 * a failing company is counted and the rest of the run continues.
 *
 * Behandlingshistorik (BFNAR 2013:2 kap 8): a run that changed the
 * underlag-to-verifikat linkage appends one 'InboxUnderlagReconciled' event
 * per repaired transaction, distinguishing the repair from the original
 * booking. Only genuinely repaired transactions get an event: stamping an
 * already-anchored item is a display fast path, not a linkage change.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { appendProcessingHistoryWithClient } from '@/lib/processing-history/append'
import { createLogger, type Logger } from '@/lib/logger'
import {
  propagateUnderlagForBookedTransaction,
  resolveBookedJournalEntryIds,
  resolveUnderlagAnchoring,
  type UnderlagAnchoringResult,
} from '@/lib/transactions/inbox-underlag'

/** Registered in processing_event_types by migration 20260828154800. */
export const INBOX_UNDERLAG_RECONCILED_EVENT = 'InboxUnderlagReconciled'

/** Default actor id in behandlingshistorik when the caller names none. */
export const DEFAULT_RECONCILE_ACTOR_ID = 'inbox-underlag-reconcile'

/** Link budget per run (unlinked items propagated) so a scheduled pass stays bounded. */
export const DEFAULT_RECONCILE_MAX_ITEMS = 1000

const PAGE_SIZE = 1000

export interface ReconcileStrandedInboxUnderlagOptions {
  /** false: classify only, no writes (the script's dry-run). */
  execute: boolean
  /** Link at most this many unlinked items per run (default 1000); the rest wait for the next run. */
  maxItems?: number
  log?: Logger
  /** Who the behandlingshistorik event is attributed to. */
  actorId?: string
}

export interface ReconcileStrandedInboxUnderlagSummary {
  execute: boolean
  /** Matched, unconsumed items read (across all companies, uncapped). */
  scanned: number
  /** True when more unlinked items existed than maxItems allowed this run to link. */
  truncated: boolean
  /** Scanned items whose matched transaction resolves as booked. */
  strandedOnBooked: number
  /** execute only: items whose underlag was unlinked before and anchored after this run. */
  repaired: number
  /** Items whose underlag already referenced the verifikat (only the stamp was missing). */
  alreadyAnchored: number
  /**
   * Items whose underlag references no verifikat. execute: the link failed
   * again this run (transient, retried next run). dry-run: what a run would
   * link.
   */
  stillUnlinked: number
  /** Unlinked items whose verifikat sits in a locked/closed period: the link cannot land until it is unlocked. */
  unlinkedLocked: number
  /** Unlinked items left for the next run because this run's link budget (maxItems) was spent. */
  deferred: number
  /** Items whose document is anchored to another verifikat: a human decision. */
  anchoredElsewhere: number
  companiesTouched: number
  /** 'InboxUnderlagReconciled' events written (one per repaired transaction). */
  historyAppended: number
  /** Companies (or the initial scan) that threw; the run continued past them. */
  failures: number
}

interface StrandedItem {
  id: string
  company_id: string
  matched_transaction_id: string
  document_id: string | null
}

function emptySummary(execute: boolean): ReconcileStrandedInboxUnderlagSummary {
  return {
    execute,
    scanned: 0,
    truncated: false,
    strandedOnBooked: 0,
    repaired: 0,
    alreadyAnchored: 0,
    stillUnlinked: 0,
    unlinkedLocked: 0,
    deferred: 0,
    anchoredElsewhere: 0,
    companiesTouched: 0,
    historyAppended: 0,
    failures: 0,
  }
}

/**
 * The backfill script's query: matched to a transaction, consumed by neither
 * a journal entry nor a supplier invoice. Ordered by id for stable paging
 * and read in full: the per-run bound is on links, not on rows read.
 */
async function fetchStrandedCandidates(supabase: SupabaseClient): Promise<StrandedItem[]> {
  const rows: StrandedItem[] = []
  let from = 0
  for (;;) {
    const to = from + PAGE_SIZE - 1
    const { data, error } = await supabase
      .from('invoice_inbox_items')
      .select('id, company_id, matched_transaction_id, document_id')
      .not('matched_transaction_id', 'is', null)
      .is('created_journal_entry_id', null)
      .is('created_supplier_invoice_id', null)
      .order('id', { ascending: true })
      .range(from, to)
    if (error) throw new Error(error.message)
    const page = (data ?? []) as StrandedItem[]
    rows.push(...page)
    if (page.length < PAGE_SIZE) break
    from = to + 1
  }
  return rows
}

export async function reconcileStrandedInboxUnderlag(
  supabase: SupabaseClient,
  opts: ReconcileStrandedInboxUnderlagOptions,
): Promise<ReconcileStrandedInboxUnderlagSummary> {
  const log = opts.log ?? createLogger('transactions/inbox-underlag-reconcile')
  const maxItems = opts.maxItems ?? DEFAULT_RECONCILE_MAX_ITEMS
  const actorId = opts.actorId ?? DEFAULT_RECONCILE_ACTOR_ID
  const summary = emptySummary(opts.execute)

  let candidates: StrandedItem[]
  try {
    candidates = await fetchStrandedCandidates(supabase)
  } catch (err) {
    log.error('inbox underlag reconcile: failed to read matched inbox items', {
      error: err instanceof Error ? err.message : String(err),
    })
    summary.failures++
    return summary
  }
  summary.scanned = candidates.length

  // Group per company so the resolvers run one batched lookup per tenant.
  const byCompany = new Map<string, StrandedItem[]>()
  for (const item of candidates) {
    const list = byCompany.get(item.company_id) ?? []
    list.push(item)
    byCompany.set(item.company_id, list)
  }

  const run = { execute: opts.execute, actorId, log, summary, budget: maxItems }
  for (const [companyId, companyItems] of byCompany) {
    try {
      await reconcileCompany(supabase, companyId, companyItems, run)
    } catch (err) {
      summary.failures++
      log.error('inbox underlag reconcile: company failed', {
        company_id: companyId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  if (summary.truncated) {
    log.warn('inbox underlag reconcile: link budget spent; unlinked items deferred to the next run', {
      max_items: maxItems,
      deferred: summary.deferred,
    })
  }

  return summary
}

/** Per-run state shared by every company: the counters and the remaining link budget. */
interface RunState {
  execute: boolean
  actorId: string
  log: Logger
  summary: ReconcileStrandedInboxUnderlagSummary
  /** Unlinked items this run may still propagate; decremented as work is claimed. */
  budget: number
}

/** Whether an item needs (and may benefit from) a propagation: unlinked, or unreadable. */
function needsLink(before: UnderlagAnchoringResult | undefined): boolean {
  return before === undefined || before.status === 'unlinked'
}

async function reconcileCompany(
  supabase: SupabaseClient,
  companyId: string,
  companyItems: StrandedItem[],
  run: RunState,
): Promise<void> {
  const { summary, log } = run
  const txIds = Array.from(new Set(companyItems.map((i) => i.matched_transaction_id)))
  const bookedByTx = await resolveBookedJournalEntryIds(supabase, companyId, txIds)
  const stranded = companyItems.filter((i) => bookedByTx.has(i.matched_transaction_id))
  if (stranded.length === 0) return

  summary.companiesTouched++
  summary.strandedOnBooked += stranded.length

  const anchoringInput = stranded.map((i) => ({
    id: i.id,
    document_id: i.document_id,
    journalEntryId: bookedByTx.get(i.matched_transaction_id) as string,
  }))
  const before = await resolveUnderlagAnchoring(supabase, companyId, anchoringInput)

  // Only unlinked (or unreadable) items claim budget and get a propagation.
  // Already-anchored siblings, anchored-elsewhere conflicts and locked
  // periods are counted straight from the pre-state: re-propagating them
  // would either no-op or fail identically, and letting them consume the
  // budget is what would starve the real work.
  const toLink = new Set<string>()
  for (const item of stranded) {
    if (!needsLink(before.get(item.id))) continue
    if (run.budget <= 0) {
      summary.deferred++
      summary.truncated = true
      continue
    }
    run.budget--
    toLink.add(item.id)
  }

  if (!run.execute) {
    for (const item of stranded) {
      if (summaryDeferred(item, before, toLink)) continue
      classify(item, before.get(item.id), null, run, companyId)
    }
    return
  }

  const txIdsToComplete = Array.from(
    new Set(stranded.filter((i) => toLink.has(i.id)).map((i) => i.matched_transaction_id)),
  )
  for (const txId of txIdsToComplete) {
    const journalEntryId = bookedByTx.get(txId)
    if (!journalEntryId) continue
    await propagateUnderlagForBookedTransaction(supabase, companyId, txId, journalEntryId)
  }

  const after =
    toLink.size > 0
      ? await resolveUnderlagAnchoring(
          supabase,
          companyId,
          anchoringInput.filter((i) => toLink.has(i.id)),
        )
      : new Map<string, UnderlagAnchoringResult>()
  const repairedByTx = new Map<string, string[]>()
  for (const item of stranded) {
    if (summaryDeferred(item, before, toLink)) continue
    // Items outside this run's link work keep their pre-state verdict.
    const verdict = toLink.has(item.id) ? after.get(item.id) : before.get(item.id)
    const repaired = classify(item, before.get(item.id), verdict, run, companyId)
    if (repaired) {
      const list = repairedByTx.get(item.matched_transaction_id) ?? []
      list.push(item.id)
      repairedByTx.set(item.matched_transaction_id, list)
    }
  }

  for (const [txId, itemIds] of repairedByTx) {
    const journalEntryId = bookedByTx.get(txId) as string
    try {
      await appendProcessingHistoryWithClient(supabase, {
        companyId,
        correlationId: txId,
        aggregateType: 'BankTransaction',
        aggregateId: txId,
        eventType: INBOX_UNDERLAG_RECONCILED_EVENT,
        payload: {
          transaction_id: txId,
          journal_entry_id: journalEntryId,
          inbox_item_ids: itemIds,
          source: run.actorId,
        },
        actor: { type: 'system', id: run.actorId },
        occurredAt: new Date(),
      })
      summary.historyAppended++
    } catch (err) {
      // The repair itself is done; a missing changelog row is a logged gap,
      // not a reason to fail the run.
      log.error('inbox underlag reconcile: processing_history append failed', {
        company_id: companyId,
        transaction_id: txId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}

/** True for an item that needed a link but fell outside this run's budget (already counted as deferred). */
function summaryDeferred(
  item: StrandedItem,
  before: Map<string, UnderlagAnchoringResult>,
  toLink: Set<string>,
): boolean {
  return needsLink(before.get(item.id)) && !toLink.has(item.id)
}

/**
 * Count one item into the summary. `after` is null on a dry-run (the
 * pre-state is the verdict). Returns true when this run linked the
 * underlag: explicitly unlinked before, anchored after. An unreadable
 * pre-state that reads anchored afterwards is not a repair this run can
 * vouch for, so it earns no behandlingshistorik event.
 */
function classify(
  item: StrandedItem,
  before: UnderlagAnchoringResult | undefined,
  after: UnderlagAnchoringResult | null | undefined,
  run: { execute: boolean; log: Logger; summary: ReconcileStrandedInboxUnderlagSummary },
  companyId: string,
): boolean {
  const { summary, log } = run
  // An unreadable document row is unknown, never settled: it stays counted
  // as unlinked so the next run looks again.
  const verdict = (run.execute ? after : before) ?? {
    status: 'unlinked' as const,
    document_journal_entry_id: null,
  }
  const context = {
    company_id: companyId,
    inbox_item_id: item.id,
    transaction_id: item.matched_transaction_id,
    document_id: item.document_id,
  }
  switch (verdict.status) {
    case 'anchored': {
      if (
        run.execute &&
        (before?.status === 'unlinked' || before?.status === 'unlinked_locked')
      ) {
        summary.repaired++
        return true
      }
      summary.alreadyAnchored++
      return false
    }
    case 'unlinked': {
      summary.stillUnlinked++
      log.warn(
        run.execute
          ? 'inbox underlag reconcile: document still unlinked after re-run'
          : 'inbox underlag reconcile: document unlinked (would link)',
        context,
      )
      return false
    }
    case 'unlinked_locked': {
      summary.unlinkedLocked++
      log.warn('inbox underlag reconcile: document unlinked and its verifikat sits in a locked period; unlock to link', context)
      return false
    }
    case 'anchored_elsewhere': {
      summary.anchoredElsewhere++
      log.warn('inbox underlag reconcile: document anchored to another verifikat; needs a human', {
        ...context,
        document_journal_entry_id: verdict.document_journal_entry_id,
      })
      return false
    }
  }
}
