/**
 * "Rättelse, inte momsredovisning" (crm#1849): a person tells the
 * momsdeklaration that a posted verifikat the momsredovisning shapes catch is
 * not a momsredovisning.
 *
 * The shapes (vat_declaration_special_entries) recognise a manual
 * momsredovisning by its lines, because intent is not recorded on manual and
 * imported verifikat. A correction that moves output VAT to 1650 next to a
 * sales correction has the same lines as a partial omföring, and every
 * arithmetic narrowing of the shapes broke real momsredovisningar (decision
 * 2026-09-20, #2805). So the tail gets an explicit answer per verifikat:
 * vat_momsredovisning_marks, append-only, the latest row per verifikat wins.
 * A live mark makes the shapes skip the verifikat (and its storno): the rutor
 * read it and it no longer counts as the period's momsredovisning.
 *
 * Only a verifikat the shapes catch can be marked: on any other the mark
 * would change nothing while the person approving it read that it does.
 *
 * A mark changes what a declaration reads, so it follows the rules a booking
 * follows: a posted verifikat, never the app's own momsredovisning
 * (source_type vat_settlement) and never a storno (it follows its original's
 * mark), never in a closed or locked period and never in a VAT period already
 * filed (a filed period's changes must show on the Moms page, and a mark is no
 * verifikat the filed-period changes can name). Those checks live here, so
 * only the server writes a mark: the session client reads and checks, the
 * service-role `writer` inserts. A browser session has no INSERT on the table.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolvePeriodStatusForDate } from '@/lib/core/bookkeeping/period-status'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { fetchVatAccountTotals } from '@/lib/reports/vat-declaration'
import { filedVatPeriodsOfDates } from './filed-period-for-date'

export type MomsredovisningMarkErrorCode =
  | 'JOURNAL_ENTRY_NOT_FOUND'
  | 'VAT_MARK_NOT_POSTED'
  | 'VAT_MARK_TAGGED_SETTLEMENT'
  | 'VAT_MARK_STORNO'
  | 'VAT_MARK_NOT_SHAPE'
  | 'VAT_MARK_PERIOD_LOCKED'
  | 'VAT_MARK_PERIOD_FILED'
  | 'VAT_MARK_NOT_FOUND'
  | 'VAT_MARK_NOT_READY'

type Failure = { ok: false; code: MomsredovisningMarkErrorCode }

/**
 * The table is missing (42P01) or not in PostgREST's schema cache yet
 * (PGRST205): Vercel ships the code minutes before migrations-production
 * applies the migration. Reads then answer "no marks" and a write answers
 * VAT_MARK_NOT_READY instead of a 500.
 */
const MISSING_TABLE_CODES = new Set(['42P01', 'PGRST205'])

function isMissingTable(error: unknown): boolean {
  return MISSING_TABLE_CODES.has(String((error as { code?: unknown } | null)?.code ?? ''))
}

export interface MomsredovisningMarkResult {
  journal_entry_id: string
  /** True while the verifikat carries a live "not a momsredovisning" mark. */
  marked: boolean
  /** False when the verifikat was already in the asked state. */
  changed: boolean
}

type MarkAction = 'not_momsredovisning' | 'withdrawn'

