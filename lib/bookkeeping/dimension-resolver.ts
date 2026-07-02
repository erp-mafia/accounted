/**
 * Dimension resolver — the single place line dimensions are normalized and
 * mirrored (dev_docs/dimensions_implementation_plan.md).
 *
 * Storage model: journal_entry_lines.dimensions is a JSONB map keyed by SIE
 * dimension number ({"1":"KS01","6":"P001"}) and is the single source of
 * truth. The legacy cost_center/project TEXT columns are deterministic mirrors
 * of keys '1'/'6' during the dual-write window (they become GENERATED columns
 * in a later migration). Every journal_entry_lines writer MUST derive the
 * mirror columns via lineDimensionColumns() — never set them independently.
 */

import { z } from 'zod'

/** SIE dimension numbers with first-class mirror columns. */
export const DIM_COST_CENTER = '1'
export const DIM_PROJECT = '6'

export type LineDimensions = Record<string, string>

/**
 * THE schema for a dimensions bag ({sie_dim_no: object_code}) — the single
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

interface DimensionAliasInput {
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
        // Explicit empty string in the bag means "clear this dimension" — it
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
 * params, tool payloads). Delegates to DimensionsBagSchema — the exact schema
 * the API layer uses — so the staged path cannot drift from API validation.
 * Whole-bag semantics: a bag containing ANY invalid entry is rejected
 * (returns undefined) rather than partially salvaged; staged payloads were
 * already schema-validated at staging time, so an invalid entry here means
 * drift or tampering — booking then proceeds without dimensions, which are
 * never load-bearing for validity. Interior normalization
 * (normalizeLineDimensions) stays permissive on charset by design — it must
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
 * Derive the legacy mirror columns from the canonical map. Pure function —
 * divergence between `dimensions` and cost_center/project is impossible as
 * long as every writer goes through this.
 */
export function lineDimensionColumns(dimensions: LineDimensions): {
  cost_center: string | null
  project: string | null
} {
  return {
    cost_center: dimensions[DIM_COST_CENTER] ?? null,
    project: dimensions[DIM_PROJECT] ?? null,
  }
}
