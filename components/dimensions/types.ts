/**
 * Client-side contract types for the dimensions registry API (PR2 of
 * dev_docs/dimensions_implementation_plan.md).
 *
 * The routes live under /api/dimensions and are built against the same locked
 * contract: this module codes against the contract, not the route files, so
 * the register UI (DimensionsManager) and the shared picker (DimensionCombobox)
 * can ship independently of the API package.
 */

export interface DimensionValueDto {
  id: string
  code: string
  name: string
  is_active: boolean
  start_date: string | null
  end_date: string | null
}

export interface DimensionDto {
  id: string
  /** SIE #DIM number (1 = Kostnadsställe, 6 = Projekt, 20+ = custom). */
  sie_dim_no: number
  name: string
  resets_annually: boolean
  is_system: boolean
  is_active: boolean
  sort_order: number
  /** SIE #UNDERDIM parent — the sie_dim_no of the parent dimension, or null. */
  parent_sie_dim_no: number | null
  /** Sorted by code by the API. */
  values: DimensionValueDto[]
}

export type DimensionRuleType = 'required' | 'default' | 'fixed'

/**
 * Per-account dimension rule as served by GET /api/dimensions/rules —
 * a flattened join row (rule + dimension + optional pinned value).
 */
export interface AccountDimensionRuleDto {
  account_dimension_rule_id: string
  account_number: string
  dimension_id: string
  sie_dim_no: number
  dimension_name: string
  rule_type: DimensionRuleType
  value_id: string | null
  value_code: string | null
  value_name: string | null
  is_active: boolean
}

/** SIE dimension number whose values carry start/end dates (Projekt). */
export const PROJECT_DIM_NO = 6

/**
 * Strict Fortnox-compatible code format enforced by the API for user-created
 * codes (the DB CHECK is deliberately looser so legacy free-text survives the
 * backfill). Mirrored client-side for inline validation before POST.
 */
export const DIMENSION_CODE_PATTERN = /^[A-Za-z0-9ÅÄÖåäö_+\-]{1,20}$/

/**
 * Load the company's dimension registry. The handler lazily seeds system dims
 * 1/6 via ensure_company_dimensions, so the result always contains at least
 * Kostnadsställe + Projekt. Throws the parsed error envelope on failure so
 * callers can hand it straight to getErrorMessage().
 */
export async function fetchDimensions(): Promise<DimensionDto[]> {
  const res = await fetch('/api/dimensions')
  const json = await res.json().catch(() => null)
  if (!res.ok) {
    throw json ?? new Error('Failed to load dimensions')
  }
  return (json?.dimensions ?? []) as DimensionDto[]
}

let cachedDimensionsPromise: Promise<DimensionDto[]> | null = null

/**
 * Module-level cached variant of fetchDimensions for high-mount-count
 * consumers (one registry fetch per page load instead of one per line
 * picker). A failed fetch clears the cache so the next mount retries.
 * Registry mutations are rare enough that staleness within a page visit
 * is acceptable — the register UI uses the uncached fetch.
 */
export function fetchDimensionsCached(): Promise<DimensionDto[]> {
  if (!cachedDimensionsPromise) {
    cachedDimensionsPromise = fetchDimensions().catch((err) => {
      cachedDimensionsPromise = null
      throw err
    })
  }
  return cachedDimensionsPromise
}
