import { chunk } from '@/lib/utils'
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { fetchEntryLines, type EntryLinesQuery } from '@/lib/bookkeeping/entry-lines'
import { SKATTEKONTO_ACCOUNT } from '@/lib/skatteverket/manual-verifikat-prefill'
import { loadImportedStornoPairs } from '@/lib/skatteverket/skattekonto-cancelled-entries'
import { createLogger } from '@/lib/logger'
import { roundOre } from '@/lib/money'
import { addDaysIso, daysBetweenIso, toIsoDate } from '@/lib/dates/iso'
import {
  LEDGER_BALANCE_STATUSES,
  findOpeningBalanceFloor,
  sumAccountBalance,
  type OpeningBalanceFloor,
} from './gl-balance'
import {
  AWAITING_EXTERNAL_DAYS,
  SKATTEKONTO_ACCOUNT_KEY,
  STALE_AFTER_DAYS,
  type BridgeLine,
  type ReconciliationItem,
  type ReconciliationProposal,
  type ReconciliationStatus,
} from './schemas'

const log = createLogger('reconciliation/skattekonto')

/**
 * Where the skatteverket extension caches the saldo it last fetched. The
 * extension writes it through its settings accessor (extension_data keyed by
 * company + extension + key); core reads the same row directly so this engine
 * works without importing the extension (core must never import
 * `@/extensions/*`).
 */
const SKATTEVERKET_EXTENSION_ID = 'skatteverket'
const BALANCE_SNAPSHOT_KEY = 'skattekonto_balance_snapshot'

/** Per-bucket cap on returned items; counts and totals are always complete. */
const MAX_ITEMS_PER_BUCKET = 500

const ENTRY_ID_CHUNK = 100

type EntryStatus = 'draft' | 'posted' | 'reversed'

interface SkattekontoRow {
  id: string
  transaktionsdatum: string
  forfallodatum: string | null
  transaktionstext: string
  belopp_skatteverket: number | string
  status: 'booked' | 'upcoming'
  journal_entry_id: string | null
  suggested_journal_entry_id: string | null
  is_ignored: boolean | null
}

interface EntryHead {
  id: string
  status: EntryStatus
  voucher_number: number | null
  voucher_series: string | null
  entry_date: string
  description: string | null
  source_type: string | null
  reverses_id: string | null
  reversed_by_id: string | null
}

interface LedgerLineRow {
  debit_amount: number | string | null
  credit_amount: number | string | null
  journal_entries: EntryHead
}

export interface SkattekontoReconciliationOptions {
  /** YYYY-MM-DD used when no snapshot exists and for staleness; defaults to now (UTC). */
  today?: string
  /**
   * Optional window that scopes the ITEM LISTS (what the page shows). The
   * bridge is anchored at the snapshot instant and is never windowed: the
   * saldo is cumulative, so is the ledger. Unmatched rows older than the
   * window are counted in `older_unmatched_count` so a window can never hide
   * work.
   */
  windowFrom?: string | null
  windowTo?: string | null
}

export interface SkattekontoReconciliationItems {
  proposed: ReconciliationItem[]
  unmatched_external: ReconciliationItem[]
  unmatched_ledger: ReconciliationItem[]
  matched: ReconciliationItem[]
  ignored: ReconciliationItem[]
  upcoming: ReconciliationItem[]
}

export interface SkattekontoReconciliationResult extends ReconciliationStatus {
  items: SkattekontoReconciliationItems
  /** Buckets whose item list was capped at MAX_ITEMS_PER_BUCKET. */
  items_truncated: Array<keyof SkattekontoReconciliationItems>
  /** Unmatched rows (either side) dated before windowFrom, when a window was given. */
  older_unmatched_count: number
  /** Ledger read failed: balances and the residual are null, buckets are still listed. */
  ledger_read_failed: boolean
}

function parseFetchedAt(value: unknown): Date | null {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value)
  if (typeof value === 'string') {
    const asNumber = Number(value)
    const d = /^\d+$/.test(value) ? new Date(asNumber) : new Date(value)
    return Number.isNaN(d.getTime()) ? null : d
  }
  return null
}

