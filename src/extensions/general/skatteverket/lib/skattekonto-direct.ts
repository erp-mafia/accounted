import type { SupabaseClient } from '@supabase/supabase-js'
import {
  fetchEntryLines,
  fetchLinesByEntryIds,
  type EntryLinesQuery,
} from '@/lib/bookkeeping/entry-lines'
import { addDaysIso, daysBetweenIso } from '@/lib/dates/iso'
import {
  CANCELLATION_LOOKAROUND_DAYS,
  findCancelledEntryIds,
  type EntryForCancellation,
} from '@/lib/skatteverket/skattekonto-cancelled-entries'
import type { SkattekontoLedgerAccount } from '@/lib/skatteverket/skattekonto-account'
import type { SkattekontoLedgerTwin } from '@/types/skatteverket'
import { sameTaxEventAccounts } from '@/lib/transactions/skattekonto-tax-accounts'

/**
 * Is a Skatteverket event already in the ledger WITHOUT the skattekonto
 * (PH 171 follow-up)?
 *
 * The twin, cover and plan guards (skattekonto-booking.ts) all read the
 * skattekonto account, 1630 (or 2012 for an enskild firma that runs it
 * there). Some books never touch it: a previous system that paid the tax
 * straight from the bank to the tax accounts (one verifikat per month,
 * 1930 against 2650, 2710, 2731, 2510, no 1630 line), or a bank line
 * categorised here as 1930 against 2510. The skattekonto rows of those
 * months then look unbooked, and booking them records every liability and
 * the bank payment a second time.
 *
 * The booking of a row is one line on the skattekonto account and one
 * counter line: the rule's account (2650, 2710, 2731, 2510/2013, 8314,
 * 8423, 6992, 1650 for a refund that clears it) or the bank account for an
 * in- or utbetalning. The event is already in the ledger when a verifikat
 *
 *   - moves that counter account by exactly the same amount on the same side
 *     (its net on the account, to the öre),
 *   - is dated in the same calendar month as the event (the previous
 *     system's month verifikat, or the bank payment, belongs to the month
 *     Skatteverket booked it in; a fixed monthly amount, F-skatt or
 *     arbetsgivaravgifter, recurs every month and must not reach the
 *     neighbouring month's verifikat),
 *   - is a payment: it moves a bank account (BAS 19) and an account outside
 *     it, so an accrual (salary to 2710, the momsavräkning to 2650) or a
 *     transfer between bank accounts never counts,
 *   - has no line on the company's skattekonto account (with one, the
 *     twin, cover and plan guards answer, and the row can be linked there),
 *   - is live (draft or posted), no storno or reversed original, no half of
 *     an imported annulment pair, no opening balance, and no Skatteverket row
 *     is linked to it.
 *
 * The booking guard refuses such a row with LEDGER_DIRECT_EXISTS and books
 * it anyway only on an explicit reason, like the twin and cover guards.
 */

const LIVE_ENTRY_STATUSES = ['draft', 'posted']

/** Max journal_entry ids per `.in()` filter on the link read (URL length). */
const LINKED_ID_CHUNK = 100

const SEARCH_FAILED_PREFIX = 'Kunde inte kontrollera om händelsen redan finns i bokföringen'

/** The counter line of a row's booking: the line that is not on the skattekonto account. */
export interface SkattekontoCounterLine {
  account: string
  /** Ledger sign: debit positive, credit negative. */
  net: number
}

/** One row to check: its date and the counter line its verifikat would carry. */
export interface DirectHolderProbe {
  id: string
  transaktionsdatum: string
  counter: SkattekontoCounterLine
}

/** A verifikat as the check reads it: its head and every line. */
export interface DirectCandidateEntry extends EntryForCancellation {
  source_type?: string | null
}

/** BAS class 19, Kassa och bank. */
export function isCashAccount(account: string): boolean {
  return account.startsWith('19')
}

function ore(value: number | string | null | undefined): number {
  return Math.round(Number(value || 0) * 100)
}

