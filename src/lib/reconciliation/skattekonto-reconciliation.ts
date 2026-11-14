import { chunk } from '@/lib/utils'
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { fetchEntryLines, type EntryLinesQuery } from '@/lib/bookkeeping/entry-lines'
import { resolveSkattekontoAccount, type SkattekontoLedgerAccount } from '@/lib/skatteverket/skattekonto-account'
import { readSkatteverketConnection, type SkatteverketConnectionState } from '@/lib/skatteverket/connection-state'
import { loadImportedStornoPairs } from '@/lib/skatteverket/skattekonto-cancelled-entries'
import { createLogger } from '@/lib/logger'
import { roundOre } from '@/lib/money'
import { planSkattekontoLedgerLinks, type PlannedLedgerLink } from './skattekonto-ledger-plan'
import { addDaysIso, daysBetweenIso, toIsoDate, todayIsoStockholm } from '@/lib/dates/iso'
import {
  LEDGER_BALANCE_STATUSES,
  findOpeningBalanceFloor,
  sumAccountBalance,
  type OpeningBalanceFloor,
} from './gl-balance'
import { resolveLedgerSettlements, type LedgerSettlementMember } from './ledger-settlement-store'
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

/** Covering verifikat named on the public status block; the count is always complete. */
const MAX_COVER_ENTRY_IDS = 10

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
  /**
   * The company's skattekonto account when the caller already resolved it
   * (lib/skatteverket/skattekonto-account.ts); read here otherwise. "1630"
   * in this file means that account: 2012 for an enskild firma that runs the
   * skattekonto in eget kapital.
   */
  account?: SkattekontoLedgerAccount
}

export interface SkattekontoReconciliationItems {
  proposed: ReconciliationItem[]
  unmatched_external: ReconciliationItem[]
  unmatched_ledger: ReconciliationItem[]
  matched: ReconciliationItem[]
  ignored: ReconciliationItem[]
  upcoming: ReconciliationItem[]
  /** Open rows dated before history_start: outside the bridge (see the engine doc). */
  before_history: ReconciliationItem[]
}

export interface SkattekontoReconciliationResult extends ReconciliationStatus {
  items: SkattekontoReconciliationItems
  /** Buckets whose item list was capped at MAX_ITEMS_PER_BUCKET. */
  items_truncated: Array<keyof SkattekontoReconciliationItems>
  /** Unmatched rows (either side) dated before windowFrom, when a window was given. */
  older_unmatched_count: number
  /** Ledger read failed: balances and the residual are null, buckets are still listed. */
  ledger_read_failed: boolean
  /**
   * The open rows the ledger already holds through unlinked verifikat on
   * 1630 (see findLedgerCoverPoint), complete and unwindowed: what the
   * booking guard reads, with the ledger plan (skattekontoPlannedHolds).
   * Null when nothing is covered.
   */
  cover: SkattekontoLedgerCover | null
}

/** One unlinked (or partly linked) verifikat on 1630 that covers open rows. */
export interface SkattekontoCoveringEntry {
  journal_entry_id: string
  voucher_number: number | null
  voucher_series: string | null
  entry_date: string
  description: string
  status: EntryStatus
  /** What no Skatteverket row is linked to: the 1630 net, or its remainder. */
  open_amount: number
}

export interface SkattekontoLedgerCover {
  /** The skattekonto account the covering verifikat are on. */
  account_number: SkattekontoLedgerAccount
  /** Every open row dated on or before this date is covered. */
  through_date: string
  kind: 'events_equal' | 'ledger_agrees'
  /** The covered open rows (not linked, not ignored), every one of them. */
  event_ids: string[]
  event_count: number
  event_total: number
  /** The open verifikat up to through_date, largest open amount first. */
  entries: SkattekontoCoveringEntry[]
  entry_total: number
}

interface DatedAmount {
  date: string
  amount: number
}

/** One verifikat of the open ledger list (unmatched_ledger), complete and uncapped. */
export interface SkattekontoOpenLedgerEntry {
  journal_entry_id: string
  /** What no Skatteverket row explains: the 1630 net, or its remainder (ledger sign). */
  amount: number
  status: EntryStatus
  entry_date: string
}

/**
 * The open ledger list behind a status, by verifikat id. Kept beside the
 * result rather than on it, so the status every door serialises does not
 * grow by one field per open verifikat; the 1:N link (skattekonto-split.ts)
 * reads it to link only what the list shows, at the amount it shows.
 */
const openLedgerOfStatus = new WeakMap<SkattekontoReconciliationResult, Map<string, SkattekontoOpenLedgerEntry>>()

export function skattekontoOpenLedger(
  status: SkattekontoReconciliationResult,
): Map<string, SkattekontoOpenLedgerEntry> | null {
  return openLedgerOfStatus.get(status) ?? null
}

