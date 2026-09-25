import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre } from '@/lib/money'
import { SKATTEKONTO_ACCOUNT } from './manual-verifikat-prefill'

/**
 * Link semantics for a skattekonto row (core).
 *
 * A link pairs SKV-posted rows with ONE verifikat whose 1630 movement the
 * rows settle on the expected side (positive belopp = money into the
 * skattekonto = debit 1630). Several rows may share one verifikat (one
 * combined AGI line for avdragen skatt + arbetsgivaravgift, or a payment and
 * a debit booked in the same voucher); see groupSettlesEntry for the rule.
 * It writes nothing to the verifikat:
 * `skattekonto_transactions.journal_entry_id` is the only thing that changes,
 * so linking and unlinking are allowed in locked periods and need no storno.
 *
 * Lives in core so the reconciliation engine (lib/reconciliation), the
 * dashboard routes, the v1 API and the MCP executors share one implementation;
 * the skatteverket extension's matchSkattekontoToEntry delegates here.
 */

export type SkattekontoLinkErrorCode =
  | 'TRANSACTION_NOT_FOUND'
  | 'ALREADY_BOOKED'
  | 'ROW_IGNORED'
  | 'ENTRY_NOT_FOUND'
  | 'ENTRY_ALREADY_LINKED'
  | 'INVALID_CANDIDATE'
  | 'NOT_LINKED'
  | 'LINK_RACE'

export class SkattekontoLinkError extends Error {
  constructor(
    message: string,
    public readonly code: SkattekontoLinkErrorCode,
  ) {
    super(message)
    this.name = 'SkattekontoLinkError'
  }
}

interface RowForLink {
  id: string
  belopp_skatteverket: number | string
  journal_entry_id: string | null
  is_ignored: boolean | null
  status: 'booked' | 'upcoming'
}

interface EntryForLink {
  id: string
  status: 'draft' | 'posted' | 'reversed'
  lines: Array<{ account_number: string; debit_amount: number | string; credit_amount: number | string }> | null
}

function expectedSide(belopp: number): 'debit' | 'credit' {
  return belopp > 0 ? 'debit' : 'credit'
}

/**
 * Does this entry settle the row? True when a single 1630 line equals the
 * amount on the expected side, or when the entry's 1630 lines net to it (a
 * manual voucher that split the movement over two lines). Exported for the
 * engine's pair validation.
 */
export function entrySettlesAmount(
  lines: EntryForLink['lines'],
  belopp: number,
): { ok: boolean; via: 'line' | 'entry_total' | null } {
  const amount = roundOre(Math.abs(belopp))
  const side = expectedSide(belopp)
  const onAccount = (lines ?? []).filter((l) => l.account_number === SKATTEKONTO_ACCOUNT)
  if (onAccount.length === 0) return { ok: false, via: null }
  const single = onAccount.some((l) => {
    const debit = roundOre(Number(l.debit_amount))
    const credit = roundOre(Number(l.credit_amount))
    return side === 'debit' ? debit === amount && credit === 0 : credit === amount && debit === 0
  })
  if (single) return { ok: true, via: 'line' }
  const net = roundOre(
    onAccount.reduce((s, l) => s + Number(l.debit_amount || 0) - Number(l.credit_amount || 0), 0),
  )
  const signed = side === 'debit' ? amount : -amount
  if (onAccount.length > 1 && net === signed) return { ok: true, via: 'entry_total' }
  return { ok: false, via: null }
}

export type SkattekontoSettleVia = 'line' | 'entry_total' | 'lines'

/** Upper bounds for the exact line assignment; beyond them it is not attempted. */
const MAX_ASSIGN_EVENTS = 12
const MAX_ASSIGN_LINES = 20

function toOre(value: number | string | null | undefined): number {
  return Math.round(Number(value || 0) * 100)
}

/**
 * Can the events be split into groups so that every group sums EXACTLY to a
 * distinct 1630 line of the entry, every event is used, every 1630 line is
 * used, and each event sits on its line's side? Full coverage keeps the
 * reconciliation identity intact: the linked rows then sum to the entry's
 * 1630 net, which is what a live link removes from the bridge.
 */
