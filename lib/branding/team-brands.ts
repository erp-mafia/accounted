/**
 * Batched brand lookup per team, for the home-domain rule (WL-01).
 *
 * The dashboard layout needs "does team X have a brand, and on which domain"
 * for every company the user belongs to, in one round trip: looping
 * resolveBrandForCompany would cost 2 queries per company on a cold cache.
 * Like lib/branding/resolve.ts this uses the cookieless service client and
 * bypasses RLS BY DESIGN: an end client (Kalle) is not a member of the byrå
 * team, so RLS would hide the brand row he needs for his "hanteras via
 * app.siffra.se" signpost. Only domain + app name leave this module: no
 * email identity or color config is exposed to that path.
 *
 * Results are cached in-memory per team id with the same ~60s TTL as the
 * resolvers; ops-assisted onboarding tolerates that staleness.
 */

import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import type { TeamBrandRef } from '@/lib/company/home-domain'

const CACHE_TTL_MS = 60_000

interface CacheEntry {
  value: TeamBrandRef | null
  expiresAt: number
}

const cache = new Map<string, CacheEntry>()

/**
 * Resolve brands for a set of team ids. Returns a map containing ONLY teams
 * that have a brand; brandless teams are absent (and negatively cached).
 * On a transient query failure the uncached teams resolve as brandless for
 * this call, without poisoning the cache: the canonical appearance is the
 * safe fallback (the additive guarantee).
 */
export async function resolveBrandsForTeams(
  teamIds: Array<string | null | undefined>,
): Promise<Map<string, TeamBrandRef>> {
  const now = Date.now()
  const result = new Map<string, TeamBrandRef>()
  const misses: string[] = []

  const unique = [...new Set(teamIds.filter((id): id is string => !!id))]
  for (const teamId of unique) {
    const entry = cache.get(teamId)
    if (entry && entry.expiresAt > now) {
      if (entry.value) result.set(teamId, entry.value)
      continue
    }
    misses.push(teamId)
  }

  if (misses.length === 0) return result

  const supabase = createServiceClientNoCookies()
  const { data, error } = await supabase
    .from('brands')
    .select('team_id, domain, app_name')
    .in('team_id', misses)

  if (error) {
    // Transient failure: treat the misses as brandless for this call only.
    return result
  }

  const found = new Map<string, TeamBrandRef>()
  for (const row of (data ?? []) as Array<{
    team_id: string
    domain: string
    app_name: string
  }>) {
    found.set(row.team_id, { domain: row.domain, appName: row.app_name })
  }

  const expiresAt = Date.now() + CACHE_TTL_MS
  for (const teamId of misses) {
    const value = found.get(teamId) ?? null
    cache.set(teamId, { value, expiresAt })
    if (value) result.set(teamId, value)
  }

  return result
}