function monthOf(date: string): string {
  return date.slice(0, 7)
}

function monthStart(month: string): string {
  return `${month}-01`
}

function monthEnd(month: string): string {
  const [year, m] = month.split('-').map(Number)
  const next = m === 12 ? `${year + 1}-01-01` : `${year}-${String(m + 1).padStart(2, '0')}-01`
  return addDaysIso(next, -1)
}

/**
 * The entry's net on `account` and every account that holds the same event
 * (2510 and 2518 for F-skatt, sameTaxEventAccounts): a bank line booked to
 * one before the seed rule moved still holds a row the rule now books to
 * the other.
 */
function netOn(entry: DirectCandidateEntry, account: string): number {
  const accounts = sameTaxEventAccounts(account)
  let sum = 0
  for (const l of entry.lines) {
    if (accounts.includes(l.account_number)) sum += ore(l.debit_amount) - ore(l.credit_amount)
  }
  return sum
}

/** Does the counter line count as the same, on the öre and the side? */
export function sameCounterLine(a: SkattekontoCounterLine, b: SkattekontoCounterLine): boolean {
  return a.account === b.account && ore(a.net) === ore(b.net)
}

/**
 * The pure check (see the module comment): for each probe, the verifikat
 * among `entries` that already hold its event without the skattekonto,
 * nearest date first. `entries` carry ALL their lines and include every
 * live verifikat that could be the other half of an imported annulment
 * pair, so a cancelled booking never counts. Every probe gets an entry,
 * empty when nothing holds it.
 */
export function selectDirectHolders(input: {
  probes: DirectHolderProbe[]
  entries: DirectCandidateEntry[]
  linkedEntryIds: ReadonlySet<string>
  account: SkattekontoLedgerAccount
}): Map<string, SkattekontoLedgerTwin[]> {
  const { probes, entries, linkedEntryIds, account } = input
  const out = new Map<string, SkattekontoLedgerTwin[]>()
  for (const p of probes) out.set(p.id, [])
  const cancelled = findCancelledEntryIds(entries)
  const eligible = entries.filter((e) => {
    if (e.status !== 'draft' && e.status !== 'posted') return false
    if (e.reverses_id || e.reversed_by_id || cancelled.has(e.id)) return false
    if (e.source_type === 'opening_balance' || linkedEntryIds.has(e.id)) return false
    if (e.lines.some((l) => l.account_number === account)) return false
    const accounts = e.lines.filter((l) => ore(l.debit_amount) !== ore(l.credit_amount)).map((l) => l.account_number)
    return accounts.some(isCashAccount) && accounts.some((a) => !isCashAccount(a))
  })
  for (const p of probes) {
    const want = ore(p.counter.net)
    if (want === 0 || p.counter.account === account) continue
    const month = monthOf(p.transaktionsdatum)
    const holders = eligible
      .filter((e) => monthOf(e.entry_date) === month && netOn(e, p.counter.account) === want)
      .sort(
        (a, b) =>
          Math.abs(daysBetweenIso(p.transaktionsdatum, a.entry_date)) -
            Math.abs(daysBetweenIso(p.transaktionsdatum, b.entry_date)) ||
          (a.voucher_number ?? 0) - (b.voucher_number ?? 0),
      )
    out.set(
      p.id,
      holders.map((e) => ({
        journal_entry_id: e.id,
        voucher_series: e.voucher_series ?? null,
        voucher_number: e.voucher_number ?? null,
        entry_date: e.entry_date,
        description: e.description ?? '',
        status: e.status as SkattekontoLedgerTwin['status'],
      })),
    )
  }
  return out
}

