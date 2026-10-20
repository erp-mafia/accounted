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
 * An empty code removes that dimension ({"6": ""}, crm#1313): in a merge it
 * takes that one dimension off and keeps the others, in a replace it is
 * simply absent from the resulting bag. A dimension an active 'required'
 * account rule demands for the line's account is never taken off a line
 * that carries it: the same policy that refuses posting the line without it
 * (assertMandatoryDimensions in lib/bookkeeping/dimension-rules.ts).
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
import { fetchActiveDimensionRules, type AccountDimensionRule } from '@/lib/bookkeeping/dimension-rules'
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

/** An empty (or blank) code in a request: remove that dimension. */
function isRemoval(code: string): boolean {
  return code.trim() === ''
}

/**
 * The bag a line ends up with. The line's own pairs are kept verbatim in a
 * merge, even ones the registry no longer knows: dropping one here would be
 * a silent replace, and the RPC refuses an unknown or archived code with a
 * message that names it instead. A requested empty code removes the key.
 */
export function resultingDimensions(current: unknown, requested: LineDimensions, mode: RetagMode): LineDimensions {
  const bag = mode === 'merge' ? { ...storedDimensions(current), ...requested } : { ...requested }
  for (const key of Object.keys(bag)) {
    if (isRemoval(bag[key])) delete bag[key]
  }
  return bag
}

/**
 * Whether a request can take a dimension off a line: a replace (every pair
 * the request leaves out goes) or a merge with an empty code. A plain merge
 * only sets pairs, so the required-dimension rule cannot be in play.
 */
export function retagMayRemove(requested: LineDimensions, mode: RetagMode): boolean {
  return mode === 'replace' || Object.values(requested).some(isRemoval)
}

/**
 * The 'required' rules of the line's account whose dimension the line
 * carries now and would not carry after the retag. A line that already
 * lacked one is not this retag's doing: only a removal is refused.
 */
export function requiredDimensionsRemoved(
  accountNumber: string,
  before: LineDimensions,
  after: LineDimensions,
  rules: readonly AccountDimensionRule[] | null,
): AccountDimensionRule[] {
  if (!rules) return []
  return rules.filter(
    (rule) =>
      rule.rule_type === 'required' &&
      rule.account_number === accountNumber &&
      !!before[rule.sie_dim_no] &&
      !after[rule.sie_dim_no],
  )
}

/** The Swedish refusal for a removed required dimension, naming the account and the dimensions. */
export function requiredDimensionRemovedMessage(accountNumber: string, removed: readonly AccountDimensionRule[]): string {
  const names = removed.map((rule) => rule.dimension_name).join(', ')
  return `Konto ${accountNumber} kräver ${names}: dimensionen kan inte tas bort från raden.`
}

/**
 * The company's active rules when a request may take a dimension off and at
 * least one rule is 'required', else null (nothing to check). A failed rule
 * read fails open, like every other reader of the rules.
 */
export async function requiredRulesFor(
  supabase: SupabaseClient,
  companyId: string,
  requested: LineDimensions,
  mode: RetagMode,
): Promise<AccountDimensionRule[] | null> {
  if (!retagMayRemove(requested, mode)) return null
  const rules = await fetchActiveDimensionRules(supabase, companyId)
  return rules?.some((rule) => rule.rule_type === 'required') ? rules : null
}

/** True when two bags hold the same pairs, whatever their key order. */
export function sameDimensions(a: LineDimensions, b: LineDimensions): boolean {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => b[key] === a[key])
}

/**
 * "1=KS01, 6=P001": a bag as one short line, dimensions in number order. A
 * requested removal reads "6 tas bort", a bag without pairs "inga dimensioner".
 */
export function dimensionsLabel(bag: LineDimensions): string {
  const keys = Object.keys(bag)
  if (keys.length === 0) return 'inga dimensioner'
  return keys
    .sort((x, y) => Number(x) - Number(y))
    .map((key) => (isRemoval(bag[key]) ? `${key} tas bort` : `${key}=${bag[key]}`))
    .join(', ')
}

/** A line as the retag reads it: its account and its current bag. */
export interface RetagLine {
  account_number: string
  dimensions: LineDimensions
}

/**
 * The account and current bag of each line that belongs to the company, by
 * line id. journal_entry_lines has no company_id: the lines are read by id
 * and kept only when their parent entry is the company's, so a foreign id is
 * simply absent (and never tells anyone another company's tags).
 */