/** True when the latest mark on the verifikat says it is no momsredovisning. */
export async function isMarkedNotMomsredovisning(
  supabase: SupabaseClient,
  companyId: string,
  journalEntryId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('vat_momsredovisning_marks')
    .select('action')
    .eq('company_id', companyId)
    .eq('journal_entry_id', journalEntryId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(1)
  if (error) {
    if (isMissingTable(error)) return false
    throw error
  }
  return ((data ?? []) as Array<{ action: MarkAction }>)[0]?.action === 'not_momsredovisning'
}

export interface MarkedMomsredovisningEntry {
  journal_entry_id: string
  voucher_series: string | null
  voucher_number: number | null
  entry_date: string
}

/**
 * The period's verifikat whose latest mark says they are no momsredovisning,
 * oldest first, so the Moms page can name them and offer Ångra after the
 * toast has gone.
 */
export async function listMarkedInPeriod(
  supabase: SupabaseClient,
  companyId: string,
  period: { start: string; end: string },
): Promise<MarkedMomsredovisningEntry[]> {
  let marks: Array<{ journal_entry_id: string; action: MarkAction }>
  try {
    marks = await fetchAllRows<{ journal_entry_id: string; action: MarkAction }>(({ from, to }) =>
      supabase
        .from('vat_momsredovisning_marks')
        .select('journal_entry_id, action, created_at, id')
        .eq('company_id', companyId)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .range(from, to),
    )
  } catch (error) {
    if (isMissingTable(error)) return []
    throw error
  }
  const latest = new Map<string, MarkAction>()
  for (const mark of marks) {
    if (!latest.has(mark.journal_entry_id)) latest.set(mark.journal_entry_id, mark.action)
  }
  const ids = [...latest].filter(([, action]) => action === 'not_momsredovisning').map(([id]) => id)
  if (ids.length === 0) return []
  const { data: entries, error: entriesError } = await supabase
    .from('journal_entries')
    .select('id, voucher_series, voucher_number, entry_date')
    .eq('company_id', companyId)
    .in('id', ids)
    // A marked verifikat annulled since nets out with its storno and can no
    // longer be withdrawn (only a posted one can), so it is not offered.
    .eq('status', 'posted')
    .gte('entry_date', period.start)
    .lte('entry_date', period.end)
    .order('entry_date', { ascending: true })
  if (entriesError) throw entriesError
  return ((entries ?? []) as Array<{ id: string; voucher_series: string | null; voucher_number: number | null; entry_date: string }>)
    .map((e) => ({
      journal_entry_id: e.id,
      voucher_series: e.voucher_series,
      voucher_number: e.voucher_number,
      entry_date: e.entry_date,
    }))
}

export interface MomsredovisningMarkPreview {
  journal_entry_id: string
  /** The verifikat as the books name it, e.g. "A158". */
  verifikat: string
  entry_date: string
  description: string
  /** Whether the verifikat carries a live mark now. */
  marked_now: boolean
}

/**
 * What a mark or its withdrawal would do, with the same refusals, writing
 * nothing: the staged MCP tools show it to the person who approves. A
 * withdrawal of a verifikat that carries no mark is refused here too.
 */
export async function previewMomsredovisningMark(
  supabase: SupabaseClient,
  companyId: string,
  journalEntryId: string,
  action: 'mark' | 'withdraw',
): Promise<{ ok: true; preview: MomsredovisningMarkPreview } | Failure> {
  const checked = await checkMarkAction(supabase, companyId, journalEntryId, action)
  if (!checked.ok) return checked
  const { entry, markedNow } = checked
  return {
    ok: true,
    preview: {
      journal_entry_id: journalEntryId,
      verifikat: formatVoucher(entry),
      entry_date: entry.entry_date,
      description: entry.description ?? '',
      marked_now: markedNow,
    },
  }
}

interface MarkableEntryRow {
  id: string
  status: string
  source_type: string | null
  entry_date: string
  reverses_id: string | null
  voucher_series: string | null
  voucher_number: number | null
  description: string | null
}

/**
 * Every check a mark or its withdrawal makes before anything is written, so
 * the preview an approver sees and the write refuse alike. A mark needs a
 * verifikat the shapes catch (one already marked has nothing left to check:
 * marking it again writes nothing); a withdrawal needs a live mark.
 */
async function checkMarkAction(
  supabase: SupabaseClient,
  companyId: string,
  journalEntryId: string,
  action: 'mark' | 'withdraw',
): Promise<{ ok: true; entry: MarkableEntryRow; markedNow: boolean } | Failure> {
  const markable = await markableEntry(supabase, companyId, journalEntryId)
  if (!markable.ok) return markable
  const markedNow = await isMarkedNotMomsredovisning(supabase, companyId, journalEntryId)
  if (action === 'withdraw' && !markedNow) return { ok: false, code: 'VAT_MARK_NOT_FOUND' }
  if (action === 'mark' && !markedNow && !(await caughtByShapes(supabase, companyId, markable.entry))) {
    return { ok: false, code: 'VAT_MARK_NOT_SHAPE' }
  }
  return { ok: true, entry: markable.entry, markedNow }
}

/**
 * Whether the momsdeklaration takes the verifikat for a momsredovisning: its
 * own totals (fetchVatAccountTotals, get_vat_declaration_totals over
 * vat_declaration_special_entries) list it among the settlement-shaped
 * entries. The shapes judge each verifikat by its own lines, so its own day
 * answers as its whole VAT period would. The totals come back as one row, so
 * no PostgREST row cap can cut the list short.
 */
async function caughtByShapes(
  supabase: SupabaseClient,
  companyId: string,
  entry: Pick<MarkableEntryRow, 'id' | 'entry_date'>,
): Promise<boolean> {
  const { settlementShapedEntries } = await fetchVatAccountTotals(supabase, companyId, entry.entry_date, entry.entry_date)
  return settlementShapedEntries.some((shaped) => shaped.id === entry.id)
}

/** The checks a mark and its withdrawal share: the verifikat and its period. */
async function markableEntry(
  supabase: SupabaseClient,
  companyId: string,
  journalEntryId: string,
): Promise<{ ok: true; entry: MarkableEntryRow } | Failure> {
  const { data: entry, error } = await supabase
    .from('journal_entries')
    .select('id, status, source_type, entry_date, reverses_id, voucher_series, voucher_number, description')
    .eq('id', journalEntryId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw error
  if (!entry) return { ok: false, code: 'JOURNAL_ENTRY_NOT_FOUND' }
  const row = entry as MarkableEntryRow
  if (row.status !== 'posted') return { ok: false, code: 'VAT_MARK_NOT_POSTED' }
  if (row.source_type === 'vat_settlement') return { ok: false, code: 'VAT_MARK_TAGGED_SETTLEMENT' }
  // A storno follows its original's mark (vat_declaration_special_entries):
  // marked on its own, it would be read while the original it annuls stays out.
  if (row.source_type === 'storno' || row.reverses_id) return { ok: false, code: 'VAT_MARK_STORNO' }

  const period = await resolvePeriodStatusForDate(supabase, companyId, row.entry_date)
  if (period.status !== 'open') return { ok: false, code: 'VAT_MARK_PERIOD_LOCKED' }

  const filed = await filedVatPeriodsOfDates(supabase, companyId, [row.entry_date])
  if (filed.has(row.entry_date)) return { ok: false, code: 'VAT_MARK_PERIOD_FILED' }
  return { ok: true, entry: row }
}

async function insertMark(
  writer: SupabaseClient,
  companyId: string,
  userId: string,
  journalEntryId: string,
  action: MarkAction,
): Promise<{ ok: true } | Failure> {
  const { error } = await writer.from('vat_momsredovisning_marks').insert({
    company_id: companyId,
    journal_entry_id: journalEntryId,
    action,
    actor: userId,
  })
  if (error) {
    if (isMissingTable(error)) return { ok: false, code: 'VAT_MARK_NOT_READY' }
    throw error
  }
  return { ok: true }
}

/**
 * Mark a posted verifikat as a correction, not the period's momsredovisning.
 * `supabase` is the person's session (reads, RLS-scoped); `writer` is the
 * service-role client that records the mark once every check has passed.
 */
export async function markNotMomsredovisning(
  supabase: SupabaseClient,
  writer: SupabaseClient,
  companyId: string,
  userId: string,
  journalEntryId: string,
): Promise<{ ok: true; data: MomsredovisningMarkResult } | Failure> {
  const checked = await checkMarkAction(supabase, companyId, journalEntryId, 'mark')
  if (!checked.ok) return checked
  if (checked.markedNow) {
    return { ok: true, data: { journal_entry_id: journalEntryId, marked: true, changed: false } }
  }
  const inserted = await insertMark(writer, companyId, userId, journalEntryId, 'not_momsredovisning')
  if (!inserted.ok) return inserted
  return { ok: true, data: { journal_entry_id: journalEntryId, marked: true, changed: true } }
}

/** Withdraw the mark: the shapes decide again whether it is a momsredovisning. */
export async function withdrawNotMomsredovisning(
  supabase: SupabaseClient,
  writer: SupabaseClient,
  companyId: string,
  userId: string,
  journalEntryId: string,
): Promise<{ ok: true; data: MomsredovisningMarkResult } | Failure> {
  const checked = await checkMarkAction(supabase, companyId, journalEntryId, 'withdraw')
  if (!checked.ok) return checked
  const inserted = await insertMark(writer, companyId, userId, journalEntryId, 'withdrawn')
  if (!inserted.ok) return inserted
  return { ok: true, data: { journal_entry_id: journalEntryId, marked: false, changed: true } }
}
