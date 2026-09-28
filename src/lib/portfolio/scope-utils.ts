/**
 * Pure helpers for company-scope resolution (lib/portfolio/scope.ts).
 *
 * Everything that can be computed without I/O lives here so it is
 * unit-testable: PostgREST embed normalisation, explicit-id selection with
 * order preserved, exclusion, the Swedish-locale name sort and the size cap.
 * The helpers are generic over the row shape so this module has no import
 * from scope.ts (no cycle).
 */

import { isUuid } from '@/lib/invariants/uuid'

/**
 * PostgREST returns a single-row FK embed as an object in practice, while
 * Supabase's generated types describe it as an array. Accept both, like
 * GET /api/v1/companies and gnubok_list_companies do.
 */
export function pickEmbedded<T>(embed: T | T[] | null | undefined): T | null {
  if (!embed) return null
  return Array.isArray(embed) ? (embed[0] ?? null) : embed
}

/** Lower-cased UUID for map lookups; null when the value is not UUID-shaped. */
export function normalizeCompanyId(raw: string): string | null {
  const id = raw.trim()
  return isUuid(id) ? id.toLowerCase() : null
}

/**
 * Explicit selection: keep the caller's order, drop repeats, and report
 * every id that is not an accessible company in `unresolved` (malformed
 * ids included, so a caller can echo them back). Empty fragments from a
 * split such as "a,,b" are skipped silently.
 */
export function selectExplicitCompanies<T extends { companyId: string }>(
  requested: readonly string[],
  accessible: ReadonlyMap<string, T>,
): { selected: T[]; unresolved: string[] } {
  const selected: T[] = []
  const unresolved: string[] = []
  const seen = new Set<string>()
  for (const raw of requested) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    const key = normalizeCompanyId(trimmed) ?? trimmed
    if (seen.has(key)) continue
    seen.add(key)
    const hit = accessible.get(key)
    if (hit) selected.push(hit)
    else unresolved.push(trimmed)
  }
  return { selected, unresolved }
}

/** Remove the excluded ids (case-insensitive on the UUID). */
export function excludeCompanies<T extends { companyId: string }>(
  companies: readonly T[],
  exclude: readonly string[] | undefined,
): T[] {
  if (!exclude || exclude.length === 0) return [...companies]
  const drop = new Set(exclude.map((id) => id.trim().toLowerCase()))
  return companies.filter((c) => !drop.has(c.companyId.toLowerCase()))
}

/** Stable Swedish-locale sort by display name; the id breaks ties. */
export function sortCompaniesByName<T extends { companyId: string; name: string }>(
  companies: readonly T[],
): T[] {
  return [...companies].sort(
    (a, b) => a.name.localeCompare(b.name, 'sv') || a.companyId.localeCompare(b.companyId),
  )
}

export interface CappedCompanies<T> {
  companies: T[]
  truncated: boolean
  remainingCompanyIds: string[]
}

/**
 * Keep the first `max` companies and list the ids beyond the cap, so a
 * caller can continue with an explicit list instead of guessing.
 */
export function capCompanies<T extends { companyId: string }>(
  companies: readonly T[],
  max: number,
): CappedCompanies<T> {
  if (companies.length <= max) {
    return { companies: [...companies], truncated: false, remainingCompanyIds: [] }
  }
  return {
    companies: companies.slice(0, max),
    truncated: true,
    remainingCompanyIds: companies.slice(max).map((c) => c.companyId),
  }
}
