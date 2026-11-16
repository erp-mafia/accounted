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
 *
 * A line in a closed or locked period, or on or before the company lock
 * date, is never retagged. Whether a line is one is asked in one place
 * (./retag-lock.ts), by the dry run and by the commit alike, so a preview
 * counts the lines an approval will tag, and every line left untagged
 * carries its reason: an answer where lines were left is 'partial', never a
 * bare success (crm#1908).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { LineDimensions } from '@/lib/bookkeeping/dimension-resolver'
import { fetchActiveDimensionRules, type AccountDimensionRule } from '@/lib/bookkeeping/dimension-rules'
import { dbError } from '@/lib/errors/db-error'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import { fetchRetagLockFacts, retagBlockOf, RETAG_BLOCK_REASONS, type RetagLockFacts } from './retag-lock'

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

/**
 * A line as the retag reads it: its account, its current bag, and the date
 * and fiscal period of its verifikat (what the lock check reads).
 */
export interface RetagLine {
  account_number: string
  dimensions: LineDimensions
  entry_date: string
  fiscal_period_id: string | null
}

/**
 * The account, current bag and verifikat of each line that belongs to the
 * company, by line id. journal_entry_lines has no company_id: the lines are
 * read by id and kept only when their parent entry is the company's, so a
 * foreign id is simply absent (and never tells anyone another company's
 * tags).
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

  type OwnEntry = { id: string; entry_date: string; fiscal_period_id: string | null }
  const entryIds = [...new Set(lines.map((line) => line.journal_entry_id))]
  const ownEntries = new Map<string, OwnEntry>()
  for (let i = 0; i < entryIds.length; i += ID_CHUNK) {
    const { data, error } = await supabase
      .from('journal_entries')
      .select('id, entry_date, fiscal_period_id')
      .eq('company_id', companyId)
      .in('id', entryIds.slice(i, i + ID_CHUNK))
    if (error) throw dbError(error)
    for (const entry of (data ?? []) as OwnEntry[]) ownEntries.set(entry.id, entry)
  }

  const found = new Map<string, RetagLine>()
  for (const line of lines) {
    const entry = ownEntries.get(line.journal_entry_id)
    if (entry) {
      found.set(line.id, {
        account_number: String(line.account_number),
        dimensions: storedDimensions(line.dimensions),
        entry_date: entry.entry_date,
        fiscal_period_id: entry.fiscal_period_id ?? null,
      })
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

/**
 * Why a line was left untagged: the lock check's reasons (./retag-lock.ts),
 * a line that is not the company's, a dimension its account requires, or the
 * RPC's own refusal (a draft, a code that is not an active registry value, a
 * period locked after the lock check).
 */
export const RETAG_FAILURE_REASONS = [
  ...RETAG_BLOCK_REASONS,
  'line_not_found',
  'required_dimension',
  'refused',
] as const
export type RetagFailureReason = (typeof RETAG_FAILURE_REASONS)[number]

export interface RetagLineFailure {
  line_id: string
  /** The refusal, in Swedish. */
  error: string
  reason: RetagFailureReason
  /** The date of the line's verifikat, where the line was read. */
  entry_date?: string
}

/** The lines left untagged for one reason, counted. */
export interface RetagFailureGroup {
  reason: RetagFailureReason
  lines: number
  /** The refusal, in Swedish. */
  message: string
  /** First and last verifikat date among the lines, where known. */
  date_from?: string
  date_to?: string
}

/**
 * Failures counted per reason and sentence, in the order they first occur:
 * the whole count, also where a door lists only the first lines.
 */
export function groupRetagFailures(failed: readonly RetagLineFailure[]): RetagFailureGroup[] {
  const groups = new Map<string, RetagFailureGroup>()
  for (const failure of failed) {
    const key = `${failure.reason}: ${failure.error}`
    const group: RetagFailureGroup = groups.get(key) ?? { reason: failure.reason, lines: 0, message: failure.error }
    group.lines++
    if (failure.entry_date) {
      if (!group.date_from || failure.entry_date < group.date_from) group.date_from = failure.entry_date
      if (!group.date_to || failure.entry_date > group.date_to) group.date_to = failure.entry_date
    }
    groups.set(key, group)
  }
  return [...groups.values()]
}

/**
 * A failure group as one Swedish sentence for a person: how many lines,
 * their dates, and the refusal as it was given.
 */
export function describeRetagFailureGroup(group: RetagFailureGroup): string {
  const count = group.lines === 1 ? '1 rad' : `${group.lines} rader`
  const dates =
    !group.date_from || !group.date_to
      ? ''
      : group.date_from === group.date_to
        ? ` (${group.date_from})`
        : ` (${group.date_from} till ${group.date_to})`
  return `${count}${dates}: ${group.message}`
}

/**
 * How much of a retag went through: every line ('complete'), some
 * ('partial') or none. A line that already carried the tags counts as done.
 */
export type RetagOutcome = 'complete' | 'partial' | 'none'

export interface RetagLinesResult {
  outcome: RetagOutcome
  retagged: number
  unchanged: number
  failed: RetagLineFailure[]
  /** Every failed line, counted per reason. */
  failed_by_reason: RetagFailureGroup[]
}

function retagResult(retagged: number, unchanged: number, failed: RetagLineFailure[]): RetagLinesResult {
  const outcome: RetagOutcome = failed.length === 0 ? 'complete' : retagged + unchanged > 0 ? 'partial' : 'none'
  return { outcome, retagged, unchanged, failed, failed_by_reason: groupRetagFailures(failed) }
}

/**
 * The sentence a machine door says beside a partial answer, so a status of
 * 'committed' or 200 is never read as every line tagged. Null when every
 * line went through.
 */
export function partialRetagWarning(result: RetagLinesResult): string | null {
  if (result.failed.length === 0) return null
  const total = result.retagged + result.unchanged + result.failed.length
  const reasons = result.failed_by_reason
    .map((group) => {
      const dates =
        group.date_from && group.date_to
          ? group.date_from === group.date_to
            ? `, ${group.date_from}`
            : `, ${group.date_from} to ${group.date_to}`
          : ''
      return `${group.lines} ${group.reason}${dates}`
    })
    .join('; ')
  return (
    `PARTIAL: ${result.failed.length} of ${total} lines were NOT tagged (${reasons}). ` +
    `${result.retagged} were tagged and ${result.unchanged} already carried the tags. ` +
    'failed_by_reason gives the reason per group: tell the user which lines were left and why.'
  )
}

export interface RetagLinePreview {
  line_id: string
  dimensions_before: LineDimensions
  dimensions_after: LineDimensions
  /** Set when the line cannot be retagged: its bag stays dimensions_before. */
  blocked?: RetagFailureReason
}

export interface RetagLinesPreview {
  mode: RetagMode
  lines: RetagLinePreview[]
  /** Lines the commit will tag, or find already tagged. */
  taggable_lines: number
  /** Ids that are no line of this company's: refused at commit. */
  missing_line_ids: string[]
  /** Lines that would lose a dimension their account requires: refused at commit. */
  refused_lines: RetagLineFailure[]
  /** Lines in a closed or locked period, or on or before the lock date: refused at commit. */
  blocked_lines: RetagLineFailure[]
  /** The blocked lines counted per reason, with their first and last date. */
  blocked_by_reason: RetagFailureGroup[]
  /** Taggable lines that already carry the resulting tags. */
  unchanged_lines: number
}

const LINE_NOT_FOUND = 'Verifikationsraden hittades inte.'

/**
 * Retag the lines, each in its own RPC transaction, in the order given.
 * The lines are read first (company-scoped), with the lock state of their
 * periods. A line that is not the company's is refused without an RPC call,
 * never retagged with the requested pairs alone, which would be a replace in
 * disguise. A line in a closed or locked period, or on or before the lock
 * date (./retag-lock.ts), is refused the same way, with that reason. A
 * request that may take a dimension off reads the company's rules: a line
 * that would lose a dimension its account requires is refused too. A dry run
 * makes the same checks and writes nothing; the RPC checks (the period once
 * more, the registry, the role) run at commit.
 */
export async function retagLines(
  ctx: OperationContext,
  input: RetagLinesInput,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<RetagLinesResult>> {
  const { supabase, companyId, userId, log } = ctx

  const rules = await requiredRulesFor(supabase, companyId, input.dimensions, input.mode)

  let current: Map<string, RetagLine>
  let locks: RetagLockFacts
  try {
    current = await fetchRetagLines(supabase, companyId, input.line_ids)
    locks = await fetchRetagLockFacts(
      supabase,
      companyId,
      [...current.values()].map((line) => line.fiscal_period_id),
    )
  } catch (error) {
    // Nothing was written. A lock state that could not be read is never
    // taken for open: the retag waits for a read that works.
    log.error('retag: reading the lines or their period locks failed', error as Error)
    return { ok: false, code: 'UNKNOWN_ERROR', error }
  }

  /** Why the line is left untagged before any RPC call, else null. */
  const refusalOf = (lineId: string, line: RetagLine, after: LineDimensions): RetagLineFailure | null => {
    const block = retagBlockOf(locks, line)
    if (block) return { line_id: lineId, error: block.message, reason: block.reason, entry_date: line.entry_date }
    const removed = requiredDimensionsRemoved(line.account_number, line.dimensions, after, rules)
    if (removed.length === 0) return null
    return {
      line_id: lineId,
      error: requiredDimensionRemovedMessage(line.account_number, removed),
      reason: 'required_dimension',
      entry_date: line.entry_date,
    }
  }

  if (options.dryRun) {
    const lines: RetagLinePreview[] = []
    const missing: string[] = []
    const refused: RetagLineFailure[] = []
    const blocked: RetagLineFailure[] = []
    let unchangedLines = 0
    for (const lineId of input.line_ids) {
      const line = current.get(lineId)
      if (!line) {
        missing.push(lineId)
        continue
      }
      const after = resultingDimensions(line.dimensions, input.dimensions, input.mode)
      const refusal = refusalOf(lineId, line, after)
      if (refusal?.reason === 'required_dimension') refused.push(refusal)
      else if (refusal) blocked.push(refusal)
      else if (sameDimensions(line.dimensions, after)) unchangedLines++
      lines.push({
        line_id: lineId,
        dimensions_before: line.dimensions,
        dimensions_after: after,
        ...(refusal && refusal.reason !== 'required_dimension' ? { blocked: refusal.reason } : {}),
      })
    }
    const preview: RetagLinesPreview = {
      mode: input.mode,
      lines,
      taggable_lines: lines.length - refused.length - blocked.length,
      missing_line_ids: missing,
      refused_lines: refused,
      blocked_lines: blocked,
      blocked_by_reason: groupRetagFailures(blocked),
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
    const own = current.get(lineId)
    if (!own) {
      failed.push({ line_id: lineId, error: LINE_NOT_FOUND, reason: 'line_not_found' })
      continue
    }
    const bag = resultingDimensions(own.dimensions, input.dimensions, input.mode)
    const refusal = refusalOf(lineId, own, bag)
    if (refusal) {
      failed.push(refusal)
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
      failed.push({
        line_id: lineId,
        error: getUserErrorMessage(error),
        reason: 'refused',
        entry_date: own.entry_date,
      })
      continue
    }
    if ((data as { changed?: boolean } | null)?.changed) retagged++
    else unchanged++
  }

  return { ok: true, data: retagResult(retagged, unchanged, failed) }
}

/** The refusal of a retag where no line went through, naming the first error. */
export function noLineRetaggedMessage(result: RetagLinesResult): string {
  return (
    `Ingen rad kunde taggas om (${result.failed.length} rader misslyckades). ` +
    `Första felet: ${result.failed[0].error}`
  )
}

/**
 * The machine doors' reading of a retag where no line went through (outcome
 * 'none'): the operation failed, and says why with the first error. A
 * partial answer is not this failure (each line is its own transaction, and
 * the lines that went through stay retagged): it is answered with its
 * outcome, its counts per reason and partialRetagWarning.
 */
export function everyRetagRefused(result: RetagLinesResult): { messageSv: string } | null {
  return result.outcome === 'none' ? { messageSv: noLineRetaggedMessage(result) } : null
}
