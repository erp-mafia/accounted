/**
 * Voucher series resolver — pure helpers for mapping journal_entries.source_type
 * to a default voucher_series per company_settings, formatting voucher labels
 * for display, and parsing them back.
 *
 * Source-type → series mapping lives in
 *   company_settings.default_voucher_series_per_source_type (JSONB).
 *
 * Defaults to 'A' when:
 *   - the settings row is null/undefined
 *   - the JSONB is missing the source_type key
 *   - the configured value is not a single uppercase letter A–Z
 *
 * These functions are pure; no I/O. Engine call-sites read the settings row
 * once and pass it in.
 */
import type { JournalEntrySourceType } from '@/types'

export type VoucherSeriesMap = Partial<Record<JournalEntrySourceType, string>> &
  Record<string, string>

const SERIES_LETTER_RE = /^[A-Z]$/

/**
 * Resolve the default voucher_series letter for a given source_type from a
 * company_settings row. Returns 'A' as a safe fallback when no mapping is
 * configured for that source_type.
 *
 * @param settings - Either a full CompanySettings row or just the per-source
 *                   map. `null`/`undefined` is allowed (returns 'A').
 * @param sourceType - The journal_entries.source_type value.
 */
export function resolveDefaultSeriesForSource(
  settings:
    | { default_voucher_series_per_source_type?: VoucherSeriesMap | null }
    | VoucherSeriesMap
    | null
    | undefined,
  sourceType: JournalEntrySourceType,
): string {
  if (!settings) return 'A'

  // Accept both the full settings row and a bare map. Both shapes are
  // narrowed via duck-typing on the column key — when present, treat it as
  // the settings row; otherwise treat the argument itself as the map.
  const raw = settings as {
    default_voucher_series_per_source_type?: VoucherSeriesMap | null
  } & VoucherSeriesMap
  const mapCandidate =
    raw.default_voucher_series_per_source_type !== undefined
      ? raw.default_voucher_series_per_source_type
      : (settings as VoucherSeriesMap)

  if (!mapCandidate || typeof mapCandidate !== 'object') return 'A'

  const value = (mapCandidate as VoucherSeriesMap)[sourceType]
  if (typeof value === 'string' && SERIES_LETTER_RE.test(value)) {
    return value
  }
  return 'A'
}

/**
 * Format a voucher (series + number) for UI display. Returns "—" when the
 * voucher number is null (e.g. a draft entry that has not been committed yet).
 *
 * Always lifts the series to uppercase. Falls back to 'A' when the series is
 * null/empty for forward-compat with legacy rows. Accepts partial inputs so
 * callsites can pass through API responses without re-shaping them.
 */
export function formatVoucher(entry: {
  voucher_series?: string | null
  voucher_number?: number | null
}): string {
  if (entry.voucher_number == null || entry.voucher_number === 0) {
    return '—'
  }
  const series =
    entry.voucher_series && typeof entry.voucher_series === 'string'
      ? entry.voucher_series.toUpperCase()
      : 'A'
  return `${series}${entry.voucher_number}`
}

/**
 * Parse a formatted voucher label back into its parts. Returns null when the
 * input does not match the expected shape (single uppercase letter followed
 * by a positive integer). Use for filter inputs / search.
 */
export function parseVoucher(
  formatted: string,
): { series: string; number: number } | null {
  if (typeof formatted !== 'string') return null
  const trimmed = formatted.trim().toUpperCase()
  const match = trimmed.match(/^([A-Z])(\d+)$/)
  if (!match) return null
  const number = parseInt(match[2], 10)
  if (!Number.isFinite(number) || number <= 0) return null
  return { series: match[1], number }
}