function assignsToLines(
  lines: EntryForLink['lines'],
  belopps: number[],
): boolean {
  const lineOre = (lines ?? [])
    .filter((l) => l.account_number === SKATTEKONTO_ACCOUNT)
    .map((l) => toOre(l.debit_amount) - toOre(l.credit_amount))
    .filter((v) => v !== 0)
  const events = belopps.map((b) => toOre(b))
  if (lineOre.length === 0 || events.length === 0) return false
  if (events.length > MAX_ASSIGN_EVENTS || lineOre.length > MAX_ASSIGN_LINES) return false
  if (events.some((e) => e === 0)) return false
  if (events.length < lineOre.length) return false
  const total = events.reduce((s, e) => s + e, 0)
  if (total !== lineOre.reduce((s, v) => s + v, 0)) return false

  // Largest first prunes fastest; remaining capacity shrinks toward 0.
  const sorted = [...events].sort((a, b) => Math.abs(b) - Math.abs(a))
  const remaining = [...lineOre]
  const place = (i: number): boolean => {
    if (i === sorted.length) return remaining.every((r) => r === 0)
    const e = sorted[i]
    const tried = new Set<number>()
    for (let j = 0; j < remaining.length; j++) {
      const r = remaining[j]
      if (r === 0 || Math.sign(r) !== Math.sign(e) || Math.abs(e) > Math.abs(r)) continue
      if (tried.has(r)) continue // identical capacity: same subtree
      tried.add(r)
      remaining[j] = r - e
      if (place(i + 1)) return true
      remaining[j] = r
    }
    return false
  }
  return place(0)
}

/**
 * Do these SKV rows, together, settle this entry's 1630 movement?
 *
 *   * one row: entrySettlesAmount (a single line, or the entry's net).
 *   * several rows, non-zero sum: the SUM settles the entry the same way (one
 *     combined 1630 line for avdragen skatt + arbetsgivaravgift, crm#128).
 *   * otherwise (for example a net-zero pair, crm#104: a payment into the
 *     skattekonto and the debit it paid, booked in one voucher): every row
 *     maps onto its own 1630 line(s) exactly, covering all of them.
 *
 * Exact öre only; there is no tolerance. `via` says which rule held.
 */
export function groupSettlesEntry(
  lines: EntryForLink['lines'],
  belopps: number[],
): { ok: boolean; via: SkattekontoSettleVia | null } {
  if (belopps.length === 0) return { ok: false, via: null }
  if (belopps.length === 1) return entrySettlesAmount(lines, belopps[0])
  const sum = roundOre(belopps.reduce((s, b) => s + Number(b), 0))
  if (sum !== 0) {
    const bySum = entrySettlesAmount(lines, sum)
    if (bySum.ok) return bySum
  }
  if (assignsToLines(lines, belopps)) return { ok: true, via: 'lines' }
  return { ok: false, via: null }
}

/** Rows already linked to an entry, with the amounts the group check needs. */
async function fetchLinkedRows(
  supabase: SupabaseClient,
  companyId: string,
  journalEntryId: string,
): Promise<Array<{ id: string; belopp_skatteverket: number | string }>> {
  const { data } = await supabase
    .from('skattekonto_transactions')
    .select('id, belopp_skatteverket')
    .eq('company_id', companyId)
    .eq('journal_entry_id', journalEntryId)
  if (Array.isArray(data)) return data as Array<{ id: string; belopp_skatteverket: number | string }>
  return data ? [data as { id: string; belopp_skatteverket: number | string }] : []
}

export interface LinkSkattekontoRowResult {
  skattekonto_transaction_id: string
  journal_entry_id: string
  via: SkattekontoSettleVia
}

/**
 * Link one open SKV row to one verifikat. Throws SkattekontoLinkError with a
 * stable code on every refusal; the write is guarded on journal_entry_id IS
 * NULL so a concurrent link loses cleanly (LINK_RACE).
 */
