import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre } from '@/lib/money'
import { dbError } from '@/lib/errors/db-error'
import {
  assertTransactionScope,
  fetchUnlinkedGLLines,
  isUnlinkableBankLink,
  openAmountByEntry,
  type UnlinkedGLLine,
} from './bank-reconciliation'
import { findStaleBankAnchors, type StaleAnchorRow } from '@/lib/transactions/stale-bank-anchor'
import { getSkattekontoReconciliationStatus } from './skattekonto-reconciliation'
import { proposeCoveringSets } from './covering-set-candidate'
import {
  fetchLiveLedgerSettlements,
  resolveLedgerSettlements,
  type LedgerSettlementMember,
} from './ledger-settlement-store'
import {
  parseAccountKey,
  type ReconciliationItem,
  type ReconciliationItemBucket,
  type ReconciliationProposal,
} from './schemas'

/**
 * Item listing for one account, in the page's buckets, paginated with
 * limit/offset (the MCP convention; the v1 door wraps this in its cursor).
 *
 * Skattekonto items come straight from the engine (which already buckets
 * and windows them). Bank items are built from the same sources the bank
 * page uses: the account-scoped transactions for the external side and the
 * unlinked-GL-lines RPC for the ledger side; the bank matcher's proposals are
 * the rows carrying potential_journal_entry_id.
 */

export const DEFAULT_ITEMS_LIMIT = 50
export const MAX_ITEMS_LIMIT = 200
/**
 * Matched bank rows the first read returns ahead of the page's end, so a
 * page that reaches into them needs no second read of the window. Deeper
 * pages read their slice on their own.
 */
const MATCHED_PREFIX_MAX = 2 * MAX_ITEMS_LIMIT

/**
 * Bucket order when no bucket is requested: what to do first, first.
 * before_history is not in it: those rows are outside the bridge and are
 * listed only when asked for by name (the result's before_history says how
 * many there are).
 */
export const BUCKET_ORDER: readonly ReconciliationItemBucket[] = [
  'proposed',
  'unmatched_external',
  'unmatched_ledger',
  'ignored',
  'upcoming',
  'matched',
]

export interface ListItemsOptions {
  bucket?: ReconciliationItemBucket
  windowFrom?: string | null
  windowTo?: string | null
  limit?: number
  offset?: number
  today?: string
}

export interface ListItemsResult {
  items: ReconciliationItem[]
  count: number
  total_count: number
  has_more: boolean
  next_offset?: number
  /** Unmatched rows dated before windowFrom (never hidden, only counted). */
  older_unmatched_count: number
  /**
   * When any: rows dated before history_start, which no default listing
   * shows (bucket before_history lists them). Skattekonto: open Skatteverket
   * rows the 1630 IB carries (crm#1153). Bank: verifikat on the account from
   * before the first day the bank side covers, which no bank row can match
   * (crm#1221).
   */
  before_history?: { count: number; total: number; history_start: string | null }
}

interface CashAccountRow {
  id: string
  ledger_account: string
  currency: string | null
  is_primary: boolean | null
}

/** A bank row as get_bank_reconciliation_items lists it. */
interface BankItemRow {
  id: string
  date: string
  description: string | null
  merchant_name: string | null
  amount: number | string
  currency: string
  journal_entry_id: string | null
  potential_journal_entry_id: string | null
  potential_match_method: string | null
  potential_match_confidence: number | string | null
  is_ignored: boolean | null
  reconciliation_method: string | null
  /** Linked by its pointer or by the transaction_voucher_links rows the listing reads for it. */
  linked: boolean
  /** The pointer, else the first of those links (bank_line anchors first). */
  linked_journal_entry_id: string | null
}

interface BankItemRead {
  /** Every row of the window that is not matched: ignored or open, newest first. */
  open_rows: BankItemRow[]
  matched_count: number
  /** The requested slice of the matched rows, newest first. */
  matched_rows: BankItemRow[]
  history_start: string | null
  ledger_lines: UnlinkedGLLine[]
  fiscal_year_starts: string[]
}

/**
 * The bank rows of one account's window, aligned to their verifikat, plus
 * on request the ledger side: one call to get_bank_reconciliation_items
 * (20261023094100), which applies the rules this listing used to page every
 * row of the window through PostgREST for. A failed read throws: a partial
 * answer would offer Bokför on a row that is booked.
 */
