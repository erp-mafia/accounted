import type { SourceFilter } from '@/components/transactions/transaction-types'

// Per-company key (v2). The v1 key was browser-wide, so an acct:<id> picked
// under one company leaked into every other company in the same browser;
// v2 scopes the memory per company like the FyPicker/JournalEntryList idiom.
export const SOURCE_FILTER_STORAGE_PREFIX = 'Accounted:transaction-source-filter:v2:'

// The retired browser-wide key from #1105. Removed once on read so it does
// not linger in users' storage forever.
const LEGACY_SOURCE_FILTER_STORAGE_KEY = 'Accounted:transaction-source-filter:v1'

// Validates a persisted or URL-provided value. Stale acct:<id> entries
// (account removed or disabled) are handled by resolveEffectiveSourceFilter,
// which falls back to 'all' whenever the id is not among the picker items.
export function isSourceFilter(value: string | null): value is SourceFilter {
  return (
    value === 'all' ||
    value === 'bank' ||
    value === 'bank:other' ||
    value === 'skatteverket' ||
    (value?.startsWith('acct:') ?? false)
  )
}

export function readStoredSourceFilter(companyId: string): SourceFilter {
  try {
    // One-time cleanup of the legacy browser-wide key; v2 ignores its value.
    window.localStorage.removeItem(LEGACY_SOURCE_FILTER_STORAGE_KEY)
    const stored = window.localStorage.getItem(SOURCE_FILTER_STORAGE_PREFIX + companyId)
    if (isSourceFilter(stored)) return stored
  } catch {
    // localStorage may be unavailable. Fall through to the default.
  }
  return 'all'
}

export function writeStoredSourceFilter(companyId: string, next: SourceFilter): void {
  try {
    window.localStorage.setItem(SOURCE_FILTER_STORAGE_PREFIX + companyId, next)
  } catch {
    // localStorage may be unavailable. The in-memory filter still works.
  }
}

// The wanted filter (persisted choice or URL override) applies only while its
// source actually exists among the picker items. While async sources
// (cash accounts, skv rows, transactions) are still loading, or when a source
// went stale (account disabled, skattekonto drained), the page shows 'all';
// the wanted value stays intact so the choice springs back when the source
// reappears. This derivation replaces the old reset-guard effect, which raced
// the loads and permanently reset the in-memory filter on every mount.
export function resolveEffectiveSourceFilter(
  wanted: SourceFilter,
  itemIds: readonly string[],
): SourceFilter {
  if (wanted === 'all') return 'all'
  return itemIds.includes(wanted) ? wanted : 'all'
}
