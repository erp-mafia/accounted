import type { SupabaseClient } from '@supabase/supabase-js'
import {
  fetchEntryLines,
  fetchLinesByEntryIds,
  type EntryLinesQuery,
} from '@/lib/bookkeeping/entry-lines'
import { addDaysIso } from '@/lib/dates/iso'
import { SKATTEKONTO_ACCOUNT } from './manual-verifikat-prefill'

/**
 * Verifikat that are economically cancelled and must never be proposed as the
 * ledger side of a Skatteverket event (crm#128).
 *
 * Two shapes exist in the ledger:
 *
 *   1. In-app storno (lib/core/bookkeeping/storno-service.ts): the original
 *      gets status 'reversed' + reversed_by_id, the storno entry is posted
 *      with reverses_id. Both carry a 1630 line; neither is an SKV event.
 *   2. Imported storno (SIE from another system): two ordinary posted
 *      verifikat with no link between them, where the second has exactly the
 *      opposite amount on exactly the same accounts. Detected by content: the
 *      per-account nets mirror each other AND the pair is anchored by either
 *      the same entry date or the correcting voucher naming the original
 *      ("Korrigering av ver.nr. A177"). The anchor keeps a real payment and a
 *      later refund of the same amount (also a mirror) out of this set.
 *
 * Nothing here writes to the ledger; the set only filters match candidates.
 */

export interface EntryForCancellation {
  id: string
  entry_date: string
  status: 'draft' | 'posted' | 'reversed' | string
  voucher_series?: string | null
  voucher_number?: number | null
  description?: string | null
  reverses_id?: string | null
  reversed_by_id?: string | null
  lines: Array<{
    account_number: string
    debit_amount: number | string | null
    credit_amount: number | string | null
  }>
}

/** How far outside the candidate window the loader looks for the other half of a pair. */
export const CANCELLATION_LOOKAROUND_DAYS = 31

function signature(entry: EntryForCancellation, negate: boolean): string {
  const net = new Map<string, number>()
  for (const l of entry.lines) {
    const ore =
      Math.round(Number(l.debit_amount || 0) * 100) - Math.round(Number(l.credit_amount || 0) * 100)
    net.set(l.account_number, (net.get(l.account_number) ?? 0) + ore)
  }
  return Array.from(net.entries())
    .filter(([, v]) => v !== 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([acc, v]) => `${acc}:${negate ? -v : v}`)
    .join('|')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Does `text` name the voucher (series + number, e.g. "A177") as a whole token? */
function namesVoucher(text: string | null | undefined, entry: EntryForCancellation): boolean {
  if (!text || entry.voucher_number == null) return false
  const ref = `${entry.voucher_series ?? ''}${entry.voucher_number}`
  return new RegExp(`(^|[^0-9A-Za-z])${escapeRegExp(ref)}($|[^0-9A-Za-z])`, 'i').test(text)
}

function anchored(a: EntryForCancellation, b: EntryForCancellation): boolean {
  return (
    a.entry_date === b.entry_date ||
    namesVoucher(b.description, a) ||
    namesVoucher(a.description, b)
  )
}

/**
 * Ids of entries that are cancelled (see the module comment). Pure: pass
 * every entry with ALL its lines (not only 1630), both halves of a pair
 * included. Content pairs are formed one to one, in date then voucher order,
 * so two identical bookings with one storno only lose one of them.
 */
export function findCancelledEntryIds(entries: EntryForCancellation[]): Set<string> {
  const cancelled = new Set<string>()
  for (const e of entries) {
    if (e.status === 'reversed' || e.reverses_id || e.reversed_by_id) cancelled.add(e.id)
  }

  const open = entries
    .filter((e) => e.status === 'posted' && !cancelled.has(e.id))
    .sort(
      (a, b) =>
        (a.entry_date < b.entry_date ? -1 : a.entry_date > b.entry_date ? 1 : 0) ||
        (a.voucher_number ?? 0) - (b.voucher_number ?? 0) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
  const sig = new Map(open.map((e) => [e.id, signature(e, false)]))
  const neg = new Map(open.map((e) => [e.id, signature(e, true)]))
  const paired = new Set<string>()
  for (let i = 0; i < open.length; i++) {
    const a = open[i]
    if (paired.has(a.id) || !sig.get(a.id)) continue
    for (let j = i + 1; j < open.length; j++) {
      const b = open[j]
      if (paired.has(b.id)) continue
      if (sig.get(b.id) !== neg.get(a.id)) continue
      if (!anchored(a, b)) continue
      paired.add(a.id)
      paired.add(b.id)
      break
    }
  }
  for (const id of paired) cancelled.add(id)
  return cancelled
}

interface HeadRow {
  debit_amount: number | string | null
  credit_amount: number | string | null
  journal_entries: Omit<EntryForCancellation, 'lines'>
}

/**
 * Cancelled entries among those touching 1630 in [from, to], looking
 * CANCELLATION_LOOKAROUND_DAYS further on both sides for the other half of a
 * pair. Throws on a read failure: callers treat that as "no safe candidates".
 */
export async function loadCancelledEntryIds(
  supabase: SupabaseClient,
  companyId: string,
  from: string,
  to: string,
): Promise<Set<string>> {
  const heads = await fetchEntryLines<HeadRow>({
    supabase,
    entryColumns:
      'id, entry_date, status, voucher_series, voucher_number, description, reverses_id, reversed_by_id',
    lineColumns: 'debit_amount, credit_amount',
    filterEntries: (q: EntryLinesQuery) =>
      q
        .eq('company_id', companyId)
        .gte('entry_date', addDaysIso(from, -CANCELLATION_LOOKAROUND_DAYS))
        .lte('entry_date', addDaysIso(to, CANCELLATION_LOOKAROUND_DAYS)),
    filterLines: (q: EntryLinesQuery) => q.eq('account_number', SKATTEKONTO_ACCOUNT),
  })
  const byId = new Map<string, EntryForCancellation>()
  for (const h of heads) {
    const e = h.journal_entries
    if (e && !byId.has(e.id)) byId.set(e.id, { ...e, lines: [] })
  }
  if (byId.size === 0) return new Set()

  const lines = await fetchLinesByEntryIds<{
    id: string
    journal_entry_id: string
    account_number: string
    debit_amount: number | string | null
    credit_amount: number | string | null
  }>(supabase, Array.from(byId.keys()), 'account_number, debit_amount, credit_amount')
  for (const l of lines) byId.get(l.journal_entry_id)?.lines.push(l)

  return findCancelledEntryIds(Array.from(byId.values()))
}