export async function linkSkattekontoRow(
  supabase: SupabaseClient,
  companyId: string,
  transactionId: string,
  journalEntryId: string,
): Promise<LinkSkattekontoRowResult> {
  const { data: row, error: rowError } = await supabase
    .from('skattekonto_transactions')
    .select('id, belopp_skatteverket, journal_entry_id, is_ignored, status')
    .eq('id', transactionId)
    .eq('company_id', companyId)
    .maybeSingle<RowForLink>()
  if (rowError || !row) {
    throw new SkattekontoLinkError('Skattekonto-transaktionen hittades inte.', 'TRANSACTION_NOT_FOUND')
  }
  if (row.journal_entry_id) {
    throw new SkattekontoLinkError('Transaktionen är redan kopplad till ett verifikat.', 'ALREADY_BOOKED')
  }
  if (row.is_ignored) {
    throw new SkattekontoLinkError('Transaktionen är ignorerad. Återställ den innan du kopplar.', 'ROW_IGNORED')
  }
  if (row.status !== 'booked') {
    throw new SkattekontoLinkError('En kommande händelse kan inte kopplas ännu.', 'INVALID_CANDIDATE')
  }

  const { data: entry, error: entryError } = await supabase
    .from('journal_entries')
    .select('id, status, lines:journal_entry_lines ( account_number, debit_amount, credit_amount )')
    .eq('id', journalEntryId)
    .eq('company_id', companyId)
    .maybeSingle<EntryForLink>()
  if (entryError || !entry) {
    throw new SkattekontoLinkError('Verifikatet hittades inte.', 'ENTRY_NOT_FOUND')
  }
  if (entry.status === 'reversed') {
    throw new SkattekontoLinkError('Verifikatet är makulerat och kan inte kopplas.', 'INVALID_CANDIDATE')
  }
  // Rows already on this verifikat join the check: a second event may share
  // it when the whole group still settles the 1630 movement (crm#104,
  // crm#128). Otherwise the verifikat is taken.
  const linkedRows = await fetchLinkedRows(supabase, companyId, journalEntryId)
  const settles = groupSettlesEntry(entry.lines, [
    ...linkedRows.map((r) => Number(r.belopp_skatteverket)),
    Number(row.belopp_skatteverket),
  ])
  if (!settles.ok || !settles.via) {
    if (linkedRows.length > 0) {
      throw new SkattekontoLinkError(
        'Verifikatet är redan kopplat till en annan skattekonto-transaktion.',
        'ENTRY_ALREADY_LINKED',
      )
    }
    throw new SkattekontoLinkError('Verifikatet saknar en matchande rad på 1630.', 'INVALID_CANDIDATE')
  }

  const { data: updated, error: updateError } = await supabase
    .from('skattekonto_transactions')
    .update({ journal_entry_id: journalEntryId, suggested_journal_entry_id: null, suggested_at: null })
    .eq('id', transactionId)
    .eq('company_id', companyId)
    .is('journal_entry_id', null)
    .select('id')
  if (updateError) {
    throw new SkattekontoLinkError(`Kunde inte koppla: ${updateError.message}`, 'LINK_RACE')
  }
  if (!updated || (Array.isArray(updated) && updated.length === 0)) {
    throw new SkattekontoLinkError('Transaktionen kopplades av någon annan samtidigt.', 'LINK_RACE')
  }

  return { skattekonto_transaction_id: transactionId, journal_entry_id: journalEntryId, via: settles.via }
}

/**
 * Remove the link. The verifikat is untouched (BFL: nothing is deleted or
 * edited in the ledger); only the row's pointer is cleared. Proposals are
 * recomputed on the next sync.
 */
