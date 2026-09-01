/**
 * Voucher series resolver: pure helpers for mapping journal_entries.source_type
 * to a default voucher_series per company_settings, formatting voucher labels
 * for display, and parsing them back.
 *
 * Source-type → series mapping lives in
 *   company_settings.default_voucher_series_per_source_type (JSONB).
 *
 * Defaults to 'A' when:
 *   - the settings row is null/undefined
 *   - the JSONB is missing the source_type key
 *   - the configured value is not a single uppercase letter A-Z
 *
 * These functions are pure; no I/O. Engine call-sites read the settings row
 * once and pass it in.
 */
import type { JournalEntrySourceType } from '@/types'

export type VoucherSeriesMap = Partial<Record<JournalEntrySourceType, string>> &
  Record<string, string>

const SERIES_LETTER_RE = /^[A-Z]$/

/**
 * The conventional Swedish verifikationsserier and what each one is for.
 *
 * The column accepts any A-Z letter, but a free-text field invites typos and
 * lets the same letter mean different things across a company's ledger, so the
 * entry form offers this fixed set (plus whatever series the company has
 * already configured or used).
 *
 * The labels are bookkeeping-domain terms that stay Swedish in both locales,
 * same convention as VoucherSeriesPerSourceTypeForm.
 */
export const VOUCHER_SERIES_PRESETS: ReadonlyArray<{ letter: string; label: string }> = [
  { letter: 'A', label: 'Kundfakturor' },
  { letter: 'B', label: 'Leverantörsfakturor' },
  { letter: 'I', label: 'Inbetalningar' },
  { letter: 'U', label: 'Utbetalningar' },
  { letter: 'L', label: 'Löner' },
  { letter: 'M', label: 'Manuella verifikat' },
]

/** Swedish description for a preset series letter; empty for unknown letters. */
export function voucherSeriesLabel(letter: string): string {
  const match = VOUCHER_SERIES_PRESETS.find((p) => p.letter === letter)
  return match ? match.label : ''
}

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
  // narrowed via duck-typing on the column key: when present, treat it as
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
 * Propagate a change to the global default voucher series across the
 * per-source-type map. Source types that were still following the previous
 * default move to the new default; explicit overrides (values that differ from
 * the previous default) are preserved untouched.
 *
 * The booking engine resolves series from the per-source-type map, not from the
 * global default, so the bookkeeping settings form calls this when the user
 * changes the "Standardserie" dropdown, otherwise that control would be a
 * no-op for bookkeeping. Pure; returns the next map (input is not mutated).
 */
export function applyDefaultSeriesToMap(
  currentMap: VoucherSeriesMap | null | undefined,
  prevDefault: string,
  nextDefault: string,
): VoucherSeriesMap {
  const out: VoucherSeriesMap = {}
  for (const [key, value] of Object.entries(currentMap || {})) {
    out[key] = value === prevDefault ? nextDefault : value
  }
  return out
}

/**
 * Format a voucher (series + number) for UI display. Returns "-" when the
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
    return '-'
  }
  const series =
    entry.voucher_series && typeof entry.voucher_series === 'string'
      ? entry.voucher_series.toUpperCase()
      : 'A'
  return `${series}${entry.voucher_number}`
}

/**
 * Parse a formatted voucher label back into its parts. Returns null when the
 * input does not match the expected shape: a single letter followed by a
 * positive integer, optionally separated by one space or hyphen ("A209",
 * "a 209", "A-209"). Use for filter inputs / search: these are the shapes
 * users type when they look for a voucher by its number.
 */
export function parseVoucher(
  formatted: string,
): { series: string; number: number } | null {
  if (typeof formatted !== 'string') return null
  const trimmed = formatted.trim().toUpperCase()
  const match = trimmed.match(/^([A-Z])[ -]?(\d+)$/)
  if (!match) return null
  const number = parseInt(match[2], 10)
  if (!Number.isFinite(number) || number <= 0) return null
  return { series: match[1], number }
}