/**
 * One open row the ledger plan (skattekonto-ledger-plan.ts, PH 171) assigns
 * to an open verifikat: the verifikat holds it, with the other rows of the
 * link, exactly to the öre.
 */
export interface SkattekontoPlannedHold {
  /** The verifikat that holds the row, as the cover lists its verifikat. */
  entry: SkattekontoCoveringEntry
  /** Every row of the link, this one included, in date order. */
  event_ids: string[]
  /** Their sum, Skatteverket sign: the verifikat's open amount. */
  total: number
  /** The earliest and latest date among the rows and the verifikat. */
  from_date: string
  to_date: string
}

/**
 * The ledger plan behind a status, by row id: complete and unwindowed, so
 * the booking guard reads every planned row whatever its date, not only the
 * ones the proposed bucket lists. Kept beside the result for the same reason
 * as the open ledger above.
 */
const plannedHoldsOfStatus = new WeakMap<SkattekontoReconciliationResult, Map<string, SkattekontoPlannedHold>>()

export function skattekontoPlannedHolds(
  status: SkattekontoReconciliationResult,
): Map<string, SkattekontoPlannedHold> | null {
  return plannedHoldsOfStatus.get(status) ?? null
}

/**
 * Are open Skatteverket rows already in the ledger through verifikat on 1630
 * that no row is linked to? Arithmetic only, exact to the öre, never a guess
 * about which verifikat "looks" summarised (crm#1043).
 *
 * Booking a row moves 1630 by its amount. At a date d that some open
 * verifikat carries, take the open rows and the open verifikat dated on or
 * before d. The rows are covered when either holds:
 *
 *   events_equal    the open verifikat sum exactly to the open rows: the
 *                   rows are booked there, in another shape (one summarised
 *                   voucher, several part vouchers).
 *   ledger_agrees   open verifikat - open rows = opening difference +
 *                   ignored rows, which is the bridge identity for "1630
 *                   equals Skatteverket at d". The ledger already agrees
 *                   although the rows are unbooked, so they are inside the
 *                   open verifikat, and what those hold beyond the rows is
 *                   the part from before the fetched history.
 *
 * Both are invariant under linking (a link takes the same amount off both
 * sides) and under booking a row dated after d, so the answer does not move
 * while the user works. The latest such date wins; a final point takes every
 * open row and verifikat whatever their dates. Rows netting to zero are never
 * a cover (booking all of them would not move 1630). No open verifikat, no
 * cover: a company that books every row itself is never asked anything.
 */
