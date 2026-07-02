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

/** SIE dimension numbers with first-class mirror columns. */
export const DIM_COST_CENTER = '1'
export const DIM_PROJECT = '6'

export type LineDimensions = Record<string, string>

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
      const trimmed = typeof value === 'string' ? value.trim() : ''
      if (!trimmed) {
        // Explicit empty string in the bag means "clear this dimension" — it
        // must also override a non-empty alias, so remove any alias-filled key.
        delete out[key]
        continue
      }
      out[key] = trimmed
    }
  }

  return out
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
