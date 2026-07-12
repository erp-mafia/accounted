/**
 * Dimension resolver: the single place line dimensions are normalized
 * (dev_docs/dimensions_implementation_plan.md).
 *
 * Storage model: journal_entry_lines.dimensions is a JSONB map keyed by SIE
 * dimension number ({"1":"KS01","6":"P001"}) and is the single source of
 * truth. Since the PR9 cutover (20260702230000) the cost_center/project
 * columns are GENERATED ALWAYS from keys '1'/'6': writers set only the
 * bag; writing the mirror columns explicitly errors at the database.
 */

import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  DimensionValidationError,
  type DimensionValidationIssue,
} from '@/lib/bookkeeping/dimension-errors'

/** SIE dimension numbers with first-class mirror columns. */
export const DIM_COST_CENTER = '1'
export const DIM_PROJECT = '6'

export type LineDimensions = Record<string, string>

/**
 * THE schema for a dimensions bag ({sie_dim_no: object_code}): the single
 * source of truth for its constraints. The API layer
 * (CreateJournalEntryLineSchema) and the staged pending-operations path
 * (coerceDimensionsBag) both use this exact schema, so the two validation
 * layers cannot drift. Keys are canonical SIE dimension numbers (no leading
 * zeros); values must not contain characters that break SIE field framing.
 */