async function readBankItemRows(
  supabase: SupabaseClient,
  companyId: string,
  account: CashAccountRow,
  currency: string,
  options: {
    windowFrom: string | null
    windowTo: string | null
    withRows: boolean
    withLedger: boolean
    matchedOffset: number
    matchedLimit: number
    /** Shorten the matched slice by the open rows, which the listing shows first. */
    matchedAfterOpen?: boolean
  },
): Promise<BankItemRead> {
  assertTransactionScope(account.id, currency)
  const { data, error } = await supabase.rpc('get_bank_reconciliation_items', {
    p_company_id: companyId,
    p_account_number: account.ledger_account,
    p_currency: currency,
    p_cash_account_id: account.id,
    // Only the company's primary cash account claims rows with no cash
    // account (scopeTransactionsToAccount).
    p_include_unassigned: Boolean(account.is_primary),
    p_date_from: options.windowFrom || null,
    p_date_to: options.windowTo || null,
    p_with_rows: options.withRows,
    p_with_ledger: options.withLedger,
    p_matched_offset: options.matchedOffset,
    p_matched_limit: options.matchedLimit,
    p_matched_after_open: options.matchedAfterOpen ?? false,
  })
  if (error) throw new Error(`Kunde inte hämta transaktioner: ${dbError(error, null).message}`)
  const read = (data ?? {}) as Partial<BankItemRead>
  return {
    open_rows: read.open_rows ?? [],
    matched_count: Number(read.matched_count ?? 0),
    matched_rows: read.matched_rows ?? [],
    history_start: read.history_start ?? null,
    ledger_lines: read.ledger_lines ?? [],
    fiscal_year_starts: read.fiscal_year_starts ?? [],
  }
}

/**
 * The matcher's persisted 1:1 proposal on a bank row. The matcher persists
 * only the verifikat id; attachEntries fills in its label, date and text
 * once the page is cut.
 */
function persistedBankProposal(tx: BankItemRow): ReconciliationProposal | null {
  if (!tx.potential_journal_entry_id) return null
  return {
    journal_entry_id: tx.potential_journal_entry_id,
    voucher_number: null,
    voucher_series: null,
    entry_date: tx.date,
    description: '',
    entry_status: 'posted',
    confidence: Number(tx.potential_match_confidence ?? 0.75),
    reasons: [tx.potential_match_method ?? 'föreslagen av matcharen'],
  }
}

/**
 * Rows nothing explains 1:1 are searched for a set of unlinked verifikat
 * summing exactly to them (#2293) before they are offered as unmatched:
 * "Bokför" is the door only when the ledger has nothing for the row.
 */
function bankCoveringSets(
  supabase: SupabaseClient,
  companyId: string,
  account: CashAccountRow,
  rows: BankItemRow[],
): Promise<Map<string, ReconciliationProposal>> {
  return proposeCoveringSets(
    supabase,
    companyId,
    account,
    rows
      .filter((tx) => !tx.is_ignored && !tx.linked && !tx.potential_journal_entry_id)
      .map((tx) => ({ id: tx.id, date: tx.date, amount: Number(tx.amount), currency: tx.currency })),
  )
}

/** A bank row of bucket `proposed` and what it is proposed to link to. */
export interface ProposedBankRow {
  transaction_id: string
  /** The bank row's date. */
  date: string
  /** How it was proposed: the matcher's method, or the covering set's kind (exact_sum_same_date). */
  method: string | null
  proposal: ReconciliationProposal
}

/**
 * Every bank row of one account in bucket `proposed`, with its proposal: the
 * matcher's persisted 1:1 match, else a covering set of verifikat summing
 * exactly to the row. The rows and the rule are the listing's own, so
 * use_proposals links what list_reconciliation_items shows (crm#1668): it
 * read the persisted column alone and never saw a sum-matched row. null when
 * the account is not the company's.
 */