/** Months whose read windows (with the annulment lookaround) overlap share one read. */
function clusterByMonth(probes: DirectHolderProbe[]): DirectHolderProbe[][] {
  const sorted = [...probes].sort((a, b) =>
    a.transaktionsdatum < b.transaktionsdatum ? -1 : a.transaktionsdatum > b.transaktionsdatum ? 1 : 0,
  )
  const clusters: DirectHolderProbe[][] = []
  let current: DirectHolderProbe[] = []
  let currentTo = ''
  for (const p of sorted) {
    const month = monthOf(p.transaktionsdatum)
    const from = addDaysIso(monthStart(month), -CANCELLATION_LOOKAROUND_DAYS)
    const to = addDaysIso(monthEnd(month), CANCELLATION_LOOKAROUND_DAYS)
    if (current.length > 0 && from > currentTo) {
      clusters.push(current)
      current = []
    }
    current.push(p)
    if (to > currentTo) currentTo = to
  }
  if (current.length > 0) clusters.push(current)
  return clusters
}

interface HeadLine {
  account_number: string
  debit_amount: number | string | null
  credit_amount: number | string | null
  journal_entries: Omit<DirectCandidateEntry, 'lines'>
}

function searchFailed(err: unknown): Error {
  const detail = err instanceof Error ? err.message : typeof err === 'string' ? err : String(err)
  return new Error(`${SEARCH_FAILED_PREFIX}: ${detail}. Försök igen.`)
}

/** One read for a cluster of probes: the verifikat in their months that move a counter account by a probe amount. */
async function searchCluster(
  supabase: SupabaseClient,
  companyId: string,
  probes: DirectHolderProbe[],
  account: SkattekontoLedgerAccount,
): Promise<Map<string, SkattekontoLedgerTwin[]>> {
  const months = probes.map((p) => monthOf(p.transaktionsdatum)).sort()
  // The annulment lookaround: the other half of an imported pair may lie
  // outside the month (skattekonto-cancelled-entries.ts).
  const from = addDaysIso(monthStart(months[0]), -CANCELLATION_LOOKAROUND_DAYS)
  const to = addDaysIso(monthEnd(months[months.length - 1]), CANCELLATION_LOOKAROUND_DAYS)
  const accounts = Array.from(new Set(probes.flatMap((p) => sameTaxEventAccounts(p.counter.account))))
  const amountsByAccount = new Map<string, Set<number>>()
  for (const p of probes) {
    for (const a of sameTaxEventAccounts(p.counter.account)) {
      const set = amountsByAccount.get(a) ?? new Set<number>()
      set.add(Math.abs(ore(p.counter.net)))
      amountsByAccount.set(a, set)
    }
  }

  let lines: HeadLine[]
  try {
    lines = await fetchEntryLines<HeadLine>({
      supabase,
      entryColumns:
        'id, entry_date, status, voucher_series, voucher_number, description, source_type, reverses_id, reversed_by_id',
      lineColumns: 'account_number, debit_amount, credit_amount',
      filterEntries: (q: EntryLinesQuery) =>
        q
          .eq('company_id', companyId)
          .gte('entry_date', from)
          .lte('entry_date', to)
          .in('status', LIVE_ENTRY_STATUSES),
      filterLines: (q: EntryLinesQuery) => q.in('account_number', accounts),
    })
  } catch (err) {
    throw searchFailed(err)
  }

  // Either side: a mirror (the other half of an annulment) carries the
  // amount on the opposite side and must be read too.
  const heads = new Map<string, DirectCandidateEntry>()
  for (const l of lines) {
    const amounts = amountsByAccount.get(l.account_number)
    const head = l.journal_entries
    if (!amounts || !head) continue
    if (amounts.has(ore(l.debit_amount)) || amounts.has(ore(l.credit_amount))) {
      if (!heads.has(head.id)) heads.set(head.id, { ...head, lines: [] })
    }
  }
  if (heads.size === 0) return new Map(probes.map((p) => [p.id, []]))

  const ids = Array.from(heads.keys())
  const linkedEntryIds = new Set<string>()
  try {
    const all = await fetchLinesByEntryIds<{
      id: string
      journal_entry_id: string
      account_number: string
      debit_amount: number | string | null
      credit_amount: number | string | null
    }>(supabase, ids, 'account_number, debit_amount, credit_amount')
    for (const l of all) heads.get(l.journal_entry_id)?.lines.push(l)
    for (let i = 0; i < ids.length; i += LINKED_ID_CHUNK) {
      const { data, error } = await supabase
        .from('skattekonto_transactions')
        .select('journal_entry_id')
        .eq('company_id', companyId)
        .in('journal_entry_id', ids.slice(i, i + LINKED_ID_CHUNK))
      if (error) throw new Error(error.message)
      for (const r of (data ?? []) as Array<{ journal_entry_id: string | null }>) {
        if (r.journal_entry_id) linkedEntryIds.add(r.journal_entry_id)
      }
    }
  } catch (err) {
    throw searchFailed(err)
  }

  return selectDirectHolders({ probes, entries: Array.from(heads.values()), linkedEntryIds, account })
}

