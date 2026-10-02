/**
 * Retagging posted lines: changing the dimension tags (kostnadsställe,
 * projekt, custom dimensions) on lines of posted verifikat, the one thing
 * about a posted line that may change. The write itself is the audited
 * retag_line_dimensions RPC: it checks the line, the open period, the
 * company lock date, the active registry values and the writer's role,
 * writes the immutable dimension_retag_log row and sets the line's bag.
 *
 * The RPC takes a line's WHOLE bag. What the caller asks for is either:
 *
 *   - merge: set these pairs and keep every other dimension the line
 *     carries. What the dashboard workbench does by default, and what an
 *     agent tagging projekt on lines that already carry a kostnadsställe
 *     means;
 *   - replace: the bag becomes exactly this map (consolidating typo or
 *     phantom codes).
 *
 * This module turns the request into each line's final bag and runs the
 * RPC, one transaction per line: a line refused (its period was locked in
 * between, say) never rolls back the lines already retagged. One
 * implementation behind the approval of gnubok_tag_journal_lines, the v1
 * retag operation (lib/operations/dimension-retag.ts) and the dashboard
 * workbench (POST /api/dimensions/tagging/apply, which sends each line's
 * resulting bag as a replace).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { LineDimensions } from '@/lib/bookkeeping/dimension-resolver'
import { dbError } from '@/lib/errors/db-error'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'

export const RETAG_MODES = ['merge', 'replace'] as const
export type RetagMode = (typeof RETAG_MODES)[number]

/** Line ids per `.in()` query: keeps the request URL short. */
const ID_CHUNK = 100

/** A line's stored bag (journal_entry_lines.dimensions): a plain object, else none. */
export function storedDimensions(raw: unknown): LineDimensions {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  return { ...(raw as LineDimensions) }
}

/**
 * The bag a line ends up with. The line's own pairs are kept verbatim in a
 * merge, even ones the registry no longer knows: dropping one here would be
 * a silent replace, and the RPC refuses an unknown or archived code with a
 * message that names it instead.
 */
export function resultingDimensions(current: unknown, requested: LineDimensions, mode: RetagMode): LineDimensions {
  return mode === 'merge' ? { ...storedDimensions(current), ...requested } : { ...requested }
}

/** True when two bags hold the same pairs, whatever their key order. */
export function sameDimensions(a: LineDimensions, b: LineDimensions): boolean {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => b[key] === a[key])
}

/** "1=KS01, 6=P001": a bag as one short line, dimensions in number order. */
export function dimensionsLabel(bag: LineDimensions): string {
  return Object.keys(bag)
    .sort((x, y) => Number(x) - Number(y))
    .map((key) => `${key}=${bag[key]}`)
    .join(', ')
}

/**
 * The current bag of each line that belongs to the company, by line id.
 * journal_entry_lines has no company_id: the lines are read by id and kept
 * only when their parent entry is the company's, so a foreign id is simply
 * absent (and never tells anyone another company's tags).
 */
export async function fetchLineDimensions(
  supabase: SupabaseClient,
  companyId: string,
  lineIds: readonly string[],
): Promise<Map<string, LineDimensions>> {
  const lines: Array<{ id: string; journal_entry_id: string; dimensions: unknown }> = []
  for (let i = 0; i < lineIds.length; i += ID_CHUNK) {
    // At most ID_CHUNK rows by primary key: under PostgREST's 1000-row cap.
    const { data, error } = await supabase
      .from('journal_entry_lines')
      .select('id, journal_entry_id, dimensions')
      .in('id', lineIds.slice(i, i + ID_CHUNK))
    if (error) throw dbError(error)
    lines.push(...((data ?? []) as typeof lines))
  }

  const entryIds = [...new Set(lines.map((line) => line.journal_entry_id))]
  const ownEntries = new Set<string>()
  for (let i = 0; i < entryIds.length; i += ID_CHUNK) {
    const { data, error } = await supabase
      .from('journal_entries')
      .select('id')
      .eq('company_id', companyId)
      .in('id', entryIds.slice(i, i + ID_CHUNK))
    if (error) throw dbError(error)
    for (const entry of (data ?? []) as Array<{ id: string }>) ownEntries.add(entry.id)
  }

  const bags = new Map<string, LineDimensions>()
  for (const line of lines) {
    if (ownEntries.has(line.journal_entry_id)) bags.set(line.id, storedDimensions(line.dimensions))
  }
  return bags
}