export async function readProposedBankRows(
  supabase: SupabaseClient,
  companyId: string,
  cashAccountId: string,
): Promise<ProposedBankRow[] | null> {
  const { data: account, error } = await supabase
    .from('cash_accounts')
    .select('id, ledger_account, currency, is_primary')
    .eq('company_id', companyId)
    .eq('id', cashAccountId)
    .maybeSingle<CashAccountRow>()
  if (error) throw new Error(`Kunde inte hämta kassakonto: ${error.message}`)
  if (!account) return null
  const read = await readBankItemRows(supabase, companyId, account, account.currency ?? 'SEK', {
    windowFrom: null,
    windowTo: null,
    withRows: true,
    withLedger: false,
    matchedOffset: 0,
    matchedLimit: 0,
  })
  const coveringSets = await bankCoveringSets(supabase, companyId, account, read.open_rows)
  const proposed: ProposedBankRow[] = []
  for (const tx of read.open_rows) {
    if (tx.is_ignored) continue
    const persisted = persistedBankProposal(tx)
    const proposal = persisted ?? coveringSets.get(tx.id) ?? null
    if (!proposal) continue
    const method = persisted ? tx.potential_match_method : (proposal.reasons[0] ?? null)
    proposed.push({ transaction_id: tx.id, date: tx.date, method, proposal })
  }
  return proposed
}

function clampLimit(limit?: number): number {
  if (!limit || !Number.isFinite(limit) || limit < 1) return DEFAULT_ITEMS_LIMIT
  return Math.min(Math.floor(limit), MAX_ITEMS_LIMIT)
}

function page<T>(all: T[], limit: number, offset: number): ListItemsResult & { items: T[] } {
  const items = all.slice(offset, offset + limit)
  const hasMore = offset + limit < all.length
  return {
    items,
    count: items.length,
    total_count: all.length,
    has_more: hasMore,
    ...(hasMore ? { next_offset: offset + limit } : {}),
    older_unmatched_count: 0,
  } as ListItemsResult & { items: T[] }
}

/**
 * A linked row shows its verifikat, not an id, and so does a bank matcher
 * proposal, whose row carries only potential_journal_entry_id: date, label
 * and text come from journal_entries in one batched read after the items are
 * built. Without it a proposed pair showed an id prefix and the bank date
 * where the verifikat's label, text and date belong.
 */
async function attachEntries(
  supabase: SupabaseClient,
  companyId: string,
  items: ReconciliationItem[],
  bareProposals: ReconciliationProposal[] = [],
): Promise<void> {
  const ids = [
    ...new Set(
      [...items.map((i) => i.linked_journal_entry_id), ...bareProposals.map((p) => p.journal_entry_id)].filter(
        (x): x is string => !!x,
      ),
    ),
  ]
  if (ids.length === 0) return
  const byId = new Map<string, NonNullable<ReconciliationItem['linked_entry']>>()
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await supabase
      .from('journal_entries')
      .select('id, entry_date, voucher_series, voucher_number, description')
      .eq('company_id', companyId)
      .in('id', ids.slice(i, i + 200))
    for (const r of (data ?? []) as Array<{ id: string; entry_date: string; voucher_series: string | null; voucher_number: number | null; description: string | null }>) {
      byId.set(r.id, { entry_date: r.entry_date, voucher_series: r.voucher_series, voucher_number: r.voucher_number, description: r.description ?? '' })
    }
  }
  for (const it of items) {
    if (!it.linked_journal_entry_id) continue
    const meta = byId.get(it.linked_journal_entry_id)
    if (meta) it.linked_entry = meta
  }
  // A proposal whose verifikat is not found keeps its fallback (bank date, no label).
  for (const p of bareProposals) {
    const meta = byId.get(p.journal_entry_id)
    if (!meta) continue
    p.entry_date = meta.entry_date
    p.voucher_series = meta.voucher_series
    p.voucher_number = meta.voucher_number
    p.description = meta.description
  }
}

/**
 * A matched row booked from itself offers no action (PH 194), except a row the
 * user created whose verifikat books no bank line: it is no movement on the
 * bank, and ignoring it is its way out (PH 214,
 * lib/transactions/stale-bank-anchor.ts). Read after the page is cut, for its
 * matched rows only; a failed read offers nothing new.
 */
async function offerIgnoreOnStaleAnchors(
  supabase: SupabaseClient,
  companyId: string,
  items: ReconciliationItem[],
): Promise<void> {
  const ids = items
    .filter((i) => i.item_type === 'transaction' && i.bucket === 'matched' && i.actions.length === 0 && i.linked_journal_entry_id)
    .map((i) => i.item_id)
  if (ids.length === 0) return
  const { data, error } = await supabase
    .from('transactions')
    .select('id, journal_entry_id, cash_account_id, currency, amount, bank_connection_id, import_source, invoice_id, supplier_invoice_id')
    .eq('company_id', companyId)
    .in('id', ids)
  if (error || !data) return
  const stale = await findStaleBankAnchors(supabase, companyId, data as unknown as StaleAnchorRow[])
  for (const it of items) if (stale.has(it.item_id)) it.actions = ['ignore']
}