export async function unlinkSkattekontoRow(
  supabase: SupabaseClient,
  companyId: string,
  transactionId: string,
): Promise<{ skattekonto_transaction_id: string; previous_journal_entry_id: string }> {
  const { data: row, error } = await supabase
    .from('skattekonto_transactions')
    .select('id, journal_entry_id')
    .eq('id', transactionId)
    .eq('company_id', companyId)
    .maybeSingle<{ id: string; journal_entry_id: string | null }>()
  if (error || !row) {
    throw new SkattekontoLinkError('Skattekonto-transaktionen hittades inte.', 'TRANSACTION_NOT_FOUND')
  }
  if (!row.journal_entry_id) {
    throw new SkattekontoLinkError('Transaktionen är inte kopplad till något verifikat.', 'NOT_LINKED')
  }
  const { error: updateError } = await supabase
    .from('skattekonto_transactions')
    .update({ journal_entry_id: null })
    .eq('id', transactionId)
    .eq('company_id', companyId)
    .eq('journal_entry_id', row.journal_entry_id)
  if (updateError) {
    throw new SkattekontoLinkError(`Kunde inte koppla bort: ${updateError.message}`, 'LINK_RACE')
  }
  return { skattekonto_transaction_id: transactionId, previous_journal_entry_id: row.journal_entry_id }
}

/**
 * Ignore / restore a row. An ignored row never carries a link (DB CHECK,
 * migration 20260819200000), so ignoring a linked row is refused here with a
 * clean code instead of a constraint error.
 */
export async function setSkattekontoRowIgnored(
  supabase: SupabaseClient,
  companyId: string,
  transactionId: string,
  ignored: boolean,
): Promise<{ skattekonto_transaction_id: string; is_ignored: boolean }> {
  const { data: row, error } = await supabase
    .from('skattekonto_transactions')
    .select('id, journal_entry_id, is_ignored')
    .eq('id', transactionId)
    .eq('company_id', companyId)
    .maybeSingle<{ id: string; journal_entry_id: string | null; is_ignored: boolean | null }>()
  if (error || !row) {
    throw new SkattekontoLinkError('Skattekonto-transaktionen hittades inte.', 'TRANSACTION_NOT_FOUND')
  }
  if (ignored && row.journal_entry_id) {
    throw new SkattekontoLinkError('En kopplad händelse kan inte ignoreras. Koppla bort den först.', 'ALREADY_BOOKED')
  }
  if (Boolean(row.is_ignored) === ignored) {
    return { skattekonto_transaction_id: transactionId, is_ignored: ignored }
  }
  // Two literal payloads (not one conditional expression) so the phantom-column
  // guard can read the column set; ignoring also drops a standing proposal.
  const update = ignored
    ? supabase
        .from('skattekonto_transactions')
        .update({ is_ignored: true, suggested_journal_entry_id: null, suggested_at: null })
    : supabase.from('skattekonto_transactions').update({ is_ignored: false })
  const { error: updateError } = await update.eq('id', transactionId).eq('company_id', companyId)
  if (updateError) {
    throw new SkattekontoLinkError(`Kunde inte uppdatera: ${updateError.message}`, 'LINK_RACE')
  }
  return { skattekonto_transaction_id: transactionId, is_ignored: ignored }
}

export interface LinkSkattekontoRowsResult {
  journal_entry_id: string
  via: SkattekontoSettleVia
  skattekonto_transaction_ids: string[]
}

/**
 * Link SEVERAL open SKV rows to ONE verifikat: the N:1 worksheet selection
 * (one AGI verifikat settling the avdragen skatt + arbetsgivaravgift rows,
 * one payment verifikat covering a row pair, a payment and a debit booked in
 * one voucher). The rows, together with any rows already on the verifikat,
 * must settle its 1630 side (groupSettlesEntry); each row then gets the same guarded pointer as
 * the single link. The write is ONE guarded UPDATE over the whole group: a
 * concurrent link shrinks the hit set, and a partial hit is rolled back and
 * reported as LINK_RACE, so a group is never left half-linked.
 */