export async function fetchRetagLines(
  supabase: SupabaseClient,
  companyId: string,
  lineIds: readonly string[],
): Promise<Map<string, RetagLine>> {
  const lines: Array<{ id: string; journal_entry_id: string; account_number: string; dimensions: unknown }> = []
  for (let i = 0; i < lineIds.length; i += ID_CHUNK) {
    // At most ID_CHUNK rows by primary key: under PostgREST's 1000-row cap.
    const { data, error } = await supabase
      .from('journal_entry_lines')
      .select('id, journal_entry_id, account_number, dimensions')
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

  const found = new Map<string, RetagLine>()
  for (const line of lines) {
    if (ownEntries.has(line.journal_entry_id)) {
      found.set(line.id, { account_number: String(line.account_number), dimensions: storedDimensions(line.dimensions) })
    }
  }
  return found
}

export interface RetagLinesInput {
  line_ids: string[]
  /** merge: the pairs to set ("" removes one); replace: the whole bag. */
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
  /** Lines that would lose a dimension their account requires: refused at commit. */
  refused_lines: RetagLineFailure[]
  unchanged_lines: number
}

const LINE_NOT_FOUND = 'Verifikationsraden hittades inte.'

/**
 * Retag the lines, each in its own RPC transaction, in the order given.
 * A merge reads the lines' bags first (company-scoped); a line that is not
 * the company's is refused without an RPC call, never retagged with the
 * requested pairs alone, which would be a replace in disguise. A request
 * that may take a dimension off reads the company's rules, and when one is
 * 'required' the lines too: a line that would lose a dimension its account
 * requires is refused without an RPC call. A dry run reads and computes
 * every line's resulting bag and writes nothing; the RPC checks (period,
 * lock date, registry, role) run at commit.
 */
export async function retagLines(
  ctx: OperationContext,
  input: RetagLinesInput,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<RetagLinesResult>> {
  const { supabase, companyId, userId, log } = ctx

  const rules = await requiredRulesFor(supabase, companyId, input.dimensions, input.mode)

  let current: Map<string, RetagLine> | null = null
  if (input.mode === 'merge' || options.dryRun || rules) {
    try {
      current = await fetchRetagLines(supabase, companyId, input.line_ids)
    } catch (error) {
      log.error('retag: reading the lines failed', error as Error)
      return { ok: false, code: 'UNKNOWN_ERROR', error }
    }
  }

  /** The refusal for a line that would lose a required dimension, else null. */
  const requiredRefusal = (line: RetagLine, after: LineDimensions): string | null => {
    const removed = requiredDimensionsRemoved(line.account_number, line.dimensions, after, rules)
    return removed.length > 0 ? requiredDimensionRemovedMessage(line.account_number, removed) : null
  }

  if (options.dryRun) {
    const found = current as Map<string, RetagLine>
    const lines: RetagLinePreview[] = []
    const missing: string[] = []
    const refused: RetagLineFailure[] = []
    let unchangedLines = 0
    for (const lineId of input.line_ids) {
      const line = found.get(lineId)
      if (!line) {
        missing.push(lineId)
        continue
      }
      const after = resultingDimensions(line.dimensions, input.dimensions, input.mode)
      const refusal = requiredRefusal(line, after)
      if (refusal) refused.push({ line_id: lineId, error: refusal })
      if (sameDimensions(line.dimensions, after)) unchangedLines++
      lines.push({ line_id: lineId, dimensions_before: line.dimensions, dimensions_after: after })
    }
    const preview: RetagLinesPreview = {
      mode: input.mode,
      lines,
      missing_line_ids: missing,
      refused_lines: refused,
      unchanged_lines: unchangedLines,
    }
    return { ok: true, dryRun: true, preview: { ...preview } }
  }

  let retagged = 0
  let unchanged = 0
  const failed: RetagLineFailure[] = []

  // Sequential on purpose: each call locks the line and writes an audit row;
  // hundreds of concurrent transactions buy nothing and contend with live
  // bookkeeping.
  for (const lineId of input.line_ids) {
    const own = current?.get(lineId)
    let bag: LineDimensions
    if (input.mode === 'merge') {
      if (!own) {
        failed.push({ line_id: lineId, error: LINE_NOT_FOUND })
        continue
      }
      bag = resultingDimensions(own.dimensions, input.dimensions, 'merge')
    } else {
      bag = resultingDimensions(null, input.dimensions, 'replace')
    }
    const refusal = own ? requiredRefusal(own, bag) : null
    if (refusal) {
      failed.push({ line_id: lineId, error: refusal })
      continue
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