/**
 * The verifikat that already hold each probe's event without the
 * skattekonto (see the module comment), nearest date first. Every probe
 * gets an entry, empty when nothing holds it. One read per run of
 * neighbouring months, so a batch costs a handful of queries. Throws when a
 * read fails: without the lines and the links no answer is safe, the same
 * posture as the twin search.
 */
export async function findDirectLedgerHolders(
  supabase: SupabaseClient,
  companyId: string,
  probes: DirectHolderProbe[],
  account: SkattekontoLedgerAccount,
): Promise<Map<string, SkattekontoLedgerTwin[]>> {
  const out = new Map<string, SkattekontoLedgerTwin[]>()
  for (const p of probes) out.set(p.id, [])
  const usable = probes.filter((p) => ore(p.counter.net) !== 0 && p.counter.account !== account)
  for (const cluster of clusterByMonth(usable)) {
    for (const [id, holders] of await searchCluster(supabase, companyId, cluster, account)) out.set(id, holders)
  }
  return out
}

/** The fields of a Skatteverket row the batch reads to build its probes. */
export interface DirectProbeRow {
  id: string
  transaktionsdatum: string
  transaktionstext: string
  belopp_skatteverket: number | string
  transaktionsidentitet?: string | null
  status: string
}

/**
 * findDirectLedgerHolders for rows given by id, for the batch: reads the
 * open rows (not linked, not ignored) and asks `counterOf` for each row's
 * counter line (the booking's own rule resolution, so the check reads the
 * line the verifikat would carry). A row without a counter line (no rule)
 * is left out; the booking gates answer for it. Throws when a read fails.
 */
export async function findDirectLedgerHoldersForIds(
  supabase: SupabaseClient,
  companyId: string,
  ids: string[],
  account: SkattekontoLedgerAccount,
  counterOf: (row: DirectProbeRow) => Promise<SkattekontoCounterLine | null>,
): Promise<Map<string, { counter: SkattekontoCounterLine; holders: SkattekontoLedgerTwin[] }>> {
  const out = new Map<string, { counter: SkattekontoCounterLine; holders: SkattekontoLedgerTwin[] }>()
  if (ids.length === 0) return out
  const { data, error } = await supabase
    .from('skattekonto_transactions')
    .select('id, transaktionsdatum, transaktionstext, belopp_skatteverket, transaktionsidentitet, status')
    .eq('company_id', companyId)
    .in('id', ids)
    .eq('is_ignored', false)
    .is('journal_entry_id', null)
  if (error) throw searchFailed(error.message)
  const probes: DirectHolderProbe[] = []
  for (const row of (data ?? []) as DirectProbeRow[]) {
    const counter = await counterOf(row)
    if (counter) probes.push({ id: row.id, transaktionsdatum: row.transaktionsdatum, counter })
  }
  const found = await findDirectLedgerHolders(supabase, companyId, probes, account)
  for (const p of probes) out.set(p.id, { counter: p.counter, holders: found.get(p.id) ?? [] })
  return out
}
