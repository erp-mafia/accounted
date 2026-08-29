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

