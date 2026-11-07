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

/**
 * The review step's sentence about rows it cannot import: how many, and the
 * first problem with its line in the file. The parser's errors name the column
 * and the value, so a wrong column reads as one on the page instead of behind
 * a hover on every red row (PH 204). Null when every row is valid.
 */
export function invalidRowsNoticeParams(
  rows: readonly { is_valid: boolean; validation_errors: readonly string[]; row_index?: number }[],
): { count: number; row: number; error: string } | null {
  const invalid = rows.filter((r) => !r.is_valid)
  if (invalid.length === 0) return null
  const first = invalid[0]
  return {
    count: invalid.length,
    // The header is line 1, so the first data row is line 2.
    row: first.row_index ?? rows.indexOf(first) + 2,
    error: first.validation_errors[0] ?? '',
  }
}

/**
 * Rows per execute request, by count and by size. The hosted platform
 * refuses a request body over 4.5 MB before the route runs; 3 MB leaves room
 * for the envelope. 10 000 rows keeps each request's own work (the existing
 * rows it reads, the rows it writes) well inside the route's maxDuration.
 */
export const EXECUTE_BATCH_MAX_ROWS = 10_000
export const EXECUTE_BATCH_MAX_BYTES = 3 * 1024 * 1024

/**
 * The execute rows in request-sized batches, in file order. A file that fits
 * one request is one batch, so a normal import sends exactly what it always
 * did; a supplier price list (crm#1383) goes in as many as it needs.
 */
export function executeBatches<R>(
  rows: readonly R[],
  maxRows: number = EXECUTE_BATCH_MAX_ROWS,
  maxBytes: number = EXECUTE_BATCH_MAX_BYTES,
): R[][] {
  const encoder = new TextEncoder()
  const batches: R[][] = []
  let current: R[] = []
  let bytes = 0
  for (const row of rows) {
    // +1 for the comma between array elements.
    const size = encoder.encode(JSON.stringify(row)).length + 1
    if (current.length > 0 && (current.length >= maxRows || bytes + size > maxBytes)) {
      batches.push(current)
      current = []
      bytes = 0
    }
    current.push(row)
    bytes += size
  }
  if (current.length > 0) batches.push(current)
  return batches
}

/** What one execute request answers (lib/import/<register>/types.ts). */
export interface ExecuteBatchResult {
  success: boolean
  created: number
  updated: number
  skipped: number
  failed: number
  errors: { row_index: number; name: string; reason: string }[]
  warnings?: string[]
  notices?: unknown[]
}

/** Error rows the result keeps: the count stays exact, the list stays readable. */
export const MERGED_ERRORS_SHOWN = 200

/**
 * The batches' answers as one: counts add up, the first MERGED_ERRORS_SHOWN
 * error rows are kept, and a warning or notice that every batch repeats (the
 * same dropped account, say) appears once.
 */
export function mergeExecuteResults<T extends ExecuteBatchResult>(results: readonly T[]): T {
  const [first, ...rest] = results
  const merged = {
    ...first,
    errors: [...first.errors],
    warnings: first.warnings ? [...first.warnings] : undefined,
    notices: first.notices ? [...first.notices] : undefined,
  } as T
  const seenNotices = new Set((merged.notices ?? []).map((n) => JSON.stringify(n)))
  for (const r of rest) {
    merged.created += r.created
    merged.updated += r.updated
    merged.skipped += r.skipped
    merged.failed += r.failed
    merged.success = merged.success && r.success
    merged.errors.push(...r.errors)
    for (const w of r.warnings ?? []) {
      if (!merged.warnings) merged.warnings = []
      if (!merged.warnings.includes(w)) merged.warnings.push(w)
    }
    for (const n of r.notices ?? []) {
      const key = JSON.stringify(n)
      if (seenNotices.has(key)) continue
      seenNotices.add(key)
      if (!merged.notices) merged.notices = []
      merged.notices.push(n)
    }
  }
  merged.errors = merged.errors.slice(0, MERGED_ERRORS_SHOWN)
  return merged
}

/** Rows the review table draws: beyond this a file is reviewed by its counts. */
export const REVIEW_ROWS_SHOWN = 500

/**
 * The rows the review table draws. A file up to REVIEW_ROWS_SHOWN rows is
 * drawn whole, as before. A larger one draws its invalid rows first (they
 * block the import and must stay reachable to fix or remove), then the
 * first rows of the file, up to REVIEW_ROWS_SHOWN; every row is still
 * imported. Drawing 165 000 editable rows froze the tab (crm#1383).
 */
export function reviewRowsToRender<R extends { is_valid: boolean }>(
  rows: readonly R[],
  limit: number = REVIEW_ROWS_SHOWN,
): readonly R[] {
  if (rows.length <= limit) return rows
  const invalid = rows.filter((r) => !r.is_valid)
  if (invalid.length >= limit) return invalid.slice(0, limit)
  const out = [...invalid]
  for (const r of rows) {
    if (out.length >= limit) break
    if (r.is_valid) out.push(r)
  }
  return out
}
