/**
 * DimensionValidationError: the typed rejection of validateEntryDimensions()
 * (lib/bookkeeping/dimension-resolver.ts).
 *
 * Lives in its own module instead of ./errors.ts for one reason only:
 * dimension-resolver.ts is reachable from client bundles (lib/api/schemas.ts
 * imports DimensionsBagSchema and is itself imported by "use client"
 * components such as InvoiceEditor), while ./errors.ts imports next/server:
 * a server-only module graph (AsyncLocalStorage internals) that must never
 * enter a client bundle. This module stays dependency-free.
 *
 * ./errors.ts re-exports everything here, wires the class into
 * isBookkeepingError() and bookkeepingErrorResponse(), and remains the single
 * import surface for server code:
 *
 *   import { DimensionValidationError } from '@/lib/bookkeeping/errors'
 *
 * The class follows the ./errors.ts conventions: stable `code` const, `name`
 * set to the class name, structured data on public readonly fields so the
 * HTTP layer can attach machine-readable details. The message is user-facing
 * Swedish (stays-Swedish bookkeeping surface, mirroring
 * accountsNotInChartResponse) and names every offending code so a user or
 * agent can self-correct in one pass.
 */

export const DIMENSION_VALIDATION_FAILED = 'DIMENSION_VALIDATION_FAILED' as const

export type DimensionValidationReason =
  /** The line references a SIE dimension number with no registry row. */
  | 'unknown_dimension'
  /** The dimension exists but the code has no dimension_values row. */
  | 'unknown_value'
  /** The value exists but is archived (is_active = false). */
  | 'archived_value'

export interface DimensionValidationIssue {
  /** SIE dimension number as keyed in the line bag, e.g. '1' or '6'. */
  sie_dim_no: string
  /** Offending object code; null when the dimension number itself is unknown. */
  code: string | null
  reason: DimensionValidationReason
}

/** Swedish user-facing sentence for a single validation issue. */
export function formatDimensionValidationIssue(issue: DimensionValidationIssue): string {
  switch (issue.reason) {
    case 'unknown_dimension':
      return `Okänd dimension ${issue.sie_dim_no}. Skapa dimensionen i registret först.`
    case 'archived_value':
      return `"${issue.code}" är arkiverat: återaktivera värdet för att använda det.`
    case 'unknown_value':
      return `Okänt kostnadsställe/projekt: "${issue.code}" (dimension ${issue.sie_dim_no}). Skapa värdet i registret först.`
  }
}

function isDimensionValidationIssue(value: unknown): value is DimensionValidationIssue {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (typeof v.sie_dim_no !== 'string') return false
  if (v.reason === 'unknown_dimension') return true
  return (
    (v.reason === 'unknown_value' || v.reason === 'archived_value') && typeof v.code === 'string'
  )
}

/**
 * Format an untyped issues array (e.g. `details.issues` from a serialized API
 * error envelope) into the Swedish message. Returns null unless `raw` is a
 * non-empty array of well-formed issues: callers fall back to their generic
 * message. Used by lib/errors/get-error-message.ts so the toast reconstructs
 * the exact per-code sentences instead of the static registry fallback.
 */
export function formatDimensionValidationIssues(raw: unknown): string | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const issues = raw.filter(isDimensionValidationIssue)
  if (issues.length === 0) return null
  return issues.map(formatDimensionValidationIssue).join(' ')
}

/**
 * Raised by validateEntryDimensions() when a company with
 * company_settings.dimensions_enabled = true tags a line with a dimension
 * number that has no registry row, a code with no dimension_values row, or an
 * archived value. Companies without the toggle keep free-text passthrough
 * (backward compatible with every existing API/MCP writer), and untagged
 * entries never reach this validation at all.
 */
export class DimensionValidationError extends Error {
  readonly code = DIMENSION_VALIDATION_FAILED

  constructor(public readonly issues: DimensionValidationIssue[]) {
    super(issues.map(formatDimensionValidationIssue).join(' '))
    this.name = 'DimensionValidationError'
  }
}

export function isDimensionValidationError(err: unknown): err is DimensionValidationError {
  return err instanceof DimensionValidationError
}

// ============================================================================
// Mandatory dimension enforcement (dimensions PR10)
// ============================================================================

export const MANDATORY_DIMENSION_MISSING = 'MANDATORY_DIMENSION_MISSING' as const

export interface MandatoryDimensionViolation {
  account_number: string
  /** SIE dimension number the rule requires, e.g. '6'. */
  sie_dim_no: string
  /** Registry display name for the dimension, e.g. 'Projekt'. */
  dimension_name: string
}

/** Swedish user-facing sentence for a single missing-dimension violation. */
export function formatMandatoryDimensionViolation(v: MandatoryDimensionViolation): string {
  return `Konto ${v.account_number} kräver ${v.dimension_name} — välj ett värde innan bokföring.`
}

/**
 * Raised at COMMIT time (commitEntry / the bulk-book pre-check) when an
 * active 'required' rule in account_dimension_rules is unsatisfied by a
 * line's dimensions bag. Drafts may be incomplete by design — the rule bites
 * when the verifikat is about to become immutable. Companies without rules
 * (every company by default) never reach this error.
 */
export class MandatoryDimensionMissingError extends Error {
  readonly code = MANDATORY_DIMENSION_MISSING

  constructor(public readonly violations: MandatoryDimensionViolation[]) {
    super(violations.map(formatMandatoryDimensionViolation).join(' '))
    this.name = 'MandatoryDimensionMissingError'
  }
}

export function isMandatoryDimensionMissingError(
  err: unknown,
): err is MandatoryDimensionMissingError {
  return err instanceof MandatoryDimensionMissingError
}
