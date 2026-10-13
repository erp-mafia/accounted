import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre } from '@/lib/money'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import {
  alignLinkedTransactionsToWindow,
  fetchJunctionLinkMap,
  fetchUnlinkedGLLines,
  openAmountByEntry,
  scopeTransactionsToAccount,
} from './bank-reconciliation'
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
   * Skattekonto only, when any: open rows dated before history_start, which
   * no default listing shows (bucket before_history lists them), crm#1153.
   */
  before_history?: { count: number; total: number; history_start: string | null }
}

interface CashAccountRow {
  id: string
  ledger_account: string
  currency: string | null
  is_primary: boolean | null
}

interface BankTxRow {
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
 * The first day of every fiscal year of the company: the only date an opening
 * balance can carry. A failed read offers no "Märk som IB" at all rather than
 * offering it on a mid-year verifikat.
 */
async function fetchFiscalYearStarts(supabase: SupabaseClient, companyId: string): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('fiscal_periods')
    .select('period_start')
    .eq('company_id', companyId)
  if (error) return new Set()
  return new Set(((data ?? []) as Array<{ period_start: string }>).map((p) => p.period_start))
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
    try {
      live = await fetchLiveLedgerSettlements(supabase, companyId, ledgerAccount)
    } catch {
      return
    }
    if (live.length === 0) return
    const { lines, open } = await fetchOpen(window.from ?? undefined, window.to ?? undefined)
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
    const persistedProposals: ReconciliationProposal[] = []

