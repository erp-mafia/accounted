import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'

/**
 * Two-step fetch for journal_entry_lines scoped by journal_entries filters.
 *
 * WHY THIS EXISTS: the previous pattern selected from journal_entry_lines
 * with a `journal_entries!inner(...)` embed and put every scope filter on
 * the embedded side (`.eq('journal_entries.company_id', ...)`). PostgREST
 * compiles that embed to a correlated INNER JOIN LATERAL with a
 * parameterized LIMIT inside, which blocks Postgres from reordering the
 * join: every report query walked the ENTIRE journal_entry_lines table
 * (all tenants) instead of starting from the handful of matching entries.
 * Measured in production: 13.6 s vs 2.7 ms for the equivalent plain join,
 * against Supabase's 8 s statement_timeout, which 500'd reports and made
 * nightly backups fail.
 *
 * The fix drives the query from the journal_entries side instead:
 *   1. fetch the matching journal_entries (id + whatever entry columns the
 *      caller needs), paginated via fetchAllRows;
 *   2. fetch journal_entry_lines with `.in('journal_entry_id', chunk)` in
 *      chunks of {@link ENTRY_ID_CHUNK_SIZE} ids (URL-length safety),
 *      paginated per chunk;
 *   3. reattach the parent entry object to each line under the same key the
 *      embed produced (`line.journal_entries = {...}` by default), so call
 *      sites keep their downstream code unchanged, and sort all lines by id
 *      ascending to preserve the old `.order('id')` semantics.
 */

/** Max journal_entry ids per `.in()` filter: keeps the request URL short. */
const ENTRY_ID_CHUNK_SIZE = 100

/** How many line chunks are fetched in parallel. */
const CHUNK_BATCH_SIZE = 5

/**
 * PostgREST query builders carry deep generic types that do not survive
 * being passed through a callback; the helper only needs "builder in,
 * builder out", so the filter callbacks are typed structurally.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type EntryLinesQuery = any

export interface FetchEntryLinesOptions {
  supabase: SupabaseClient
  /**
   * Columns to select from journal_entries. `id` is always included (it is
   * needed for chunking, paging order, and reattachment). Defaults to just
   * `id` for callers that only use the entry side as a filter.
   */
  entryColumns?: string
  /**
   * Columns to select from journal_entry_lines. `id` and `journal_entry_id`
   * are always included (stable paging order + parent reattachment).
   */
  lineColumns: string
  /**
   * Applies the entry-level filters (company_id, fiscal_period_id, status,
   * entry_date range, source_type, ...). MUST filter by company_id: this is
   * the tenant scope. Filters that used to target the embed
   * (`.eq('journal_entries.company_id', x)`) become plain column filters
   * here (`.eq('company_id', x)`).
   */
  filterEntries: (query: EntryLinesQuery) => EntryLinesQuery
  /**
   * Optional line-level filters (account_number ranges, jsonb dimension
   * containment, ...), applied to every chunk query.
   */
  filterLines?: (query: EntryLinesQuery) => EntryLinesQuery
  /**
   * Key the parent entry object is attached under on each returned line.
   * Defaults to 'journal_entries' (the un-aliased PostgREST embed key).
   * Pass e.g. 'journal_entry' for call sites that aliased the embed, or
   * null to skip reattachment entirely.
   */
  attachEntriesAs?: string | null
}

/** Ensure `required` columns are present in a comma-separated select list. */
function ensureColumns(select: string, required: string[]): string {
  const parts = select
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (parts.includes('*')) return parts.join(', ')
  for (const col of required) {
    if (!parts.includes(col)) parts.push(col)
  }
  return parts.join(', ')
}

/** Sort by id ascending; rows without an id keep their relative order. */
function compareById(a: { id?: unknown }, b: { id?: unknown }): number {
  const aId = a.id
  const bId = b.id
  if (typeof aId !== 'string' || typeof bId !== 'string') return 0
  return aId < bId ? -1 : aId > bId ? 1 : 0
}

/**
 * Fetch journal_entry_lines for an explicit list of journal_entry ids, in
 * chunks of {@link ENTRY_ID_CHUNK_SIZE}, each chunk paginated via
 * fetchAllRows. Lines are returned sorted by id ascending. Used directly by
 * callers that already hold the parent entries (e.g. SIE export); most call
 * sites want {@link fetchEntryLines} instead.
 */
export async function fetchLinesByEntryIds<TLine extends { id?: unknown }>(
  supabase: SupabaseClient,
  entryIds: string[],
  lineColumns: string,
  filterLines?: (query: EntryLinesQuery) => EntryLinesQuery
): Promise<TLine[]> {
  if (entryIds.length === 0) return []

  const select = ensureColumns(lineColumns, ['id', 'journal_entry_id'])

  const chunks: string[][] = []
  for (let i = 0; i < entryIds.length; i += ENTRY_ID_CHUNK_SIZE) {
    chunks.push(entryIds.slice(i, i + ENTRY_ID_CHUNK_SIZE))
  }

  const allLines: TLine[] = []
  for (let i = 0; i < chunks.length; i += CHUNK_BATCH_SIZE) {
    const batch = chunks.slice(i, i + CHUNK_BATCH_SIZE)
    const results = await Promise.all(
      batch.map((chunk) =>
        fetchAllRows<TLine>(
          ({ from, to }) => {
            let query: EntryLinesQuery = supabase
              .from('journal_entry_lines')
              .select(select)
              .in('journal_entry_id', chunk)
            if (filterLines) query = filterLines(query)
            // Stable total order on the line PK for correct paging within the
            // chunk (see fetch-all.ts ordering invariant).
            return query.order('id', { ascending: true }).range(from, to)
          },
          { dedupeBy: (r) => String((r as { id?: unknown }).id) }
        )
      )
    )
    for (const rows of results) allLines.push(...rows)
  }

  // Chunk concatenation is not globally ordered; re-sort so callers see the
  // same id-ascending order the old single embed query produced.
  allLines.sort(compareById)
  return allLines
}

/**
 * Fetch journal_entry_lines whose parent journal_entries match
 * `filterEntries`, with the parent entry reattached to each line. See the
 * module docstring for why this replaces the `journal_entries!inner` embed.
 *
 * The generic `TLine` is the caller-declared shape of a returned line,
 * INCLUDING the attached entry key (e.g. `journal_entries: {...}`).
 */
export async function fetchEntryLines<TLine>(
  options: FetchEntryLinesOptions
): Promise<TLine[]> {
  const { supabase, lineColumns, filterEntries, filterLines } = options
  const entryColumns = ensureColumns(options.entryColumns ?? 'id', ['id'])
  const attachKey =
    options.attachEntriesAs === undefined
      ? 'journal_entries'
      : options.attachEntriesAs

  const entries = await fetchAllRows<{ id: string }>(
    ({ from, to }) =>
      filterEntries(supabase.from('journal_entries').select(entryColumns))
        // Stable total order on the entry PK for correct paging.
        .order('id', { ascending: true })
        .range(from, to),
    { dedupeBy: (e) => e.id }
  )

  if (entries.length === 0) return []

  const entryById = new Map(entries.map((e) => [e.id, e]))

  const lines = await fetchLinesByEntryIds<Record<string, unknown>>(
    supabase,
    entries.map((e) => e.id),
    lineColumns,
    filterLines
  )

  if (attachKey) {
    for (const line of lines) {
      line[attachKey] = entryById.get(line.journal_entry_id as string)
    }
  }

  return lines as TLine[]
}
