import { NEEDS_DOC_SOURCE_TYPES } from '@/lib/worklist/categories'

/**
 * Row-level underlag status for a booked transaction's journal entry.
 *
 * - 'has'    : the verifikation has at least one current-version document
 * - 'missing': the verifikation's source type requires underlag (BFL 5 kap
 *               7§), has none, and is not exempted via journal_entry_no_doc_required
 * - 'none'   : no statement either way (system-generated source types,
 *               exempted entries): render no badge
 *
 * Mirrors countVerifikatMissingDocument in lib/worklist/categories.ts at row
 * granularity so the per-row "Underlag saknas" badge and the worklist count
 * never disagree on what counts as missing. Contract: callers must pass only
 * POSTED entries (filter journal_entries on status = 'posted', like the
 * worklist does): reversed/corrected entries must render no badge at all,
 * never 'missing'.
 */
export type JeUnderlagStatus = 'has' | 'missing' | 'none'

const NEEDS_DOC = new Set<string>(NEEDS_DOC_SOURCE_TYPES)

export function computeJeUnderlagStatus(
  entries: Array<{ id: string; source_type: string | null }>,
  jeIdsWithDocs: ReadonlySet<string>,
  exemptJeIds: ReadonlySet<string>,
): Record<string, JeUnderlagStatus> {
  const result: Record<string, JeUnderlagStatus> = {}
  for (const entry of entries) {
    if (jeIdsWithDocs.has(entry.id)) {
      result[entry.id] = 'has'
    } else if (
      entry.source_type != null &&
      NEEDS_DOC.has(entry.source_type) &&
      !exemptJeIds.has(entry.id)
    ) {
      result[entry.id] = 'missing'
    } else {
      result[entry.id] = 'none'
    }
  }
  return result
}