export async function linkSkattekontoRows(
  supabase: SupabaseClient,
  companyId: string,
  transactionIds: string[],
  journalEntryId: string,
): Promise<LinkSkattekontoRowsResult> {
  const ids = [...new Set(transactionIds)]
  if (ids.length === 0 || ids.length > 50) {
    throw new SkattekontoLinkError('Välj mellan 1 och 50 händelser.', 'INVALID_CANDIDATE')
  }

  const { data: rows, error: rowsError } = await supabase
    .from('skattekonto_transactions')
    .select('id, belopp_skatteverket, journal_entry_id, is_ignored, status')
    .eq('company_id', companyId)
    .in('id', ids)
  if (rowsError || !rows || rows.length !== ids.length) {
    throw new SkattekontoLinkError('Någon av skattekonto-transaktionerna hittades inte.', 'TRANSACTION_NOT_FOUND')
  }
  const typed = rows as RowForLink[]
  if (typed.some((r) => r.journal_entry_id)) {
    throw new SkattekontoLinkError('En av transaktionerna är redan kopplad till ett verifikat.', 'ALREADY_BOOKED')
  }
  if (typed.some((r) => r.is_ignored)) {
    throw new SkattekontoLinkError('En av transaktionerna är ignorerad. Återställ den innan du kopplar.', 'ROW_IGNORED')
  }
  if (typed.some((r) => r.status !== 'booked')) {
    throw new SkattekontoLinkError('En kommande händelse kan inte kopplas ännu.', 'INVALID_CANDIDATE')
  }

  const { data: entry, error: entryError } = await supabase
    .from('journal_entries')
    .select('id, status, lines:journal_entry_lines ( account_number, debit_amount, credit_amount )')
    .eq('id', journalEntryId)
    .eq('company_id', companyId)
    .maybeSingle<EntryForLink>()
  if (entryError || !entry) {
    throw new SkattekontoLinkError('Verifikatet hittades inte.', 'ENTRY_NOT_FOUND')
  }
  if (entry.status === 'reversed') {
    throw new SkattekontoLinkError('Verifikatet är makulerat och kan inte kopplas.', 'INVALID_CANDIDATE')
  }

  const groupSet = new Set(ids)
  const outside = (await fetchLinkedRows(supabase, companyId, journalEntryId)).filter(
    (r) => !groupSet.has(r.id),
  )
  const settles = groupSettlesEntry(entry.lines, [
    ...outside.map((r) => Number(r.belopp_skatteverket)),
    ...typed.map((r) => Number(r.belopp_skatteverket)),
  ])
  if (!settles.ok || !settles.via) {
    if (outside.length > 0) {
      throw new SkattekontoLinkError(
        'Verifikatet är redan kopplat till en annan skattekonto-transaktion.',
        'ENTRY_ALREADY_LINKED',
      )
    }
    throw new SkattekontoLinkError(
      'Verifikatets rader på 1630 motsvarar inte summan av de valda händelserna.',
      'INVALID_CANDIDATE',
    )
  }

  const { data: updated, error: updateError } = await supabase
    .from('skattekonto_transactions')
    .update({ journal_entry_id: journalEntryId, suggested_journal_entry_id: null, suggested_at: null })
    .eq('company_id', companyId)
    .in('id', ids)
    .is('journal_entry_id', null)
    .eq('is_ignored', false)
    .select('id')
  if (updateError) {
    throw new SkattekontoLinkError(`Kunde inte koppla: ${updateError.message}`, 'LINK_RACE')
  }
  const updatedIds = ((updated ?? []) as Array<{ id: string }>).map((r) => r.id)
  if (updatedIds.length !== ids.length) {
    // Roll the partial hit back: the group's sum no longer settles the entry.
    if (updatedIds.length > 0) {
      await supabase
        .from('skattekonto_transactions')
        .update({ journal_entry_id: null })
        .eq('company_id', companyId)
        .in('id', updatedIds)
        .eq('journal_entry_id', journalEntryId)
    }
    throw new SkattekontoLinkError('En av transaktionerna kopplades av någon annan samtidigt.', 'LINK_RACE')
  }

  return { journal_entry_id: journalEntryId, via: settles.via, skattekonto_transaction_ids: ids }
}