    const wantsExternal = buckets.some((b) =>
      ['proposed', 'unmatched_external', 'matched', 'ignored'].includes(b),
    )
    if (wantsExternal) {
      // Paged: an account with more than 1,000 rows lost the rest, so its
      // buckets and total_count stopped at the first page.
      const ownDateRows = await fetchAllRows<BankTxRow>(({ from, to }) => {
        let query = supabase
          .from('transactions')
          .select(
            'id, date, description, merchant_name, amount, currency, journal_entry_id, potential_journal_entry_id, potential_match_method, potential_match_confidence, is_ignored, reconciliation_method',
          )
          .eq('company_id', companyId)
        query = scopeTransactionsToAccount(query, account.id, currency, Boolean(account.is_primary))
        if (options.windowFrom) query = query.gte('date', options.windowFrom)
        if (options.windowTo) query = query.lte('date', options.windowTo)
        return query.order('date', { ascending: false }).order('id', { ascending: true }).range(from, to)
      }).catch((txError: Error) => {
        throw new Error(`Kunde inte hämta transaktioner: ${txError.message}`)
      })
      // Rows anchored only through transaction_voucher_links (bulk-book,
      // residual bookings) are matched too; their pointer column is NULL.
      // The map (not just the id set) so a junction-anchored row can report
      // WHICH verifikat it is matched to: with only the pointer column read,
      // linked_journal_entry_id came back null on a split row (crm#48).
      const ownDateJunctionLinks = await fetchJunctionLinkMap(
        supabase,
        companyId,
        ownDateRows.filter((tx) => !tx.journal_entry_id && !tx.is_ignored).map((tx) => tx.id),
      )
      // A linked row belongs to the window of its verifikat, not its own date,
      // the same rule getReconciliationStatus counts matched_count and the
      // difference by; without it the matched list and the headline disagree
      // on a link that straddles the window edge.
      const aligned = await alignLinkedTransactionsToWindow<BankTxRow>({
        supabase,
        companyId,
        bankAccount: account.ledger_account,
        rows: ownDateRows,
        junctionLinks: ownDateJunctionLinks,
        from: options.windowFrom ?? null,
        to: options.windowTo ?? null,
        readFrom: options.windowFrom ?? null,
        readTo: options.windowTo ?? null,
        columns: 'items',
        cashAccountId: account.id,
        currency,
        includeUnassigned: Boolean(account.is_primary),
      })
      // Same order as the read: newest first, id as tiebreaker.
      const rows = [...aligned.rows].sort((a, b) =>
        a.date === b.date ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.date < b.date ? 1 : -1,
      )
      const junctionLinks = aligned.junctionLinks
      const junctionLinked = new Set(junctionLinks.keys())
      // Rows nothing explains 1:1 are searched for a set of unlinked verifikat
      // summing exactly to them (#2293) before they are offered as unmatched:
      // "Bokför" is the door only when the ledger has nothing for the row.
      const coveringSets = buckets.some((b) => b === 'proposed' || b === 'unmatched_external')
        ? await proposeCoveringSets(
            supabase,
            companyId,
            account,
            rows
              .filter(
                (tx) =>
                  !tx.is_ignored && !tx.journal_entry_id && !junctionLinked.has(tx.id) && !tx.potential_journal_entry_id,
              )
              .map((tx) => ({ id: tx.id, date: tx.date, amount: Number(tx.amount), currency: tx.currency })),
          )
        : new Map<string, ReconciliationProposal>()
      {
        for (const tx of rows) {
          const coveringSet = coveringSets.get(tx.id) ?? null
          const bucket: ReconciliationItemBucket = tx.is_ignored
            ? 'ignored'
            : tx.journal_entry_id || junctionLinked.has(tx.id)
              ? 'matched'
              : tx.potential_journal_entry_id || coveringSet
                ? 'proposed'
                : 'unmatched_external'
          if (!buckets.includes(bucket)) continue
          // The matcher persists only the verifikat id; attachEntries fills in
          // its label, date and text once every item is built. Live proposals
          // only: a matched row can keep a stale pointer (a multi-row
          // bulk_book links through the junction and never clears it), and a
          // real voucher label there would read as the row's link.
          const persisted: ReconciliationProposal | null = tx.potential_journal_entry_id
            ? {
                journal_entry_id: tx.potential_journal_entry_id,
                voucher_number: null,
                voucher_series: null,
                entry_date: tx.date,
                description: '',
                entry_status: 'posted',
                confidence: Number(tx.potential_match_confidence ?? 0.75),
                reasons: [tx.potential_match_method ?? 'föreslagen av matcharen'],
              }
            : null
          if (persisted && bucket === 'proposed') persistedProposals.push(persisted)
          push({
            item_id: tx.id,
            item_type: 'transaction',
            side: 'external',
            bucket,
            date: tx.date,
            description: tx.merchant_name || tx.description || '',
            amount: roundOre(Number(tx.amount)),
            currency: tx.currency,
            linked_journal_entry_id: tx.journal_entry_id ?? junctionLinks.get(tx.id)?.[0] ?? null,
            proposal: persisted ?? coveringSet,
            actions:
              bucket === 'matched'
                ? ['unmatch']
                : bucket === 'ignored'
                  ? ['unignore']
                  : bucket === 'proposed'
                    ? ['match', 'book', 'ignore']
                    : ['book', 'match', 'ignore'],
          })
        }
      }
    }

    let ledgerItems: Map<string, ReconciliationItem> | null = null
    if (buckets.includes('unmatched_ledger')) {
      const lines = await fetchUnlinkedGLLines(
        supabase,
        companyId,
        account.ledger_account,
        options.windowFrom ?? undefined,
        options.windowTo ?? undefined,
      )
      // One item per entry: several 1930 lines of one voucher net, as a link
      // settles the voucher. A voucher 1:N slices settle in part shows only
      // what they leave open (agent feedback seq 854089). Amounts in SEK, as
      // the ledger side has always been listed here.
      const openByEntry = openAmountByEntry(lines, 'SEK')
      const periodStarts = lines.length > 0 ? await fetchFiscalYearStarts(supabase, companyId) : new Set<string>()
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

    await attachEntries(supabase, companyId, buckets.flatMap((b) => byBucket.get(b) ?? []), persistedProposals)
    if (buckets.includes('unmatched_ledger') || buckets.includes('matched')) {
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
    const all = buckets.flatMap((b) => byBucket.get(b) ?? [])
    return page(all, limit, offset)
  }

  return null
}