/**
 * Move the verifikat that are settled against each other (a wrong verifikat
 * and the rättelse booked by hand, crm#1074) out of the ledger-only list and
 * into `matched`, each naming the verifikat it is settled against. A verifikat
 * whose settlement no longer holds stays where it is, flagged `broken`, with
 * the undo among its actions. Called after every other read of the listing.
 */
async function applyLedgerSettlements(
  supabase: SupabaseClient,
  companyId: string,
  ledgerAccount: string,
  currency: string,
  window: { from: string | null; to: string | null },
  buckets: ReconciliationItemBucket[],
  byBucket: Map<ReconciliationItemBucket, ReconciliationItem[]>,
  ledgerItems: Map<string, ReconciliationItem> | null,
): Promise<void> {
  const fetchOpen = async (from?: string, to?: string) => {
    const lines = await fetchUnlinkedGLLines(supabase, companyId, ledgerAccount, from, to)
    return { lines, open: openAmountByEntry(lines, 'SEK') }
  }
  // The ledger bucket already built its rows; a request for `matched` alone
  // reads the list only when the account has a settlement to show.
  let live: LedgerSettlementMember[] | undefined
  let items = ledgerItems
  if (!items) {
    // A failed read shows no settlement here, as before: the listing itself
    // must not fail over the pairs it decorates.
    let read: Awaited<ReturnType<typeof fetchOpen>>
    try {
      live = await fetchLiveLedgerSettlements(supabase, companyId, ledgerAccount)
      if (live.length === 0) return
      read = await fetchOpen(window.from ?? undefined, window.to ?? undefined)
    } catch {
      return
    }
    const { lines, open } = read
    items = new Map()
    for (const l of lines) {
      if (items.has(l.journal_entry_id)) continue
      items.set(l.journal_entry_id, {
        item_id: l.journal_entry_id,
        item_type: 'journal_entry',
        side: 'ledger',
        bucket: 'unmatched_ledger',
        date: l.entry_date,
        description: l.entry_description || l.line_description || '',
        amount: open.get(l.journal_entry_id) ?? 0,
        currency,
        voucher_number: l.voucher_number,
        voucher_series: l.voucher_series,
        entry_status: 'posted',
        actions: ['match', 'review'],
      })
    }
  }
  if (items.size === 0) return

  const windowOpen = new Map<string, number | null>()
  for (const [id, item] of items) windowOpen.set(id, item.amount)
  const resolved = await resolveLedgerSettlements(
    supabase,
    companyId,
    ledgerAccount,
    windowOpen,
    async (from, to) => (await fetchOpen(from, to)).open,
    live,
  )
  if (resolved.settled.size === 0 && resolved.broken.size === 0) return

  // A settled verifikat names the others of its settlement: label and date
  // for those the window does not hold come from one batched read.
  const labels = new Map<string, { voucher_series: string | null; voucher_number: number | null; entry_date: string | null }>()
  for (const [id, item] of items) {
    labels.set(id, { voucher_series: item.voucher_series ?? null, voucher_number: item.voucher_number ?? null, entry_date: item.date })
  }
  const unlabelled = [...new Set([...resolved.groups.values()].flat().map((m) => m.journal_entry_id))].filter((id) => !labels.has(id))
  for (let i = 0; i < unlabelled.length; i += 200) {
    const { data } = await supabase
      .from('journal_entries')
      .select('id, entry_date, voucher_series, voucher_number')
      .eq('company_id', companyId)
      .in('id', unlabelled.slice(i, i + 200))
    for (const r of (data ?? []) as Array<{ id: string; entry_date: string; voucher_series: string | null; voucher_number: number | null }>) {
      labels.set(r.id, { voucher_series: r.voucher_series, voucher_number: r.voucher_number, entry_date: r.entry_date })
    }
  }
  const settlementOf = (member: LedgerSettlementMember, state: 'settled' | 'broken'): NonNullable<ReconciliationItem['settlement']> => ({
    settlement_id: member.settlement_id,
    state,
    settled_at: member.settled_at,
    settled_by: member.settled_by,
    counterparts: (resolved.groups.get(member.settlement_id) ?? [])
      .filter((m) => m.journal_entry_id !== member.journal_entry_id)
      .map((m) => ({
        journal_entry_id: m.journal_entry_id,
        voucher_series: labels.get(m.journal_entry_id)?.voucher_series ?? null,
        voucher_number: labels.get(m.journal_entry_id)?.voucher_number ?? null,
        entry_date: labels.get(m.journal_entry_id)?.entry_date ?? null,
        amount: m.amount,
      })),
  })

  const ledgerBucket = byBucket.get('unmatched_ledger')
  if (ledgerBucket) {
    byBucket.set(
      'unmatched_ledger',
      ledgerBucket.filter((item) => !resolved.settled.has(item.item_id)),
    )
    for (const item of byBucket.get('unmatched_ledger') ?? []) {
      const member = resolved.broken.get(item.item_id)
      if (!member) continue
      item.settlement = settlementOf(member, 'broken')
      item.actions = [...item.actions, 'unmatch']
    }
  }
  if (buckets.includes('matched')) {
    const settledItems: ReconciliationItem[] = []
    for (const [id, entry] of resolved.settled) {
      const item = items.get(id)
      if (!item) continue
      settledItems.push({
        ...item,
        bucket: 'matched',
        ib_eligible: undefined,
        settlement: settlementOf(entry.member, 'settled'),
        actions: ['unmatch'],
      })
    }
    byBucket.set('matched', [...(byBucket.get('matched') ?? []), ...settledItems])
  }
}