async function readSnapshot(
  supabase: SupabaseClient,
  companyId: string,
): Promise<{ saldo: number; fetchedAt: Date } | null> {
  const { data, error } = await supabase
    .from('extension_data')
    .select('value')
    .eq('company_id', companyId)
    .eq('extension_id', SKATTEVERKET_EXTENSION_ID)
    .eq('key', BALANCE_SNAPSHOT_KEY)
    .maybeSingle()
  if (error || !data?.value) return null
  const value = data.value as { saldo?: { saldoSkatteverket?: unknown }; fetchedAt?: unknown }
  const fetchedAt = parseFetchedAt(value.fetchedAt)
  const saldo = Number(value.saldo?.saldoSkatteverket)
  if (!fetchedAt || !Number.isFinite(saldo)) return null
  return { saldo: roundOre(saldo), fetchedAt }
}

async function fetchRows(supabase: SupabaseClient, companyId: string): Promise<SkattekontoRow[]> {
  return fetchAllRows<SkattekontoRow>(
    ({ from, to }) =>
      supabase
        .from('skattekonto_transactions')
        .select(
          'id, transaktionsdatum, forfallodatum, transaktionstext, belopp_skatteverket, status, journal_entry_id, suggested_journal_entry_id, is_ignored',
        )
        .eq('company_id', companyId)
        .order('transaktionsdatum', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
    { dedupeBy: (r) => r.id },
  )
}

async function fetchEntryHeads(
  supabase: SupabaseClient,
  companyId: string,
  ids: string[],
): Promise<Map<string, EntryHead>> {
  const out = new Map<string, EntryHead>()
  for (const part of chunk(Array.from(new Set(ids)), ENTRY_ID_CHUNK)) {
    const { data, error } = await supabase
      .from('journal_entries')
      .select('id, status, voucher_number, voucher_series, entry_date, description, source_type, reverses_id, reversed_by_id')
      .eq('company_id', companyId)
      .in('id', part)
    if (error) throw new Error(`Kunde inte läsa verifikat: ${error.message}`)
    for (const e of (data ?? []) as EntryHead[]) out.set(e.id, e)
  }
  return out
}

/**
 * All 1630 movement per journal entry in [fromDate, cutoffDate], over posted
 * + reversed entries (the ledger-balance predicate). One item per entry: an
 * entry with several 1630 lines nets them, which is also what a link settles.
 */
async function fetchLedgerEntries(
  supabase: SupabaseClient,
  companyId: string,
  fromDate: string | null,
  cutoffDate: string,
): Promise<Map<string, { head: EntryHead; amount: number }>> {
  const lines = await fetchEntryLines<LedgerLineRow>({
    supabase,
    entryColumns: 'id, status, voucher_number, voucher_series, entry_date, description, source_type, reverses_id, reversed_by_id',
    lineColumns: 'debit_amount, credit_amount',
    filterEntries: (q: EntryLinesQuery) => {
      let query = q
        .eq('company_id', companyId)
        .in('status', [...LEDGER_BALANCE_STATUSES])
        .lte('entry_date', cutoffDate)
      if (fromDate) query = query.gte('entry_date', fromDate)
      return query
    },
    filterLines: (q: EntryLinesQuery) => q.eq('account_number', SKATTEKONTO_ACCOUNT),
  })
  const byEntry = new Map<string, { head: EntryHead; amount: number }>()
  for (const line of lines) {
    const head = line.journal_entries
    if (!head) continue
    const amount = Number(line.debit_amount || 0) - Number(line.credit_amount || 0)
    const existing = byEntry.get(head.id)
    if (existing) existing.amount = roundOre(existing.amount + amount)
    else byEntry.set(head.id, { head, amount: roundOre(amount) })
  }
  return byEntry
}

/**
 * Net 1630 movement of the given entries. Used for entries a Skatteverket row
 * is linked to but that are dated before the comparable history (a payment is
 * booked on the bank date, Skatteverket dates it the day after).
 */
async function sumLedgerAmountForEntries(
  supabase: SupabaseClient,
  companyId: string,
  entryIds: string[],
): Promise<number> {
  let total = 0
  for (const part of chunk(entryIds, ENTRY_ID_CHUNK)) {
    const lines = await fetchEntryLines<LedgerLineRow>({
      supabase,
      entryColumns: 'id',
      lineColumns: 'debit_amount, credit_amount',
      filterEntries: (q: EntryLinesQuery) =>
        q.eq('company_id', companyId).in('status', [...LEDGER_BALANCE_STATUSES]).in('id', part),
      filterLines: (q: EntryLinesQuery) => q.eq('account_number', SKATTEKONTO_ACCOUNT),
    })
    for (const line of lines) {
      total = roundOre(total + Number(line.debit_amount || 0) - Number(line.credit_amount || 0))
    }
  }
  return total
}

/**
 * Imported annulment pairs among `open` (the ledger entries nothing else
 * settles): both halves must be in `open` and net to zero on 1630. The caller
 * passes imported entries only: an annulment the previous system booked has
 * no link fields to follow, whereas an entry made here is corrected through
 * storno, so a same-day mirror of two entries made here stays listed. Reads
 * only when two open entries mirror each other on 1630. A failed read settles
 * nothing, so both halves stay listed.
 */
async function findSettledAnnulmentIds(
  supabase: SupabaseClient,
  companyId: string,
  open: Array<{ head: EntryHead; amount: number }>,
): Promise<Set<string>> {
  const settled = new Set<string>()
  const oreAmounts = new Set(open.map((e) => Math.round(e.amount * 100)))
  const mirrored = open.filter((e) => oreAmounts.has(-Math.round(e.amount * 100)))
  if (mirrored.length < 2) return settled
  const dates = mirrored.map((e) => e.head.entry_date).sort()
  let pairs: Array<[string, string]>
  try {
    pairs = await loadImportedStornoPairs(supabase, companyId, dates[0], dates[dates.length - 1])
  } catch (err) {
    log.warn('imported storno pairs read failed', {
      companyId,
      error: err instanceof Error ? err.message : String(err),
    })
    return settled
  }
  const openById = new Map(open.map((e) => [e.head.id, e]))
  for (const [firstId, secondId] of pairs) {
    const first = openById.get(firstId)
    const second = openById.get(secondId)
    if (!first || !second || roundOre(first.amount + second.amount) !== 0) continue
    settled.add(firstId)
    settled.add(secondId)
  }
  return settled
}

function proposalFrom(head: EntryHead, row: SkattekontoRow, groupIds: string[]): ReconciliationProposal {
  const combined = groupIds.length > 1
  return {
    journal_entry_id: head.id,
    voucher_number: head.voucher_number,
    voucher_series: head.voucher_series,
    entry_date: head.entry_date,
    description: head.description ?? '',
    entry_status: head.status,
    confidence: head.status === 'posted' ? (combined ? 0.9 : 0.95) : 0.8,
    reasons: [
      combined ? `summan av ${groupIds.length} händelser är exakt beloppet på 1630` : 'exakt belopp på 1630',
      `${Math.abs(daysBetweenIso(row.transaktionsdatum, head.entry_date))} dagars avstånd`,
    ],
    ...(combined ? { external_ids: groupIds } : {}),
  }
}

function inWindow(date: string, from: string | null | undefined, to: string | null | undefined): boolean {
  if (from && date < from) return false
  if (to && date > to) return false
  return true
}

/**
 * The skattekonto (BAS 1630) reconciliation: what Skatteverket says, what the
 * ledger says, and the rows that explain the gap.
 *
 * Identity (matched pairs cancel by construction, see dev design
 * "Avstämningsmotorn"):
 *
 *   saldo_at_start     = saldo_skatteverket - sum(SKV-posted rows in the history)
 *   opening_difference = saldo_at_start - ledger balance before history_start
 *                        (from the IB when there is one, less entries before
 *                        history_start that a row links to)
 *   difference         = saldo_skatteverket - ledger balance at the snapshot
 *   unexplained        = difference - opening_difference
 *                        - sum(unlinked SKV rows) - sum(ignored SKV rows)
 *                        + sum(unlinked 1630 entries)
 *
 * Every link pairs equal amounts on the expected side, so `unexplained` is
 * 0,00 whenever the data is consistent. A non-zero value is an integrity
 * finding (a link to an entry whose 1630 line changed, a read that disagrees
 * with the trial balance), never a user task. The user's work is the bridge.
 *
 * Anchored at the snapshot instant; the ledger is summed with
 * entry_date <= the snapshot date so a verifikat booked later today cannot
 * fabricate a gap. A link to a reversed or draft entry is a dead link: the
 * row is treated as unlinked and flagged, because the ledger no longer counts
 * that 1630 line the way the link assumed.
 *
 * The ledger is floored at the latest ingående balans on 1630
 * (findOpeningBalanceFloor): the IB restates every earlier year, whose detail
 * stays in the ledger, so an all-history sum counts those years twice. The
 * ledger balance is the IB plus everything booked after it, the huvudbok
 * figure, and history_start moves up to the IB when the first SKV row is
 * older: earlier rows and verifikat belong to the prior year's
 * reconciliation, whose outcome the IB carries into opening_difference. The
 * IB itself is the opening balance, never a row to match. Without an IB both
 * sums run over all history, as before.
 *
 * A storno pair settles itself: in-app (reversed original + storno) and
 * imported (two posted verifikat that mirror each other, "Annullering av
 * V290", found by lib/skatteverket/skattekonto-cancelled-entries.ts).
 *
 * Returns null when the company has neither a saldo snapshot nor any
 * skattekonto rows (account not configured).
 */
export async function getSkattekontoReconciliationStatus(
  supabase: SupabaseClient,
  companyId: string,
  options: SkattekontoReconciliationOptions = {},
): Promise<SkattekontoReconciliationResult | null> {
  const today = options.today ?? toIsoDate(new Date())
  const [snapshot, rows] = await Promise.all([
    readSnapshot(supabase, companyId),
    fetchRows(supabase, companyId),
  ])
  if (!snapshot && rows.length === 0) return null

  const cutoffDate = snapshot ? toIsoDate(snapshot.fetchedAt) : today
  const asOf = snapshot ? snapshot.fetchedAt.toISOString() : new Date(today + 'T00:00:00Z').toISOString()
  const stale = !snapshot || daysBetweenIso(cutoffDate, today) > STALE_AFTER_DAYS

  // The IB floor (see the function doc). When it cannot be read the balances
  // are not computed at all: an unfloored sum may count prior years twice.
  let ledgerReadFailed = false
  let floor: OpeningBalanceFloor | null = null
  try {
    floor = await findOpeningBalanceFloor(supabase, companyId, SKATTEKONTO_ACCOUNT, cutoffDate)
  } catch (err) {
    ledgerReadFailed = true
    log.warn('opening balance read failed', {
      companyId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  const floorReadFailed = ledgerReadFailed
  const floorIds = new Set(floor?.entryIds ?? [])

  const bookedToCutoff = rows.filter((r) => r.status === 'booked' && r.transaktionsdatum <= cutoffDate)
  const upcoming = rows.filter((r) => r.status === 'upcoming' && !r.is_ignored)
  const firstRowDate = bookedToCutoff.reduce<string | null>(
    (first, r) => (first === null || r.transaktionsdatum < first ? r.transaktionsdatum : first),
    null,
  )
  const historyStart = floor && (!firstRowDate || floor.date > firstRowDate) ? floor.date : firstRowDate
  const inHistory = (r: SkattekontoRow) => !historyStart || r.transaktionsdatum >= historyStart

  // Linked and suggested entries: one chunked read gives link liveness and
  // the voucher facts the proposals carry. A row before the history only
  // needs its link (see `booked`).
  const referencedIds = bookedToCutoff.flatMap((r) =>
    (inHistory(r) ? [r.journal_entry_id, r.suggested_journal_entry_id] : [r.journal_entry_id]).filter(
      (x): x is string => !!x,
    ),
  )
  const heads = await fetchEntryHeads(supabase, companyId, referencedIds)

  // A row before the history start that links live to a verifikat inside the
  // history stays with it (Skatteverket dates a payout in December, the
  // verifikat takes the January bank date): the mirror of
  // linkedBeforeStartIds below, so the IB boundary never splits a pair.
  const booked = bookedToCutoff.filter((r) => {
    if (!historyStart || r.transaktionsdatum >= historyStart) return true
    const head = !r.is_ignored && r.journal_entry_id ? heads.get(r.journal_entry_id) : undefined
    return head?.status === 'posted' && head.entry_date >= historyStart && head.entry_date <= cutoffDate
  })

  // Ledger side. Both reads may fail independently of the row reads; a
  // failed balance read yields null balances and a null residual rather than
  // a fabricated 0 (same posture as the drift check).
  let ledgerEntries = new Map<string, { head: EntryHead; amount: number }>()
  try {
    ledgerEntries = await fetchLedgerEntries(supabase, companyId, historyStart, cutoffDate)
  } catch (err) {
    ledgerReadFailed = true
    log.warn('ledger entries read failed', {
      companyId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  // A live link can reach an entry dated before historyStart. Its 1630 line
  // is settled by a row inside the history, so it belongs to the comparable
  // history, not to the opening balance; left in `ledgerBefore` the pair never
  // cancels and shows up as an opening difference plus an equal residual.
  // The IB is in the opening balance whatever its date, so a link to it
  // moves it the same way.
  const linkedBeforeStartIds = historyStart
    ? Array.from(
        new Set(
          booked.flatMap((r) => {
            if (r.is_ignored || !r.journal_entry_id) return []
            const head = heads.get(r.journal_entry_id)
            return head && head.status === 'posted' && (head.entry_date < historyStart || floorIds.has(head.id))
              ? [head.id]
              : []
          }),
        ),
      )
    : []
  // With an IB, the ledger is the IB plus everything after it, and the
  // opening side is the IB plus what was booked between it and historyStart.
  const sinceFloor = floor ? { fromDate: floor.date } : {}
  const [ledgerBalance, ledgerBeforeByDate, linkedBeforeStart] = await Promise.all([
    floorReadFailed
      ? null
      : sumAccountBalance(supabase, companyId, SKATTEKONTO_ACCOUNT, { ...sinceFloor, cutoffDate }),
    floorReadFailed
      ? null
      : !historyStart
        ? 0
        : floor && historyStart === floor.date
          ? floor.amount
          : sumAccountBalance(supabase, companyId, SKATTEKONTO_ACCOUNT, { ...sinceFloor, beforeDate: historyStart }),
    linkedBeforeStartIds.length > 0
      ? sumLedgerAmountForEntries(supabase, companyId, linkedBeforeStartIds).catch((err) => {
          log.warn('linked entries before history start read failed', {
            companyId,
            error: err instanceof Error ? err.message : String(err),
          })
          return null
        })
      : Promise.resolve<number | null>(0),
  ])
  const ledgerBefore =
    ledgerBeforeByDate === null || linkedBeforeStart === null
      ? null
      : roundOre(ledgerBeforeByDate - linkedBeforeStart)
  if (ledgerBalance === null || ledgerBefore === null) ledgerReadFailed = true

  const liveLinkedEntryIds = new Set<string>()
  const items: SkattekontoReconciliationItems = {
    proposed: [],
    unmatched_external: [],
    unmatched_ledger: [],
    matched: [],
    ignored: [],
    upcoming: [],
  }
  let unlinkedExternalTotal = 0
  let ignoredTotal = 0
  let olderUnmatched = 0
  const counts = { proposed: 0, unmatched_external: 0, unmatched_ledger: 0, matched: 0, ignored: 0 }

  // A combined proposal (crm#128) is persisted as the same suggested
  // verifikat on every row of the group; the group is what gets linked.
  const openRowsBySuggestion = new Map<string, string[]>()
  for (const row of booked) {
    if (row.is_ignored || row.journal_entry_id || !row.suggested_journal_entry_id) continue
    const list = openRowsBySuggestion.get(row.suggested_journal_entry_id) ?? []
    list.push(row.id)
    openRowsBySuggestion.set(row.suggested_journal_entry_id, list)
  }

  const pushCapped = (bucket: keyof SkattekontoReconciliationItems, item: ReconciliationItem) => {
    if (items[bucket].length < MAX_ITEMS_PER_BUCKET) items[bucket].push(item)
  }
  const visible = (date: string) => inWindow(date, options.windowFrom, options.windowTo)
  const olderThanWindow = (date: string) => !!options.windowFrom && date < options.windowFrom

  for (const row of booked) {
    const amount = roundOre(Number(row.belopp_skatteverket))
    const base = {
      item_id: row.id,
      item_type: 'skattekonto_transaction' as const,
      side: 'external' as const,
      date: row.transaktionsdatum,
      description: row.transaktionstext,
      amount,
      currency: 'SEK',
    }

    if (row.is_ignored) {
      ignoredTotal = roundOre(ignoredTotal + amount)
      counts.ignored++
      if (visible(row.transaktionsdatum)) {
        pushCapped('ignored', { ...base, bucket: 'ignored', actions: ['unignore'] })
      }
      continue
    }

    const linkedHead = row.journal_entry_id ? heads.get(row.journal_entry_id) : undefined
    const linkProblem: ReconciliationItem['link_problem'] = row.journal_entry_id
      ? !linkedHead
        ? 'entry_missing'
        : linkedHead.status === 'reversed'
          ? 'entry_reversed'
          : linkedHead.status === 'draft'
            ? 'entry_draft'
            : null
      : null

    if (row.journal_entry_id && linkedHead && linkProblem === null) {
      liveLinkedEntryIds.add(row.journal_entry_id)
      counts.matched++
      if (visible(row.transaktionsdatum)) {
        pushCapped('matched', {
          ...base,
          bucket: 'matched',
          linked_journal_entry_id: row.journal_entry_id,
          voucher_number: linkedHead.voucher_number,
          voucher_series: linkedHead.voucher_series,
          entry_status: linkedHead.status,
          actions: ['unmatch'],
        })
      }
      continue
    }

    // Unlinked (or dead link): counts toward the bridge either way.
    unlinkedExternalTotal = roundOre(unlinkedExternalTotal + amount)
    if (olderThanWindow(row.transaktionsdatum)) olderUnmatched++

    const suggestedHead = row.suggested_journal_entry_id
      ? heads.get(row.suggested_journal_entry_id)
      : undefined
    const proposal =
      suggestedHead && suggestedHead.status !== 'reversed' && !liveLinkedEntryIds.has(suggestedHead.id)
        ? proposalFrom(
            suggestedHead,
            row,
            row.journal_entry_id ? [row.id] : openRowsBySuggestion.get(suggestedHead.id) ?? [row.id],
          )
        : null

    if (proposal) {
      counts.proposed++
      if (visible(row.transaktionsdatum)) {
        pushCapped('proposed', {
          ...base,
          bucket: 'proposed',
          linked_journal_entry_id: row.journal_entry_id,
          link_problem: linkProblem,
          proposal,
          actions: ['match', 'book', 'ignore'],
        })
      }
    } else {
      counts.unmatched_external++
      if (visible(row.transaktionsdatum)) {
        pushCapped('unmatched_external', {
          ...base,
          bucket: 'unmatched_external',
          linked_journal_entry_id: row.journal_entry_id,
          link_problem: linkProblem,
          proposal: null,
          actions: linkProblem ? ['match', 'book', 'unmatch'] : ['book', 'match', 'ignore'],
        })
      }
    }
  }

  // A complete, unlinked storno pair settles itself. Keep both entries in
  // the ledger balance, but do not ask for two external events that never
  // happened. Requiring both sides inside the comparable history preserves
  // outstanding movement at its date boundaries; a live external link or
  // a nonzero pair must still be explained.
  const settledStornoIds = new Set<string>()
  for (const { head, amount } of ledgerEntries.values()) {
    if (head.status !== 'reversed' || !head.reversed_by_id || liveLinkedEntryIds.has(head.id)) continue
    const reversal = ledgerEntries.get(head.reversed_by_id)
    if (
      !reversal ||
      reversal.head.status !== 'posted' ||
      reversal.head.source_type !== 'storno' ||
      reversal.head.reverses_id !== head.id ||
      liveLinkedEntryIds.has(reversal.head.id) ||
      roundOre(amount + reversal.amount) !== 0
    ) continue
    settledStornoIds.add(head.id)
    settledStornoIds.add(reversal.head.id)
  }
  // An imported storno pair has no link fields to follow; the detector the
  // match candidates use finds it by content, and its anchor keeps a payment
  // and a later refund of the same amount out. Same conditions otherwise.
  const settledAnnulmentIds = await findSettledAnnulmentIds(
    supabase,
    companyId,
    Array.from(ledgerEntries.values()).filter(
      ({ head, amount }) =>
        amount !== 0 &&
        head.status === 'posted' &&
        head.source_type === 'import' &&
        !head.reverses_id &&
        !head.reversed_by_id &&
        !liveLinkedEntryIds.has(head.id) &&
        !settledStornoIds.has(head.id) &&
        !floorIds.has(head.id),
    ),
  )

  // Ledger entries in the comparable history that no live link or storno
  // settles. The IB is the opening balance (in ledgerBefore), not a row.
  let unlinkedLedgerTotal = 0
  const awaitingFrom = addDaysIso(cutoffDate, -AWAITING_EXTERNAL_DAYS)
  const sortedLedger = Array.from(ledgerEntries.values()).sort((a, b) =>
    a.head.entry_date < b.head.entry_date ? -1 : a.head.entry_date > b.head.entry_date ? 1 : 0,
  )
  for (const { head, amount } of sortedLedger) {
    if (liveLinkedEntryIds.has(head.id) || settledStornoIds.has(head.id) || settledAnnulmentIds.has(head.id)) continue
    if (floorIds.has(head.id)) continue
    if (amount === 0) continue
    unlinkedLedgerTotal = roundOre(unlinkedLedgerTotal + amount)
    counts.unmatched_ledger++
    if (olderThanWindow(head.entry_date)) olderUnmatched++
    if (!visible(head.entry_date)) continue
    pushCapped('unmatched_ledger', {
      item_id: head.id,
      item_type: 'journal_entry',
      side: 'ledger',
      bucket: 'unmatched_ledger',
      date: head.entry_date,
      description: head.description ?? '',
      amount,
      currency: 'SEK',
      voucher_number: head.voucher_number,
      voucher_series: head.voucher_series,
      entry_status: head.status,
      awaiting_external: head.entry_date >= awaitingFrom,
      actions: ['review', 'match'],
    })
  }

  let upcomingTotal = 0
  for (const row of upcoming) {
    const amount = roundOre(Number(row.belopp_skatteverket))
    upcomingTotal = roundOre(upcomingTotal + amount)
    pushCapped('upcoming', {
      item_id: row.id,
      item_type: 'skattekonto_transaction',
      side: 'external',
      bucket: 'upcoming',
      date: row.forfallodatum ?? row.transaktionsdatum,
      description: row.transaktionstext,
      amount,
      currency: 'SEK',
      actions: [],
    })
  }

  // Totals and the identity.
  const allBookedTotal = booked.reduce((s, r) => roundOre(s + Number(r.belopp_skatteverket)), 0)
  const saldo = snapshot?.saldo ?? null
  const saldoAtStart = saldo === null ? null : roundOre(saldo - allBookedTotal)
  const openingDifference =
    saldoAtStart === null || ledgerBefore === null ? null : roundOre(saldoAtStart - ledgerBefore)
  const difference = saldo === null || ledgerBalance === null ? null : roundOre(saldo - ledgerBalance)
  const unexplained =
    difference === null || openingDifference === null
      ? null
      : roundOre(
          difference - openingDifference - unlinkedExternalTotal - ignoredTotal + unlinkedLedgerTotal,
        )

  const isReconciled =
    !!snapshot &&
    !ledgerReadFailed &&
    counts.unmatched_external === 0 &&
    counts.proposed === 0 &&
    counts.unmatched_ledger === 0 &&
    Math.abs(openingDifference ?? 0) < 0.01 &&
    Math.abs(unexplained ?? 0) < 0.01

  const bridge: BridgeLine[] = [
    {
      key: 'external_balance',
      label_sv: 'Saldo hos Skatteverket',
      label_en: 'Balance at Skatteverket',
      amount: saldo ?? 0,
      count: null,
      items_bucket: null,
    },
    {
      key: 'unmatched_external',
      label_sv: 'Händelser som saknas i bokföringen',
      label_en: 'Events missing from the ledger',
      amount: roundOre(-unlinkedExternalTotal),
      count: counts.unmatched_external + counts.proposed,
      items_bucket: 'unmatched_external',
    },
    {
      key: 'unmatched_ledger',
      label_sv: 'Rader på 1630 utan händelse hos Skatteverket',
      label_en: '1630 lines without a Skatteverket event',
      amount: unlinkedLedgerTotal,
      count: counts.unmatched_ledger,
      items_bucket: 'unmatched_ledger',
    },
  ]
  if (counts.ignored > 0) {
    bridge.push({
      key: 'ignored',
      label_sv: 'Ignorerade händelser',
      label_en: 'Ignored events',
      amount: roundOre(-ignoredTotal),
      count: counts.ignored,
      items_bucket: 'ignored',
    })
  }
  if (openingDifference !== null && Math.abs(openingDifference) >= 0.01) {
    bridge.push({
      key: 'opening_difference',
      label_sv: `Ingående skillnad per ${historyStart ?? cutoffDate}`,
      label_en: `Opening difference at ${historyStart ?? cutoffDate}`,
      amount: roundOre(-openingDifference),
      count: null,
      items_bucket: null,
    })
  }
  bridge.push({
    key: 'ledger_balance',
    label_sv: 'Bokfört på 1630',
    label_en: 'Booked on 1630',
    amount: ledgerBalance ?? 0,
    count: null,
    items_bucket: null,
  })

  const truncated = (Object.keys(items) as Array<keyof SkattekontoReconciliationItems>).filter(
    (k) => items[k].length >= MAX_ITEMS_PER_BUCKET,
  )

  return {
    account_key: SKATTEKONTO_ACCOUNT_KEY,
    kind: 'skattekonto',
    account_number: SKATTEKONTO_ACCOUNT,
    currency: 'SEK',
    window: { from: options.windowFrom ?? null, to: options.windowTo ?? null },
    as_of: asOf,
    stale,
    external_balance: saldo,
    ledger_balance: ledgerBalance,
    difference,
    unexplained_difference: unexplained,
    is_reconciled: isReconciled,
    bridge,
    counts,
    skattekonto: {
      saldo_skatteverket: saldo,
      fetched_at: snapshot ? snapshot.fetchedAt.toISOString() : null,
      history_start: historyStart,
      opening_difference: openingDifference,
      upcoming_count: upcoming.length,
      upcoming_total: upcomingTotal,
      ledger_balance_before_start: ledgerBefore,
    },
    bank: null,
    items,
    items_truncated: truncated,
    older_unmatched_count: olderUnmatched,
    ledger_read_failed: ledgerReadFailed,
  }
}
