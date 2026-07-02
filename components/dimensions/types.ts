/**
 * Client-side contract types for the dimensions registry API (PR2 of
 * dev_docs/dimensions_implementation_plan.md).
 *
 * The routes live under /api/dimensions and are built against the same locked
 * contract — this module codes against the contract, not the route files, so
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
  /** SIE #DIM number (1 = Kostnadsställe, 6 = Projekt). */
  sie_dim_no: number
  name: string
  resets_annually: boolean
  is_system: boolean
  is_active: boolean
  sort_order: number
  /** Sorted by code by the API. */
  values: DimensionValueDto[]
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
