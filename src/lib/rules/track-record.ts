import type { SupabaseClient } from '@supabase/supabase-js'
import { toCounterpartyTemplateId } from '@/lib/bookkeeping/counterparty-template-format'

/**
 * A rule's track record: of the bank lines where the rule was the first
 * suggestion and someone then booked the line, how many were booked as the
 * rule proposed. Read from the decision receipts (suggestion_log), never from
 * the rule's own counters: occurrence_count also counts imported history and
 * the bookings that taught the rule, and corrections only the changes that
 * rewrote it.
 *
 * "As proposed" is the receipt's matches_final on the rule's suggestion: the
 * booking agrees with it, whether the suggestion was clicked or the same
 * account was booked by hand. A dismissed line is no decision about the rule.
 *
 * The counts for the rule's current version use the version the suggestion
 * recorded (evidence.template_version, from migration 20261128110000); a
 * receipt from before that has none, so the current-version counts start
 * there.
 */

/** At most this many of the newest decisions are read. */
export const TRACK_RECORD_WINDOW = 500

/** Postgres: the column does not exist (migration 20261128110000 has not run here yet). */
const UNDEFINED_COLUMN = '42703'

export interface TrackCounts {
  /** Decided bank lines where the rule was the first suggestion. */
  decided: number
  /** Of those, booked as the rule proposed. */
  as_proposed: number
}

export interface RuleTrackRecord extends TrackCounts {
  /** The rule's current version; null before versions are recorded. */
  version: number | null
  /** The same counts for the current version alone; null before versions are recorded. */
  current: TrackCounts | null
  /** True when only the newest TRACK_RECORD_WINDOW decisions were read. */
  capped: boolean
}

/** The first suggestion of one decided bank line, as suggestion_log keeps it. */
export interface TopSuggestionRow {
  top: unknown
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** The counts over rows whose first suggestion is the rule's. Pure. */
export function trackRecordFrom(
  rows: readonly TopSuggestionRow[],
  templateId: string,
  version: number | null,
  capped = false,
): RuleTrackRecord {
  const sourceId = toCounterpartyTemplateId(templateId)
  const all: TrackCounts = { decided: 0, as_proposed: 0 }
  const current: TrackCounts = { decided: 0, as_proposed: 0 }
  for (const row of rows) {
    const top = row.top
    if (!isObject(top) || top.source_id !== sourceId) continue
    const right = top.matches_final === true
    all.decided += 1
    if (right) all.as_proposed += 1
    const evidence = isObject(top.evidence) ? top.evidence : null
    if (version !== null && evidence?.template_version === version) {
      current.decided += 1
      if (right) current.as_proposed += 1
    }
  }
  return { ...all, version, current: version === null ? null : current, capped }
}

/**
 * The track record of one rule of the company. The rule's version is read on
 * its own so a database without the column still answers the counts.
 */
export async function readRuleTrackRecord(
  supabase: SupabaseClient,
  companyId: string,
  templateId: string,
): Promise<RuleTrackRecord> {
  const [versionRead, decisions] = await Promise.all([
    supabase.from('categorization_templates').select('version').eq('company_id', companyId).eq('id', templateId).maybeSingle(),
    supabase
      .from('suggestion_log')
      .select('top:suggestions->0')
      .eq('company_id', companyId)
      .eq('kind', 'bank_line')
      .neq('outcome', 'dismissed')
      .eq('suggestions->0->>source_id', toCounterpartyTemplateId(templateId))
      .order('created_at', { ascending: false })
      .limit(TRACK_RECORD_WINDOW),
  ])
  if (decisions.error) throw decisions.error
  if (versionRead.error && versionRead.error.code !== UNDEFINED_COLUMN) throw versionRead.error
  const raw = (versionRead.error ? null : (versionRead.data as { version?: unknown } | null))?.version
  const version = typeof raw === 'number' ? raw : null
  const rows = (decisions.data ?? []) as TopSuggestionRow[]
  return trackRecordFrom(rows, templateId, version, rows.length >= TRACK_RECORD_WINDOW)
}