export const DimensionsBagSchema = z.record(
  z.string().regex(/^[1-9]\d*$/, 'Dimensionsnyckel måste vara ett SIE-dimensionsnummer'),
  z.string().min(1).max(40).regex(/^[^"{}]+$/, 'Dimensionskod får inte innehålla ", { eller }')
)

export interface DimensionAliasInput {
  dimensions?: LineDimensions | null
  cost_center?: string | null
  project?: string | null
}

/**
 * Merge the explicit `dimensions` bag with the deprecated cost_center/project
 * aliases into one canonical map. The explicit bag wins per key; aliases only
 * fill keys the bag does not set. Empty/blank values and non-numeric keys are
 * dropped so the stored map never carries junk entries.
 */
export function normalizeLineDimensions(line: DimensionAliasInput): LineDimensions {
  const out: LineDimensions = {}

  const costCenter = line.cost_center?.trim()
  if (costCenter) out[DIM_COST_CENTER] = costCenter
  const project = line.project?.trim()
  if (project) out[DIM_PROJECT] = project

  if (line.dimensions) {
    for (const [key, value] of Object.entries(line.dimensions)) {
      if (!/^\d+$/.test(key) || Number(key) < 1) continue
      // Canonical numeric form: '01' and '1' must land on the same key, or
      // lineDimensionColumns misses the mirror and reports split the value.
      const dimNo = String(Number(key))
      const trimmed = typeof value === 'string' ? value.trim() : ''
      if (!trimmed) {
        // Explicit empty string in the bag means "clear this dimension": it
        // must also override a non-empty alias, so remove any alias-filled key.
        delete out[dimNo]
        continue
      }
      out[dimNo] = trimmed
    }
  }

  return out
}

/**
 * Boundary validator for an untyped dimensions bag (staged pending-operation
 * params, tool payloads). Delegates to DimensionsBagSchema (the exact schema
 * the API layer uses) so the staged path cannot drift from API validation.
 * Whole-bag semantics: a bag containing ANY invalid entry is rejected
 * (returns undefined) rather than partially salvaged; staged payloads were
 * already schema-validated at staging time, so an invalid entry here means
 * drift or tampering: booking then proceeds without dimensions, which are
 * never load-bearing for validity. Interior normalization
 * (normalizeLineDimensions) stays permissive on charset by design: it must
 * preserve legacy DB values verbatim on reversal/correction; this function is
 * the input gate.
 */
export function coerceDimensionsBag(raw: unknown): LineDimensions | undefined {
  if (raw === undefined || raw === null) return undefined
  const parsed = DimensionsBagSchema.safeParse(raw)
  if (!parsed.success) return undefined
  const dims = normalizeLineDimensions({ dimensions: parsed.data })
  return Object.keys(dims).length > 0 ? dims : undefined
}

/**
 * Merge a line/item-level dimensions bag over a document-level default
 * (producers, PR7: invoice default_dimensions under item.dimensions). The
 * override wins per key; an explicit empty-string override clears the key:
 * the same clear-semantics as normalizeLineDimensions, which does the final
 * cleanup. Returns undefined when the merged bag is empty so callers can
 * assign it to an optional field without writing `{}` noise.
 */
export function mergeDimensionBags(
  base?: LineDimensions | null,
  override?: LineDimensions | null
): LineDimensions | undefined {
  if (!base && !override) return undefined
  const merged = normalizeLineDimensions({
    dimensions: { ...(base ?? {}), ...(override ?? {}) },
  })
  return Object.keys(merged).length > 0 ? merged : undefined
}

/**
 * Stable serialization of a dimensions bag for grouping keys, so generators
 * that aggregate amounts per account can keep items with different dimension
 * tags on separate journal lines (account + bag = the aggregation identity).
 * Key order is canonicalized; '' means "no dimensions". Callers must pass a
 * NORMALIZED bag (mergeDimensionBags/normalizeLineDimensions output): an
 * unnormalized bag ('01' vs '1', untrimmed values) would key differently
 * from its normalized twin.
 */
export function dimensionsBagKey(dimensions?: LineDimensions): string {
  if (!dimensions) return ''
  return JSON.stringify(
    Object.keys(dimensions)
      .sort()
      .map((key) => [key, dimensions[key]])
  )
}

// lineDimensionColumns() was removed in the PR9 cutover: the mirror columns
// are GENERATED ALWAYS from the bag at the database, so there is nothing for
// TypeScript writers to derive: they set only `dimensions`.

/**
 * Soft registry validation of the dimensions referenced by a set of entry
 * lines (dev_docs/dimensions_implementation_plan.md, PR3). Called from
 * createDraftEntry/updateDraftEntry after balance validation and before any
 * insert, so a rejection leaves no orphan rows.
 *
 * Semantics:
 *  1. Untagged entries are free: if no line carries a dimension, the function
 *     returns without touching the database at all.
 *  2. Companies without company_settings.dimensions_enabled keep the historic
 *     free-text passthrough: existing API/MCP writers are unaffected. This is
 *     the ONE place the toggle is load-bearing beyond UI visibility.
 *  3. Enabled companies get referential validation against the registry: a
 *     dimension number with no `dimensions` row, a code with no
 *     `dimension_values` row, or an archived (is_active = false) value rejects
 *     the whole entry with a DimensionValidationError whose Swedish message
 *     names every offending code.
 *
 * Cost: at most three queries per entry (settings, dimensions,
 * dimension_values) regardless of line count: never per-line lookups.
 *
 * Failure posture: query errors fail OPEN (validation is skipped). This is
 * soft validation: a transient DB error must not block bookkeeping, and the
 * write that follows hits the same database anyway. Reversal/storno/correction
 * paths intentionally bypass this function: they copy posted data verbatim
 * (BFL 5 kap 5§ requires the storno to mirror the original even if a value
 * has since been archived).
 */
export async function validateEntryDimensions(
  supabase: SupabaseClient,
  companyId: string,
  lines: DimensionAliasInput[]
): Promise<void> {
  // 1. Union of normalized dimension maps across all lines.
  const union = new Map<string, Set<string>>()
  for (const line of lines) {
    for (const [dimNo, code] of Object.entries(normalizeLineDimensions(line))) {
      const codes = union.get(dimNo) ?? new Set<string>()
      codes.add(code)
      union.set(dimNo, codes)
    }
  }
  if (union.size === 0) return

  // 2. Toggle gate: fetched once. Missing row/column or a query error means
  //    passthrough (fail-open, same posture as resolveSeriesFromSettings).
  const { data: settings, error: settingsError } = await supabase
    .from('company_settings')
    .select('dimensions_enabled')
    .eq('company_id', companyId)
    .maybeSingle()

  const enabled = (settings as { dimensions_enabled?: boolean } | null)?.dimensions_enabled
  if (settingsError || !enabled) return

  // 3a. Registry rows for every referenced dimension number: one query.
  const { data: dimRows, error: dimError } = await supabase
    .from('dimensions')
    .select('id, sie_dim_no')
    .eq('company_id', companyId)
    .in('sie_dim_no', [...union.keys()].map(Number))

  if (dimError) return

  const dimIdByNo = new Map<string, string>()
  for (const row of (dimRows ?? []) as { id: string; sie_dim_no: number }[]) {
    dimIdByNo.set(String(row.sie_dim_no), row.id)
  }

  const issues: DimensionValidationIssue[] = []
  const knownDimIds: string[] = []
  for (const dimNo of union.keys()) {
    const dimId = dimIdByNo.get(dimNo)
    if (dimId) knownDimIds.push(dimId)
    else issues.push({ sie_dim_no: dimNo, code: null, reason: 'unknown_dimension' })
  }

  // 3b. Value rows for every referenced (dimension, code) pair: one query.
  //     Filtering by the code union may return a same-named code under another
  //     referenced dimension; lookups below key on (dimension_id, code) so
  //     that cannot cause a false pass.
  if (knownDimIds.length > 0) {
    const allCodes = [...new Set([...union.values()].flatMap((codes) => [...codes]))]
    const { data: valueRows, error: valueError } = await supabase
      .from('dimension_values')
      .select('dimension_id, code, is_active')
      .eq('company_id', companyId)
      .in('dimension_id', knownDimIds)
      .in('code', allCodes)

    if (valueError) return

    // NUL-escape-separated composite key: a NUL can never occur in a Postgres
    // text value, so (dimension_id, code) pairs stay unambiguous for any code.
    const activeByKey = new Map<string, boolean>()
    for (const row of (valueRows ?? []) as {
      dimension_id: string
      code: string
      is_active: boolean
    }[]) {
      activeByKey.set(`${row.dimension_id}\u0000${row.code}`, row.is_active)
    }

    for (const [dimNo, codes] of union) {
      const dimId = dimIdByNo.get(dimNo)
      if (!dimId) continue
      for (const code of codes) {
        const isActive = activeByKey.get(`${dimId}\u0000${code}`)
        if (isActive === undefined) {
          issues.push({ sie_dim_no: dimNo, code, reason: 'unknown_value' })
        } else if (!isActive) {
          issues.push({ sie_dim_no: dimNo, code, reason: 'archived_value' })
        }
      }
    }
  }

  if (issues.length > 0) {
    throw new DimensionValidationError(issues)
  }
}