export interface RetagLinesInput {
  line_ids: string[]
  /** merge: the pairs to set; replace: the whole bag. */
  dimensions: LineDimensions
  mode: RetagMode
  reason: string
}

export interface RetagLineFailure {
  line_id: string
  error: string
}

export interface RetagLinesResult {
  retagged: number
  unchanged: number
  failed: RetagLineFailure[]
}

export interface RetagLinePreview {
  line_id: string
  dimensions_before: LineDimensions
  dimensions_after: LineDimensions
}

export interface RetagLinesPreview {
  mode: RetagMode
  lines: RetagLinePreview[]
  /** Ids that are no line of this company's: refused at commit. */
  missing_line_ids: string[]
  unchanged_lines: number
}

const LINE_NOT_FOUND = 'Verifikationsraden hittades inte.'

/**
 * Retag the lines, each in its own RPC transaction, in the order given.
 * A merge reads the lines' bags first (company-scoped); a line that is not
 * the company's is refused without an RPC call, never retagged with the
 * requested pairs alone, which would be a replace in disguise. A dry run
 * reads and computes every line's resulting bag and writes nothing; the RPC
 * checks (period, lock date, registry, role) run at commit.
 */
export async function retagLines(
  ctx: OperationContext,
  input: RetagLinesInput,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<RetagLinesResult>> {
  const { supabase, companyId, userId, log } = ctx

  let current: Map<string, LineDimensions> | null = null
  if (input.mode === 'merge' || options.dryRun) {
    try {
      current = await fetchLineDimensions(supabase, companyId, input.line_ids)
    } catch (error) {
      log.error('retag: reading the lines failed', error as Error)
      return { ok: false, code: 'UNKNOWN_ERROR', error }
    }
  }

  if (options.dryRun) {
    const found = current as Map<string, LineDimensions>
    const lines: RetagLinePreview[] = []
    const missing: string[] = []
    let unchangedLines = 0
    for (const lineId of input.line_ids) {
      const before = found.get(lineId)
      if (!before) {
        missing.push(lineId)
        continue
      }
      const after = resultingDimensions(before, input.dimensions, input.mode)
      if (sameDimensions(before, after)) unchangedLines++
      lines.push({ line_id: lineId, dimensions_before: before, dimensions_after: after })
    }
    const preview: RetagLinesPreview = { mode: input.mode, lines, missing_line_ids: missing, unchanged_lines: unchangedLines }
    return { ok: true, dryRun: true, preview: { ...preview } }
  }

  let retagged = 0
  let unchanged = 0
  const failed: RetagLineFailure[] = []

  // Sequential on purpose: each call locks the line and writes an audit row;
  // hundreds of concurrent transactions buy nothing and contend with live
  // bookkeeping.
  for (const lineId of input.line_ids) {
    let bag = input.dimensions
    if (input.mode === 'merge') {
      const own = current?.get(lineId)
      if (!own) {
        failed.push({ line_id: lineId, error: LINE_NOT_FOUND })
        continue
      }
      bag = resultingDimensions(own, input.dimensions, 'merge')
    }
    const { data, error } = await supabase.rpc('retag_line_dimensions', {
      p_company_id: companyId,
      p_line_id: lineId,
      p_dimensions: bag,
      p_reason: input.reason,
      p_user_id: userId,
    })
    if (error) {
      failed.push({ line_id: lineId, error: getUserErrorMessage(error) })
      continue
    }
    if ((data as { changed?: boolean } | null)?.changed) retagged++
    else unchanged++
  }

  return { ok: true, data: { retagged, unchanged, failed } }
}

/**
 * The machine doors' reading of a retag: partial success is success (each
 * line is its own transaction and the failures are listed), but when every
 * line was refused the operation failed, and says why with the first error.
 */
export function everyRetagRefused(result: RetagLinesResult): { messageSv: string } | null {
  if (result.failed.length === 0 || result.retagged > 0 || result.unchanged > 0) return null
  return {
    messageSv:
      `Ingen rad kunde taggas om (${result.failed.length} rader misslyckades). ` +
      `Första felet: ${result.failed[0].error}`,
  }
}