export async function listAccountItems(
  supabase: SupabaseClient,
  companyId: string,
  accountKey: string,
  options: ListItemsOptions = {},
): Promise<ListItemsResult | null> {
  const parsed = parseAccountKey(accountKey)
  if (!parsed) return null
  const limit = clampLimit(options.limit)
  const offset = Math.max(0, Math.floor(options.offset ?? 0))

  // A manual account has no external rows to bucket: its bridge is IB,
  // movement and UB against a specification or the signer's underlag.
  if (parsed.kind === 'manual') {
    return { items: [], count: 0, total_count: 0, has_more: false, older_unmatched_count: 0 }
  }

  if (parsed.kind === 'skattekonto') {
    const status = await getSkattekontoReconciliationStatus(supabase, companyId, {
      today: options.today,
      windowFrom: options.windowFrom ?? null,
      windowTo: options.windowTo ?? null,
    })
    if (!status) return null
    const all = options.bucket
      ? status.items[options.bucket]
      : BUCKET_ORDER.flatMap((b) => status.items[b])
    await attachEntries(supabase, companyId, all)
    const beforeHistoryCount = status.skattekonto?.before_history_count ?? 0
    return {
      ...page(all, limit, offset),
      older_unmatched_count: status.older_unmatched_count,
      ...(beforeHistoryCount > 0
        ? {
            before_history: {
              count: beforeHistoryCount,
              total: status.skattekonto?.before_history_total ?? 0,
              history_start: status.skattekonto?.history_start ?? null,
            },
          }
        : {}),
    }
  }

  if (parsed.kind === 'bank') {
    const { data: account, error } = await supabase
      .from('cash_accounts')
      .select('id, ledger_account, currency, is_primary')
      .eq('company_id', companyId)
      .eq('id', parsed.cashAccountId)
      .maybeSingle<CashAccountRow>()
    if (error) throw new Error(`Kunde inte hämta kassakonto: ${error.message}`)
    if (!account) return null
    const currency = account.currency ?? 'SEK'
    const buckets = options.bucket ? [options.bucket] : [...BUCKET_ORDER]
    const byBucket = new Map<ReconciliationItemBucket, ReconciliationItem[]>()
    const push = (item: ReconciliationItem) => {
      byBucket.set(item.bucket, [...(byBucket.get(item.bucket) ?? []), item])
    }
    // The matcher's proposals on rows in `proposed`: attachEntries gives them
    // their verifikat's label, date and text once the page is cut.
    const persistedProposals = new Set<ReconciliationProposal>()

    const wantsExternal = buckets.some((b) =>
      ['proposed', 'unmatched_external', 'matched', 'ignored'].includes(b),
    )
    // The bank's history (crm#1221): verifikat dated before the first day the
    // bank side covers have no bank row to match. When that day falls inside
    // the window they are listed in before_history, not as missing on the
    // bank, the split getReconciliationStatus counts them by.
    const wantsLedger = buckets.includes('unmatched_ledger') || buckets.includes('before_history')
    const wantsMatched = buckets.includes('matched')
    // Matched rows are the bulk of a busy account and come last in the
    // listing, so only the page's slice of them is read. With `matched` the
    // only bucket nothing precedes them, and the slice is known up front.
    // Otherwise every open row comes before them, so the slice lies within
    // the matched rows up to the page's end less the open rows: read those
    // with it when they are few.
    const matchedFirst = buckets.length === 1 && wantsMatched
    const matchedPrefix = !matchedFirst && wantsMatched && offset + limit <= MATCHED_PREFIX_MAX
    const read = await readBankItemRows(supabase, companyId, account, currency, {
      windowFrom: options.windowFrom ?? null,
      windowTo: options.windowTo ?? null,
      withRows: wantsExternal,
      withLedger: wantsLedger,
      matchedOffset: matchedFirst ? offset : 0,
      matchedLimit: matchedFirst ? limit : matchedPrefix ? offset + limit : 0,
      matchedAfterOpen: matchedPrefix,
    })

    // One item per bank row of the window, in the listing's order (newest
    // first, id as tiebreaker). A linked row belongs to the window of its
    // verifikat, not its own date, the same rule getReconciliationStatus
    // counts matched_count and the difference by.
    const toItem = (
      tx: BankItemRow,
      bucket: ReconciliationItemBucket,
      coveringSet: ReconciliationProposal | null,
    ): ReconciliationItem => {
      // Live proposals only: a matched row can keep a stale pointer (a
      // multi-row bulk_book links through the junction and never clears
      // it), and a real voucher label there would read as the row's link.
      const persisted = persistedBankProposal(tx)
      if (persisted && bucket === 'proposed') persistedProposals.add(persisted)
      // A row booked from itself is undone by storno of its verifikat,
      // never unlinked, so it offers no unmatch (PH 194).
      const matchedActions: ReconciliationItem['actions'] = isUnlinkableBankLink(tx) ? ['unmatch'] : []
      return {
        item_id: tx.id,
        item_type: 'transaction',
        side: 'external',
        bucket,
        date: tx.date,
        description: tx.merchant_name || tx.description || '',
        amount: roundOre(Number(tx.amount)),
        currency: tx.currency,
        linked_journal_entry_id: tx.linked_journal_entry_id ?? null,
        proposal: persisted ?? coveringSet,
        actions:
          bucket === 'matched'
            ? matchedActions
            : bucket === 'ignored'
              ? ['unignore']
              : bucket === 'proposed'
                ? ['match', 'book', 'ignore']
                : ['book', 'match', 'ignore'],
      }
    }

    if (wantsExternal) {
      const coveringSets = buckets.some((b) => b === 'proposed' || b === 'unmatched_external')
        ? await bankCoveringSets(supabase, companyId, account, read.open_rows)
        : new Map<string, ReconciliationProposal>()
      for (const tx of read.open_rows) {
        const coveringSet = coveringSets.get(tx.id) ?? null
        const bucket: ReconciliationItemBucket = tx.is_ignored
          ? 'ignored'
          : tx.potential_journal_entry_id || coveringSet
            ? 'proposed'
            : 'unmatched_external'
        if (!buckets.includes(bucket)) continue
        push(toItem(tx, bucket, coveringSet))
      }
    }

    const historyStart = wantsLedger ? read.history_start : null
    const splitAt =
      historyStart &&
      (!options.windowFrom || historyStart > options.windowFrom) &&
      (!options.windowTo || historyStart <= options.windowTo)
        ? historyStart
        : null

    let ledgerItems: Map<string, ReconciliationItem> | null = null
    if (wantsLedger) {
      const lines = read.ledger_lines
      // One item per entry: several 1930 lines of one voucher net, as a link
      // settles the voucher. A voucher 1:N slices settle in part shows only
      // what they leave open (agent feedback seq 854089). Amounts in SEK, as
      // the ledger side has always been listed here.
      const openByEntry = openAmountByEntry(lines, 'SEK')
      const periodStarts = new Set(read.fiscal_year_starts)
      const byEntry = new Map<string, ReconciliationItem>()
      for (const l of lines) {
        if (byEntry.has(l.journal_entry_id)) continue
        byEntry.set(l.journal_entry_id, {
          item_id: l.journal_entry_id,
          item_type: 'journal_entry',
          side: 'ledger',
          bucket: 'unmatched_ledger',
          date: l.entry_date,
          description: l.entry_description || l.line_description || '',
          amount: openByEntry.get(l.journal_entry_id) ?? 0,
          currency,
          voucher_number: l.voucher_number,
          voucher_series: l.voucher_series,
          entry_status: 'posted',
          // mark_entry_as_opening_balance accepts only this shape: a manual or
          // imported verifikat dated on its fiscal year's first day, with no
          // bank link. Anything else is a movement in the year, so "Märk som
          // IB" is not offered for it (agent feedback seq 878478).
          ib_eligible:
            periodStarts.has(l.entry_date) &&
            (l.source_type === 'manual' || l.source_type === 'import') &&
            l.remaining_amount == null,
          actions: ['match', 'review'],
        })
      }
      for (const it of byEntry.values()) push(it)
      ledgerItems = byEntry
    }

    if (wantsLedger || wantsMatched) {
      await applyLedgerSettlements(
        supabase,
        companyId,
        account.ledger_account,
        currency,
        { from: options.windowFrom ?? null, to: options.windowTo ?? null },
        buckets,
        byBucket,
        ledgerItems,
      )
    }
    // After the settlements: a settled verifikat is explained wherever it is
    // dated, so only the open ones move. Nothing to match them with, so the
    // verifikat itself is the action.
    let beforeHistory: ListItemsResult['before_history']
    if (splitAt) {
      const ledger = byBucket.get('unmatched_ledger') ?? []
      const before = ledger.filter((item) => item.date < splitAt)
      byBucket.set('unmatched_ledger', ledger.filter((item) => item.date >= splitAt))
      byBucket.set(
        'before_history',
        before.map((item) => ({
          ...item,
          bucket: 'before_history' as const,
          before_history: true,
          actions: item.actions.filter((a) => a !== 'match'),
        })),
      )
      if (before.length > 0) {
        beforeHistory = {
          count: before.length,
          total: roundOre(before.reduce((sum, item) => sum + item.amount, 0)),
          history_start: splitAt,
        }
      }
    }

    // The listing in bucket order: the matched bucket is its bank rows, as
    // counted by the read, then the verifikat a settlement explains. Only the
    // page's part of the bank rows is materialised.
    const head = buckets.filter((b) => b !== 'matched').flatMap((b) => byBucket.get(b) ?? [])
    const settledItems = wantsMatched ? (byBucket.get('matched') ?? []) : []
    const matchedCount = wantsMatched ? read.matched_count : 0
    const total = head.length + matchedCount + settledItems.length
    const end = Math.min(total, offset + limit)
    const matchedFrom = Math.max(offset, head.length) - head.length
    const matchedTo = Math.min(end, head.length + matchedCount) - head.length
    let matchedRows: BankItemRow[] = []
    if (matchedTo > matchedFrom) {
      matchedRows =
        matchedFirst && matchedFrom === offset
          ? read.matched_rows.slice(0, matchedTo - matchedFrom)
          : matchedPrefix
            ? read.matched_rows.slice(matchedFrom, matchedTo)
            : (
                await readBankItemRows(supabase, companyId, account, currency, {
                  windowFrom: options.windowFrom ?? null,
                  windowTo: options.windowTo ?? null,
                  withRows: true,
                  withLedger: false,
                  matchedOffset: matchedFrom,
                  matchedLimit: matchedTo - matchedFrom,
                })
              ).matched_rows
    }
    const items = [
      ...head.slice(offset, end),
      ...matchedRows.map((tx) => toItem(tx, 'matched', null)),
      ...settledItems.slice(
        Math.max(offset, head.length + matchedCount) - head.length - matchedCount,
        Math.max(0, end - head.length - matchedCount),
      ),
    ]
    await attachEntries(
      supabase,
      companyId,
      items,
      items.flatMap((i) => (i.proposal && persistedProposals.has(i.proposal) ? [i.proposal] : [])),
    )
    await offerIgnoreOnStaleAnchors(supabase, companyId, items)
    const hasMore = offset + limit < total
    return {
      items,
      count: items.length,
      total_count: total,
      has_more: hasMore,
      ...(hasMore ? { next_offset: offset + limit } : {}),
      older_unmatched_count: 0,
      ...(beforeHistory ? { before_history: beforeHistory } : {}),
    }
  }

  return null
}
