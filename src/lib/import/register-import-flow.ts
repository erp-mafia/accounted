/**
 * The pure steps of the register import wizard (Kunder, Leverantörer,
 * Artiklar): which steps it shows, where it posts, and what it sends. The one
 * flow in components/import/RegisterImportFlow.tsx runs them for every
 * register; what differs per register lives in register-import-config.tsx.
 */
import type { RegisterImportEntity } from './register-import-link'

/** Below this detection confidence the user maps the columns by hand. */
export const COLUMN_MAPPING_CONFIDENCE = 0.8

export type RegisterStep = 'upload' | 'column_mapping' | 'edit' | 'result'

export function needsColumnMapping(detected: { confidence: number }): boolean {
  return detected.confidence < COLUMN_MAPPING_CONFIDENCE
}

export function registerSteps(needsMapping: boolean): RegisterStep[] {
  return needsMapping ? ['upload', 'column_mapping', 'edit', 'result'] : ['upload', 'edit', 'result']
}

export function registerImportEndpoint(entity: RegisterImportEntity, action: 'parse' | 'execute'): string {
  return `/api/import/${entity}/${action}`
}

/** The detected columns as the mapping step's starting choice, one entry per mappable key. */
export function columnsToMapping<K extends string>(
  detected: { readonly [key: string]: unknown },
  keys: readonly K[],
): Record<K, number | null> {
  const out = {} as Record<K, number | null>
  for (const key of keys) {
    const v = detected[key]
    out[key] = typeof v === 'number' ? v : null
  }
  return out
}

/**
 * The mapping the user confirmed, as the parse route's column_overrides: the
 * name column is required, so an unmapped one falls back to the first column.
 */
export function mappingToOverrides<K extends string>(
  mapping: Record<K, number | null>,
): Record<K, number | null> & { name_col: number; confidence: number } {
  const named = mapping as Record<string, number | null>
  return { ...mapping, name_col: named.name_col ?? 0, confidence: 1 }
}

/** Fields the parse route annotates for the review step; the execute route does not take them. */
export const REVIEW_ONLY_FIELDS = ['duplicate_match', 'is_valid', 'validation_errors'] as const

/** The reviewed rows as the execute route's body rows. */
export function rowsForExecute<R extends object>(
  rows: readonly R[],
  extraReviewOnly: readonly string[] = [],
): Record<string, unknown>[] {
  const drop = new Set<string>([...REVIEW_ONLY_FIELDS, ...extraReviewOnly])
  return rows.map((row) =>
    Object.fromEntries(Object.entries(row).filter(([key]) => !drop.has(key))),
  )
}

/** Rows the import will match to an existing record: a detected match or the user's "same" choice. */
export function countMatchedRows(
  rows: readonly { duplicate_match: unknown; confirmed_duplicate_of?: string | null }[],
): number {
  return rows.filter((r) => r.duplicate_match !== null || !!r.confirmed_duplicate_of).length
}