export function findLedgerCoverPoint(input: {
  openEvents: Array<DatedAmount & { id: string }>
  openEntries: Array<DatedAmount & { id: string }>
  ignoredEvents: DatedAmount[]
  openingDifference: number | null
}): { through_date: string; kind: SkattekontoLedgerCover['kind'] } | null {
  const { openEvents, openEntries, ignoredEvents, openingDifference } = input
  if (openEvents.length === 0 || openEntries.length === 0) return null
  const ore = (n: number) => Math.round(n * 100)
  const lastDate = [...openEvents, ...openEntries].reduce((max, r) => (r.date > max ? r.date : max), '')
  const points = Array.from(new Set([...openEntries.map((e) => e.date), lastDate])).sort()
  const sumTo = (rows: DatedAmount[], date: string) => {
    let sum = 0
    let count = 0
    for (const r of rows) {
      if (r.date > date) continue
      sum += ore(r.amount)
      count++
    }
    return { sum, count }
  }
  const openingOre = openingDifference === null ? null : ore(openingDifference)
  let found: { through_date: string; kind: SkattekontoLedgerCover['kind'] } | null = null
  for (const date of points) {
    const events = sumTo(openEvents, date)
    const entries = sumTo(openEntries, date)
    if (events.count === 0 || entries.count === 0 || events.sum === 0) continue
    const gap = entries.sum - events.sum
    if (gap === 0) {
      found = { through_date: date, kind: 'events_equal' }
    } else if (openingOre !== null && gap - sumTo(ignoredEvents, date).sum - openingOre === 0) {
      found = { through_date: date, kind: 'ledger_agrees' }
    }
  }
  return found
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
  account: SkattekontoLedgerAccount,
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
    filterLines: (q: EntryLinesQuery) => q.eq('account_number', account),
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
 * Which of the given entries move 1630 at all (posted or reversed, at least
 * one line on the account). Used for entries a Skatteverket row is linked to
 * but that are dated before the comparable history (a payment is booked on
 * the bank date, Skatteverket dates it the day after): the linked rows'
 * amount leaves the opening balance only for an entry that really carries a
 * 1630 line, so a link to a verifikat without one stays an integrity finding.
 */
async function fetchEntryIdsOnAccount(
  supabase: SupabaseClient,
  companyId: string,
  entryIds: string[],
  account: SkattekontoLedgerAccount,
): Promise<Set<string>> {
  const onAccount = new Set<string>()
  for (const part of chunk(entryIds, ENTRY_ID_CHUNK)) {
    const lines = await fetchEntryLines<LedgerLineRow>({
      supabase,
      entryColumns: 'id',
      lineColumns: 'debit_amount, credit_amount',
      filterEntries: (q: EntryLinesQuery) =>
        q.eq('company_id', companyId).in('status', [...LEDGER_BALANCE_STATUSES]).in('id', part),
      filterLines: (q: EntryLinesQuery) => q.eq('account_number', account),
    })
    for (const line of lines) {
      if (line.journal_entries?.id) onAccount.add(line.journal_entries.id)
    }
  }
  return onAccount
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
  account: SkattekontoLedgerAccount,
): Promise<Set<string>> {
  const settled = new Set<string>()
  const oreAmounts = new Set(open.map((e) => Math.round(e.amount * 100)))
  const mirrored = open.filter((e) => oreAmounts.has(-Math.round(e.amount * 100)))
  if (mirrored.length < 2) return settled
  const dates = mirrored.map((e) => e.head.entry_date).sort()
  let pairs: Array<[string, string]>
  try {
    pairs = await loadImportedStornoPairs(supabase, companyId, dates[0], dates[dates.length - 1], account)
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

function proposalFrom(
  head: EntryHead,
  row: SkattekontoRow,
  groupIds: string[],
  account: SkattekontoLedgerAccount,
): ReconciliationProposal {
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
      combined ? `summan av ${groupIds.length} händelser är exakt beloppet på ${account}` : `exakt belopp på ${account}`,
      `${Math.abs(daysBetweenIso(row.transaktionsdatum, head.entry_date))} dagars avstånd`,
    ],
    ...(combined ? { external_ids: groupIds } : {}),
  }
}

/**
 * The ledger plan (skattekonto-ledger-plan.ts) as proposals: every planned
 * row moves from unmatched_external to proposed, naming the verifikat that
 * holds it and, for a group, every row of it (external_ids), so linking the
 * proposal links the group as one exact N:1 pair. The counts move with the
 * rows whether they are in the window or not; the bridge counts both buckets
 * on one line and no total changes.
 */
function proposeLedgerPlan(input: {
  planned: PlannedLedgerLink[]
  heads: Map<string, EntryHead>
  items: SkattekontoReconciliationItems
  counts: { proposed: number; unmatched_external: number }
  account: SkattekontoLedgerAccount
}): void {
  const { planned, heads, items, counts, account } = input
  const proposalByRow = new Map<string, ReconciliationProposal>()
  for (const link of planned) {
    const head = heads.get(link.journal_entry_id)
    if (!head) continue
    const count = link.event_ids.length
    const proposal: ReconciliationProposal = {
      journal_entry_id: head.id,
      voucher_number: head.voucher_number,
      voucher_series: head.voucher_series,
      entry_date: head.entry_date,
      description: head.description ?? '',
      entry_status: head.status,
      confidence: 0.9,
      reasons: [
        count > 1 ? `summan av ${count} händelser är exakt verifikatets belopp på ${account}` : `exakt belopp på ${account}`,
        link.from_date === link.to_date ? `samma dag, ${link.from_date}` : `${link.from_date} till ${link.to_date}`,
      ],
      ...(count > 1 ? { external_ids: link.event_ids } : {}),
    }
    for (const id of link.event_ids) proposalByRow.set(id, proposal)
  }
  if (proposalByRow.size === 0) return
  counts.unmatched_external -= proposalByRow.size
  counts.proposed += proposalByRow.size
  const moved: ReconciliationItem[] = []
  items.unmatched_external = items.unmatched_external.filter((item) => {
    const proposal = proposalByRow.get(item.item_id)
    if (!proposal) return true
    moved.push({ ...item, bucket: 'proposed', proposal, actions: ['match', 'book', 'ignore'] })
    return false
  })
  items.proposed = [...items.proposed, ...moved]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .slice(0, MAX_ITEMS_PER_BUCKET)
}

/** Holder ids listed per verifikat (held_by_uncounted_rows); the count and amount cover all of them. */
const MAX_HOLDER_IDS = 20

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
 *                        + sum(unlinked 1630 entries and remainders)
 *
 * One rule for every link: it explains exactly the linked rows' amount of
 * its verifikat, no more. What the verifikat holds on 1630 beyond the rows
 * linked to it is its remainder (1630 net - linked rows, either sign) and
 * stays on the ledger side: listed in unmatched_ledger with the remaining
 * amount when the verifikat is inside the comparable history, left in the
 * opening balance when the verifikat is the IB or dated before the history
 * (that part belongs to the time before the fetched rows). An exact link has
 * remainder 0 and leaves nothing behind. A summarised verifikat linked with
 * a remainder (crm#1043), and a verifikat matched on one of several 1630
 * lines, keep the rest visible instead of vanishing with the link.
 *
 * So what a link takes off the Skatteverket side it takes off the ledger
 * side, and `unexplained` is 0,00 whenever the data is consistent. A non-zero
 * value is an integrity finding (a link to a posted verifikat without any
 * 1630 line or dated after the snapshot, a read that disagrees with the
 * trial balance), never a user task. The user's work is the bridge.
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
 * sums run over all history, as before. Open rows from before history_start
 * (a migrated company's last year, already in its imported books) are still
 * listed in `before_history`, outside every sum and count: Att göra counts
 * them as unbooked, and an agent needs their ids to link or ignore them
 * (crm#1153). Ignoring one, or linking it to a verifikat dated before
 * history_start, moves no figure of the bridge.
 *
 * A storno pair settles itself: in-app (reversed original + storno) and
 * imported (two posted verifikat that mirror each other, "Annullering av
 * V290", found by lib/skatteverket/skattekonto-cancelled-entries.ts).
 * Verifikat settled against each other on 1630 (what a 1:N link writes
 * beside its row link, lib/reconciliation/skattekonto-split.ts) leave the
 * ledger side together while their open amounts sum to zero, so they move
 * no total.
 *
 * The saldo is Skatteverket's word only while the company is connected
 * (lib/skatteverket/connection-state.ts, the rule the skattekonto page
 * follows): the snapshot outlives a disconnect, and comparing the books with
 * it read "Saldo hos Skatteverket 0 kr" or "stämmer" for a company that no
 * longer reads its skattekonto (crm#1701). Without a connection the status
 * is the never-fetched one, saldo null, with saldo_missing_reason saying why.
 *
 * Returns null when the company has neither a saldo snapshot nor any
 * skattekonto rows (account not configured).
 */
export async function getSkattekontoReconciliationStatus(
  supabase: SupabaseClient,
  companyId: string,
  options: SkattekontoReconciliationOptions = {},
): Promise<SkattekontoReconciliationResult | null> {
  const today = options.today ?? todayIsoStockholm()
  const [storedSnapshot, rows, connection] = await Promise.all([
    readSnapshot(supabase, companyId),
    fetchRows(supabase, companyId),
    readSkatteverketConnection(supabase, companyId).catch((err): SkatteverketConnectionState => {
      log.warn('skatteverket connection read failed', {
        companyId,
        error: err instanceof Error ? err.message : String(err),
      })
      return 'unknown'
    }),
  ])
  const snapshot = connection === 'not_connected' ? null : storedSnapshot
  const saldoMissingReason = snapshot ? null : connection === 'not_connected' ? 'not_connected' : 'not_fetched'
  if (!snapshot && rows.length === 0) return null
  const account = options.account ?? (await resolveSkattekontoAccount(supabase, companyId))

  const cutoffDate = snapshot ? toIsoDate(snapshot.fetchedAt) : today
  const asOf = snapshot ? snapshot.fetchedAt.toISOString() : new Date(today + 'T00:00:00Z').toISOString()
  const stale = !snapshot || daysBetweenIso(cutoffDate, today) > STALE_AFTER_DAYS

  // The IB floor (see the function doc). When it cannot be read the balances
  // are not computed at all: an unfloored sum may count prior years twice.
  let ledgerReadFailed = false
  let floor: OpeningBalanceFloor | null = null
  try {
    floor = await findOpeningBalanceFloor(supabase, companyId, account, cutoffDate)
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
  // the voucher facts the proposals carry. A row before the history needs
  // its link (see `booked`), or, while open, its proposal (before_history).
  const openRow = (r: SkattekontoRow) => !r.journal_entry_id && !r.is_ignored
  const referencedIds = bookedToCutoff.flatMap((r) =>
    (inHistory(r) || openRow(r) ? [r.journal_entry_id, r.suggested_journal_entry_id] : [r.journal_entry_id]).filter(
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
  // The open rows the line above leaves out: before the history, no link,
  // not ignored. The IB carries them, so they stay out of every sum below;
  // they are only listed, because Att göra counts them as unbooked and an
  // agent needs their ids to link or ignore them (crm#1153).
  const beforeHistory = historyStart
    ? bookedToCutoff.filter((r) => r.transaktionsdatum < historyStart && openRow(r))
    : []

  // Rows that point at a verifikat without being counted below: still
  // "kommande" at Skatteverket, dated after the fetched saldo, or from
  // before the history and linked to a verifikat outside it. The
  // comparison is right to leave them out (Skatteverket's saldo does not hold
  // them yet), so the verifikat stays open with its whole amount; but the
  // link is real, and a new link to the verifikat is judged with these rows
  // on it (skattekonto-link.ts reads every row that points at it). Named on
  // the verifikat so the list and the matcher say the same thing (crm#1846:
  // "unmatched" here, ALREADY_LINKED there, and no row to be seen), and
  // never proposed for another row: that link would be refused.
  const countedRowIds = new Set(booked.map((r) => r.id))
  const uncountedHolders = new Map<string, { external_ids: string[]; amount: number }>()
  for (const r of rows) {
    if (!r.journal_entry_id || r.is_ignored || countedRowIds.has(r.id)) continue
    const held = uncountedHolders.get(r.journal_entry_id) ?? { external_ids: [], amount: 0 }
    held.external_ids.push(r.id)
    held.amount = roundOre(held.amount + Number(r.belopp_skatteverket))
    uncountedHolders.set(r.journal_entry_id, held)
  }

  // Ledger side. Both reads may fail independently of the row reads; a
  // failed balance read yields null balances and a null residual rather than
  // a fabricated 0 (same posture as the drift check).
  let ledgerEntries = new Map<string, { head: EntryHead; amount: number }>()
  try {
    ledgerEntries = await fetchLedgerEntries(supabase, companyId, historyStart, cutoffDate, account)
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
  const [ledgerBalance, ledgerBeforeByDate, beforeStartOnAccount] = await Promise.all([
    floorReadFailed
      ? null
      : sumAccountBalance(supabase, companyId, account, { ...sinceFloor, cutoffDate }),
    floorReadFailed
      ? null
      : !historyStart
        ? 0
        : floor && historyStart === floor.date
          ? floor.amount
          : sumAccountBalance(supabase, companyId, account, { ...sinceFloor, beforeDate: historyStart }),
    linkedBeforeStartIds.length > 0
      ? fetchEntryIdsOnAccount(supabase, companyId, linkedBeforeStartIds, account).catch((err) => {
          log.warn('linked entries before history start read failed', {
            companyId,
            error: err instanceof Error ? err.message : String(err),
          })
          return null
        })
      : Promise.resolve<Set<string> | null>(new Set()),
  ])
  // The rows linked to those entries, not the entries' whole net: a link
  // explains exactly its rows, and what the verifikat holds beyond them
  // (rows from before the fetched history) stays opening balance.
  const linkedBeforeStart =
    beforeStartOnAccount === null
      ? null
      : booked.reduce((sum, r) => {
          if (r.is_ignored || !r.journal_entry_id || !beforeStartOnAccount.has(r.journal_entry_id)) return sum
          return heads.get(r.journal_entry_id)?.status === 'posted'
            ? roundOre(sum + Number(r.belopp_skatteverket))
            : sum
        }, 0)
  const ledgerBefore =
    ledgerBeforeByDate === null || linkedBeforeStart === null
      ? null
      : roundOre(ledgerBeforeByDate - linkedBeforeStart)
  if (ledgerBalance === null || ledgerBefore === null) ledgerReadFailed = true

  const liveLinkedEntryIds = new Set<string>()
  // What the live links explain of each verifikat: the rows' sum and count.
  const linkedByEntry = new Map<string, { sum: number; count: number }>()
  // Complete, unwindowed and uncapped, for the cover test below.
  const openEvents: Array<{ id: string; date: string; amount: number }> = []
  const ignoredEvents: DatedAmount[] = []
  const openEntries: Array<{ head: EntryHead; amount: number }> = []
  const items: SkattekontoReconciliationItems = {
    proposed: [],
    unmatched_external: [],
    unmatched_ledger: [],
    matched: [],
    ignored: [],
    upcoming: [],
    before_history: [],
  }
  let unlinkedExternalTotal = 0
  let ignoredTotal = 0
  let olderUnmatched = 0
  const counts = { proposed: 0, unmatched_external: 0, unmatched_ledger: 0, matched: 0, ignored: 0 }
  // Complete and unwindowed: the rows a standing proposal names and the
  // verifikat it names, which the ledger plan below leaves to it.
  const proposedRowIds = new Set<string>()
  const proposedEntryIds = new Set<string>()
  // Open rows whose link points at a reversed, draft or missing verifikat: a
  // new link refuses them until they are unlinked.
  const deadLinkRowIds = new Set<string>()

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
      ignoredEvents.push({ date: row.transaktionsdatum, amount })
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
      const linked = linkedByEntry.get(row.journal_entry_id) ?? { sum: 0, count: 0 }
      linkedByEntry.set(row.journal_entry_id, { sum: roundOre(linked.sum + amount), count: linked.count + 1 })
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
    openEvents.push({ id: row.id, date: row.transaktionsdatum, amount })
    if (row.journal_entry_id) deadLinkRowIds.add(row.id)
    if (olderThanWindow(row.transaktionsdatum)) olderUnmatched++

    const suggestedHead = row.suggested_journal_entry_id
      ? heads.get(row.suggested_journal_entry_id)
      : undefined
    const proposal =
      suggestedHead &&
      suggestedHead.status !== 'reversed' &&
      !liveLinkedEntryIds.has(suggestedHead.id) &&
      !uncountedHolders.has(suggestedHead.id)
        ? proposalFrom(
            suggestedHead,
            row,
            row.journal_entry_id ? [row.id] : openRowsBySuggestion.get(suggestedHead.id) ?? [row.id],
            account,
          )
        : null

    if (proposal) {
      counts.proposed++
      proposedRowIds.add(row.id)
      proposedEntryIds.add(proposal.journal_entry_id)
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
    account,
  )

  // Ledger entries in the comparable history that no storno settles and no
  // live link explains in full: an unlinked verifikat with its 1630 net, a
  // linked one with its remainder. The IB is the opening balance (in
  // ledgerBefore), not a row.
  let unlinkedLedgerTotal = 0
  const awaitingFrom = addDaysIso(cutoffDate, -AWAITING_EXTERNAL_DAYS)
  const sortedLedger = Array.from(ledgerEntries.values()).sort((a, b) =>
    a.head.entry_date < b.head.entry_date ? -1 : a.head.entry_date > b.head.entry_date ? 1 : 0,
  )
  const openCandidates: Array<{
    head: EntryHead
    entryAmount: number
    amount: number
    linked: { sum: number; count: number } | undefined
  }> = []
  for (const { head, amount: entryAmount } of sortedLedger) {
    if (settledStornoIds.has(head.id) || settledAnnulmentIds.has(head.id)) continue
    if (floorIds.has(head.id)) continue
    const linked = linkedByEntry.get(head.id)
    const amount = linked ? roundOre(entryAmount - linked.sum) : entryAmount
    if (amount === 0) continue
    openCandidates.push({ head, entryAmount, amount, linked })
  }

  // Verifikat on 1630 settled against each other (account_reconciliation_
  // settlements, the table the bank's ledger-only settlements use): the
  // verifikat a 1:N link spreads one Skatteverket event over
  // (skattekonto-split.ts). The rule is the reader's, as on the bank: a
  // settlement holds only while every verifikat of it is in this open list
  // and their open amounts sum to exactly zero. Holding, they leave
  // unmatched_ledger together; summing to zero, they move no total and
  // unexplained_difference cannot change. A broken one leaves its verifikat
  // listed, flagged. Read only when two verifikat are open: a settlement
  // needs two.
  const settlements =
    openCandidates.length >= 2
      ? await resolveLedgerSettlements(
          supabase,
          companyId,
          account,
          new Map(openCandidates.map((c) => [c.head.id, c.amount])),
          // The skattekonto ledger is not windowed: a member outside this
          // list is not open, so the settlement does not hold.
          async () => new Map(),
        )
      : null
  const settlementOf = (
    member: LedgerSettlementMember,
    state: 'settled' | 'broken',
  ): NonNullable<ReconciliationItem['settlement']> => ({
    settlement_id: member.settlement_id,
    state,
    settled_at: member.settled_at,
    settled_by: member.settled_by,
    counterparts: (settlements?.groups.get(member.settlement_id) ?? [])
      .filter((m) => m.journal_entry_id !== member.journal_entry_id)
      .map((m) => {
        const other = ledgerEntries.get(m.journal_entry_id)?.head
        return {
          journal_entry_id: m.journal_entry_id,
          voucher_series: other?.voucher_series ?? null,
          voucher_number: other?.voucher_number ?? null,
          entry_date: other?.entry_date ?? null,
          amount: m.amount,
        }
      }),
  })

  const openLedger = new Map<string, SkattekontoOpenLedgerEntry>()
  for (const { head, entryAmount, amount, linked } of openCandidates) {
    const holders = uncountedHolders.get(head.id)
    const ledgerItem = {
      item_id: head.id,
      item_type: 'journal_entry' as const,
      side: 'ledger' as const,
      date: head.entry_date,
      description: head.description ?? '',
      amount,
      currency: 'SEK',
      voucher_number: head.voucher_number,
      voucher_series: head.voucher_series,
      entry_status: head.status,
      ...(linked
        ? { partially_linked: { entry_amount: entryAmount, linked_amount: linked.sum, linked_count: linked.count } }
        : {}),
      ...(holders
        ? {
            held_by_uncounted_rows: {
              count: holders.external_ids.length,
              amount: holders.amount,
              external_ids: holders.external_ids.slice(0, MAX_HOLDER_IDS),
            },
          }
        : {}),
    }
    const settled = settlements?.settled.get(head.id)
    if (settled) {
      if (visible(head.entry_date)) {
        pushCapped('matched', {
          ...ledgerItem,
          bucket: 'matched',
          settlement: settlementOf(settled.member, 'settled'),
          actions: ['unmatch'],
        })
      }
      continue
    }
    unlinkedLedgerTotal = roundOre(unlinkedLedgerTotal + amount)
    openEntries.push({ head, amount })
    openLedger.set(head.id, { journal_entry_id: head.id, amount, status: head.status, entry_date: head.entry_date })
    counts.unmatched_ledger++
    if (olderThanWindow(head.entry_date)) olderUnmatched++
    if (!visible(head.entry_date)) continue
    const broken = settlements?.broken.get(head.id)
    pushCapped('unmatched_ledger', {
      ...ledgerItem,
      bucket: 'unmatched_ledger',
      awaiting_external: head.entry_date >= awaitingFrom,
      ...(broken ? { settlement: settlementOf(broken, 'broken') } : {}),
      actions: broken ? ['review', 'match', 'unmatch'] : ['review', 'match'],
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
      // An upcoming row booked ahead holds its verifikat already.
      ...(row.journal_entry_id ? { linked_journal_entry_id: row.journal_entry_id } : {}),
      actions: [],
    })
  }

  // Listed only: no total, count or cover below reads them. A standing
  // proposal (often the imported verifikat that holds the event) rides
  // along so the row can be linked to it; a verifikat some row already links
  // to is not offered.
  const linkedEntryIds = new Set(bookedToCutoff.flatMap((r) => (r.journal_entry_id ? [r.journal_entry_id] : [])))
  const beforeHistoryBySuggestion = new Map<string, string[]>()
  for (const row of beforeHistory) {
    if (!row.suggested_journal_entry_id) continue
    const list = beforeHistoryBySuggestion.get(row.suggested_journal_entry_id) ?? []
    list.push(row.id)
    beforeHistoryBySuggestion.set(row.suggested_journal_entry_id, list)
  }
  let beforeHistoryTotal = 0
  for (const row of beforeHistory) {
    const amount = roundOre(Number(row.belopp_skatteverket))
    beforeHistoryTotal = roundOre(beforeHistoryTotal + amount)
    if (!visible(row.transaktionsdatum)) continue
    const suggestedHead = row.suggested_journal_entry_id ? heads.get(row.suggested_journal_entry_id) : undefined
    pushCapped('before_history', {
      item_id: row.id,
      item_type: 'skattekonto_transaction',
      side: 'external',
      bucket: 'before_history',
      date: row.transaktionsdatum,
      description: row.transaktionstext,
      amount,
      currency: 'SEK',
      linked_journal_entry_id: null,
      proposal:
        suggestedHead && suggestedHead.status !== 'reversed' && !linkedEntryIds.has(suggestedHead.id)
          ? proposalFrom(suggestedHead, row, beforeHistoryBySuggestion.get(suggestedHead.id) ?? [row.id], account)
          : null,
      before_history: true,
      actions: ['match', 'ignore'],
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

  // Rows that exactly one open verifikat holds (a monthly summary from the
  // previous system, PH 171) become proposals, so every door that links
  // proposals links them in one action, and the booking guard refuses them
  // (plannedHolds). Not on a failed ledger read.
  const plannedHolds = new Map<string, SkattekontoPlannedHold>()
  if (!ledgerReadFailed) {
    const planned = planSkattekontoLedgerLinks({
      rows: openEvents
        .filter((e) => !proposedRowIds.has(e.id))
        .map((e) => ({ ...e, linkable: !deadLinkRowIds.has(e.id) })),
      entries: openEntries
        .filter((e) => !proposedEntryIds.has(e.head.id))
        .map(({ head, amount }) => ({
          id: head.id,
          date: head.entry_date,
          amount,
          // A verifikat a link refuses: not posted, or held by rows already.
          linkable: head.status === 'posted' && !uncountedHolders.has(head.id),
        })),
    })
    const openById = new Map(openEntries.map((e) => [e.head.id, e]))
    proposeLedgerPlan({
      planned,
      heads: new Map(openEntries.map((e) => [e.head.id, e.head])),
      items,
      counts,
      account,
    })
    for (const link of planned) {
      const open = openById.get(link.journal_entry_id)
      if (!open) continue
      const hold: SkattekontoPlannedHold = {
        entry: {
          journal_entry_id: open.head.id,
          voucher_number: open.head.voucher_number,
          voucher_series: open.head.voucher_series,
          entry_date: open.head.entry_date,
          description: open.head.description ?? '',
          status: open.head.status,
          open_amount: open.amount,
        },
        event_ids: link.event_ids,
        total: link.total,
        from_date: link.from_date,
        to_date: link.to_date,
      }
      for (const id of link.event_ids) plannedHolds.set(id, hold)
    }
  }

  // Open rows the ledger already holds through open verifikat (see
  // findLedgerCoverPoint). Not computed on a failed ledger read: an
  // empty ledger side would read as "nothing covers anything".
  const coverPoint = ledgerReadFailed
    ? null
    : findLedgerCoverPoint({
        openEvents,
        openEntries: openEntries.map((e) => ({ id: e.head.id, date: e.head.entry_date, amount: e.amount })),
        ignoredEvents,
        openingDifference,
      })
  let cover: SkattekontoLedgerCover | null = null
  if (coverPoint) {
    const coveredEvents = openEvents.filter((e) => e.date <= coverPoint.through_date)
    const coveringEntries = openEntries
      .filter((e) => e.head.entry_date <= coverPoint.through_date)
      .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
    cover = {
      account_number: account,
      through_date: coverPoint.through_date,
      kind: coverPoint.kind,
      event_ids: coveredEvents.map((e) => e.id),
      event_count: coveredEvents.length,
      event_total: coveredEvents.reduce((sum, e) => roundOre(sum + e.amount), 0),
      entries: coveringEntries.map(({ head, amount }) => ({
        journal_entry_id: head.id,
        voucher_number: head.voucher_number,
        voucher_series: head.voucher_series,
        entry_date: head.entry_date,
        description: head.description ?? '',
        status: head.status,
        open_amount: amount,
      })),
      entry_total: coveringEntries.reduce((sum, e) => roundOre(sum + e.amount), 0),
    }
    const coveredIds = new Set(cover.event_ids)
    for (const item of [...items.proposed, ...items.unmatched_external]) {
      if (coveredIds.has(item.item_id)) item.covered_by_ledger = true
    }
  }

  const isReconciled =
    !!snapshot &&
    !ledgerReadFailed &&
    counts.unmatched_external === 0 &&
    counts.proposed === 0 &&
    counts.unmatched_ledger === 0 &&
    Math.abs(openingDifference ?? 0) < 0.01 &&
    Math.abs(unexplained ?? 0) < 0.01

  // A balance this status does not know is no bridge line (crm#1701): with
  // no saldo from Skatteverket (rows from a file import, never fetched) the
  // line read "Saldo hos Skatteverket 0 kr", and a failed ledger read put
  // 0 kr on the ledger side. The status carries null; readers say unknown.
  const bridge: BridgeLine[] = []
  if (saldo !== null) {
    bridge.push({
      key: 'external_balance',
      label_sv: 'Saldo hos Skatteverket',
      label_en: 'Balance at Skatteverket',
      amount: saldo,
      count: null,
      items_bucket: null,
    })
  }
  bridge.push(
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
      label_sv: `Rader på ${account} utan händelse hos Skatteverket`,
      label_en: `${account} lines without a Skatteverket event`,
      amount: unlinkedLedgerTotal,
      count: counts.unmatched_ledger,
      items_bucket: 'unmatched_ledger',
    },
  )
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
  if (ledgerBalance !== null) {
    bridge.push({
      key: 'ledger_balance',
      label_sv: `Bokfört på ${account}`,
      label_en: `Booked on ${account}`,
      amount: ledgerBalance,
      count: null,
      items_bucket: null,
    })
  }

  const truncated = (Object.keys(items) as Array<keyof SkattekontoReconciliationItems>).filter(
    (k) => items[k].length >= MAX_ITEMS_PER_BUCKET,
  )

  const result: SkattekontoReconciliationResult = {
    account_key: SKATTEKONTO_ACCOUNT_KEY,
    kind: 'skattekonto',
    account_number: account,
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
      saldo_missing_reason: saldoMissingReason,
      fetched_at: snapshot ? snapshot.fetchedAt.toISOString() : null,
      history_start: historyStart,
      opening_difference: openingDifference,
      upcoming_count: upcoming.length,
      upcoming_total: upcomingTotal,
      ledger_balance_before_start: ledgerBefore,
      before_history_count: beforeHistory.length,
      before_history_total: beforeHistoryTotal,
      covered: cover
        ? {
            through_date: cover.through_date,
            kind: cover.kind,
            event_count: cover.event_count,
            event_total: cover.event_total,
            journal_entry_ids: cover.entries.slice(0, MAX_COVER_ENTRY_IDS).map((e) => e.journal_entry_id),
            entry_count: cover.entries.length,
          }
        : null,
    },
    bank: null,
    items,
    items_truncated: truncated,
    older_unmatched_count: olderUnmatched,
    ledger_read_failed: ledgerReadFailed,
    cover,
  }
  openLedgerOfStatus.set(result, openLedger)
  plannedHoldsOfStatus.set(result, plannedHolds)
  return result
}
