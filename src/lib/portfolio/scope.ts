/**
 * Company scope for "portfolio" reads: one API-key user may belong to many
 * companies (consultant, byrå team member, multi-company owner), and a
 * cross-company read needs a bounded, membership-checked list to run over.
 *
 * The scope is ALWAYS intersected with the caller's non-archived
 * memberships (company_members via getUserCompanies). That intersection is
 * the authorization boundary: the v1 and MCP doors run on the service-role
 * client, where RLS does not apply, so nothing downstream may query a
 * company id that did not come out of here.
 *
 * Selectors:
 *   'all'      every accessible company (default)
 *   'team'     the companies on the caller's byrå team (teams.kind = 'byra');
 *              no byrå team means an empty scope, never an error
 *   string[]   explicit ids, in the given order; anything that is not an
 *              accessible company lands in `unresolved` (callers decide)
 *
 * The result is capped at SCOPE_MAX_COMPANIES. The ids beyond the cap are
 * returned so a caller can call again with an explicit list.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { CompanyRole } from '@/types'
import { getUserCompanies } from '@/lib/company/context'
import { getByraMembership } from '@/lib/clients/fetch-client-overview'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { chunk } from '@/lib/utils'
import { createLogger } from '@/lib/logger'
import {
  capCompanies,
  excludeCompanies,
  pickEmbedded,
  selectExplicitCompanies,
  sortCompaniesByName,
} from '@/lib/portfolio/scope-utils'

const log = createLogger('portfolio/scope')

export type CompanyScopeSelector = 'all' | 'team' | string[]

export interface CompanyScopeInput {
  /** Defaults to 'all'. */
  companies?: CompanyScopeSelector
  /** Company ids removed from the selection (applied after the selector). */
  exclude?: string[]
  /**
   * The key's company allowlist (validateApiKey().allowedCompanyIds), applied
   * right after membership resolution and before any selector: a membership
   * outside it is not accessible for this key, so 'all' and 'team' never
   * include it and an explicit id for it lands in `unresolved`. null or
   * undefined means no allowlist.
   */
  restrictTo?: string[] | null
}

export interface ScopedCompany {
  companyId: string
  /** Display name: company_settings.company_name, else companies.name. */
  name: string
  orgNumber: string | null
  entityType: string | null
  role: CompanyRole
  /** companies.team_id: the team the company hangs on (personal or byrå). */
  teamId: string | null
}

export interface ResolvedCompanyScope {
  /**
   * At most SCOPE_MAX_COMPANIES companies, sorted by name (sv locale) unless
   * explicit ids were given, in which case they keep the given order.
   */
  companies: ScopedCompany[]
  /** True when more companies matched than the cap allows. */
  truncated: boolean
  /** The ids beyond the cap, so a caller can call again with an explicit list. */
  remainingCompanyIds: string[]
  /** Explicit ids that are not an accessible non-archived membership. */
  unresolved: string[]
  /** The caller's byrå team (teams.kind = 'byra'), when they have one. */
  team: { id: string; name: string } | null
}

export const SCOPE_MAX_COMPANIES = 25

/** Max ids per PostgREST .in() filter (mirrors lib/worklist IN_CLAUSE_CHUNK). */
const IN_CLAUSE_CHUNK = 150

interface CompanyEmbed {
  id: string
  name: string
  org_number: string | null
  entity_type: string | null
  archived_at: string | null
  team_id: string | null
}

interface MembershipRow {
  company_id: string
  role: CompanyRole
  companies: CompanyEmbed | CompanyEmbed[] | null
}

/**
 * Current display names: companies.name is written once at onboarding and
 * never updated, so a renamed company would otherwise show its old name
 * (same source the dashboard layout and gnubok_list_companies use). A failed
 * lookup degrades to companies.name with a warning instead of failing the
 * whole scope.
 */
async function fetchDisplayNames(
  supabase: SupabaseClient,
  companyIds: string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  try {
    for (const ids of chunk(companyIds, IN_CLAUSE_CHUNK)) {
      const rows = await fetchAllRows<{ company_id: string; company_name: string | null }>(
        ({ from, to }) =>
          supabase
            .from('company_settings')
            .select('company_id, company_name')
            .in('company_id', ids)
            .order('company_id', { ascending: true })
            .range(from, to),
      )
      for (const row of rows) {
        // Truthiness (not != null) so an empty string falls through to companies.name.
        if (row.company_name) names.set(row.company_id, row.company_name)
      }
    }
  } catch (error) {
    log.warn('portfolio scope display-name lookup failed', {
      error: error instanceof Error ? error.message : 'unknown',
    })
  }
  return names
}

export async function resolveCompanyScope(
  supabase: SupabaseClient,
  userId: string,
  input: CompanyScopeInput,
): Promise<ResolvedCompanyScope> {
  const selector: CompanyScopeSelector = input.companies ?? 'all'

  // 1. Memberships: the authorization boundary for everything that follows.
  //    A key allowlist (restrictTo) narrows it further and never widens it.
  const restrictTo = input.restrictTo
    ? new Set(input.restrictTo.map((id) => id.toLowerCase()))
    : null
  const memberships = (await getUserCompanies(supabase, userId)) as unknown as MembershipRow[]
  const accessible = new Map<string, ScopedCompany>()
  for (const membership of memberships) {
    const company = pickEmbedded(membership.companies)
    if (!company || company.archived_at !== null) continue
    if (restrictTo && !restrictTo.has(company.id.toLowerCase())) continue
    accessible.set(company.id.toLowerCase(), {
      companyId: company.id,
      name: company.name,
      orgNumber: company.org_number ?? null,
      entityType: company.entity_type ?? null,
      role: membership.role,
      teamId: company.team_id ?? null,
    })
  }

  // 2. The caller's byrå team, when they have one. Part of the result on
  // every selector so a caller can tell a "no byrå" empty team scope from
  // a byrå with no client companies.
  const byra = await getByraMembership(supabase, userId)
  const team = byra ? { id: byra.teamId, name: byra.teamName } : null

  // 3. Select.
  let selected: ScopedCompany[]
  let unresolved: string[] = []
  const explicit = Array.isArray(selector)
  if (Array.isArray(selector)) {
    const picked = selectExplicitCompanies(selector, accessible)
    selected = picked.selected
    unresolved = picked.unresolved
  } else if (selector === 'team') {
    selected = byra
      ? [...accessible.values()].filter((company) => company.teamId === byra.teamId)
      : []
  } else {
    selected = [...accessible.values()]
  }

  selected = excludeCompanies(selected, input.exclude)

  // 4. Display names, then the name sort (the sort needs the current name).
  if (selected.length > 0) {
    const displayNames = await fetchDisplayNames(
      supabase,
      selected.map((company) => company.companyId),
    )
    selected = selected.map((company) => {
      const displayName = displayNames.get(company.companyId)
      return displayName ? { ...company, name: displayName } : company
    })
  }
  if (!explicit) selected = sortCompaniesByName(selected)

  // 5. Cap.
  const capped = capCompanies(selected, SCOPE_MAX_COMPANIES)
  return {
    companies: capped.companies,
    truncated: capped.truncated,
    remainingCompanyIds: capped.remainingCompanyIds,
    unresolved,
    team,
  }
}
