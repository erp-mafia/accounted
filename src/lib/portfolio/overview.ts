/**
 * Cross-company overview ("portfolio"): the byrå cockpit rows computed over
 * a resolved company scope (lib/portfolio/scope.ts) instead of a byrå team,
 * plus filters an agent or integration asks for ("which of my companies
 * have VAT due within 7 days", "who has more than 20 unbooked rows") and a
 * summary line.
 *
 * The per-company numbers come from fetchOverviewRowsForCompanies
 * (lib/clients/fetch-client-overview.ts): same grouped queries, same
 * urgency sort, so the cockpit and the portfolio door never disagree. The
 * filters are pure and unit-tested here.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { CompanyRole, TaxDeadlineType } from '@/types'
import { fetchOverviewRowsForCompanies } from '@/lib/clients/fetch-client-overview'
import type { ClientDeadline, ClientOverviewRow } from '@/lib/clients/aggregate'
import { addDaysIso, todayIsoStockholm } from '@/lib/dates/iso'
import type { ResolvedCompanyScope } from '@/lib/portfolio/scope'

/** The deadline kinds a portfolio filter accepts; the v1 route builds its enum from this. */
export const DEADLINE_KIND_FILTERS = [
  'vat',
  'agi',
  'f_skatt',
  'inkomstdeklaration',
  'arsredovisning',
  'any',
] as const

export type DeadlineKindFilter = (typeof DEADLINE_KIND_FILTERS)[number]

/**
 * Which deadlines.tax_deadline_type values each filter kind covers. `any`
 * is every deadline with a non-null tax_deadline_type (custom deadlines
 * carry null and only count for the kind-less within-days filter).
 */
export const DEADLINE_KIND_TYPES: Record<
  Exclude<DeadlineKindFilter, 'any'>,
  readonly TaxDeadlineType[]
> = {
  vat: ['moms_monthly', 'moms_quarterly', 'moms_yearly', 'oss_quarterly', 'ioss_monthly'],
  agi: ['arbetsgivardeklaration'],
  f_skatt: ['f_skatt', 'skatteinbetalning'],
  inkomstdeklaration: ['inkomstdeklaration_ef', 'inkomstdeklaration_ab'],
  arsredovisning: ['arsredovisning', 'arsstamma'],
}

export interface PortfolioOverviewFilters {
  /** Keep companies with an open deadline of this kind (see DEADLINE_KIND_TYPES). */
  deadlineKind?: DeadlineKindFilter
  /**
   * Keep companies whose (kind-matching, else next) deadline is due on or
   * before today + N days. Overdue deadlines are inside every window.
   */
  deadlineWithinDays?: number
  /** Keep companies with at least this many unbooked transactions. */
  minUnbooked?: number
  /** Keep companies with at least this many unconsumed inbox documents. */
  minInbox?: number
}

export interface PortfolioCompanyRow extends ClientOverviewRow {
  role: CompanyRole
  teamId: string | null
  entityType: string | null
}

export interface PortfolioOverview {
  team: { id: string; name: string } | null
  summary: {
    /** Companies in the resolved scope (before filters). */
    companies: number
    /** Companies left after the filters. */
    matched: number
    unbooked_total: number
    inbox_total: number
    /** Matched companies whose next deadline is overdue. */
    overdue: number
    /** Matched companies whose next deadline is inside the 14-day window. */
    action_needed: number
  }
  /** After filters, urgency-sorted (lib/clients/aggregate sortClientRows). */
  companies: PortfolioCompanyRow[]
}

export function deadlineMatchesKind(
  taxDeadlineType: string | null,
  kind: DeadlineKindFilter,
): boolean {
  if (taxDeadlineType === null) return false
  if (kind === 'any') return true
  return (DEADLINE_KIND_TYPES[kind] as readonly string[]).includes(taxDeadlineType)
}

/**
 * The deadline a filter looks at: the earliest open deadline of the
 * requested kind, or the row's next deadline (any kind, custom included)
 * when no kind was asked for. Falls back to nextDeadline when the row
 * carries no deadline list.
 */
export function pickDeadlineForFilter(
  row: Pick<ClientOverviewRow, 'nextDeadline' | 'deadlines'>,
  kind: DeadlineKindFilter | undefined,
): ClientDeadline | null {
  if (kind === undefined) return row.nextDeadline
  const candidates = row.deadlines ?? (row.nextDeadline ? [row.nextDeadline] : [])
  let earliest: ClientDeadline | null = null
  for (const deadline of candidates) {
    if (!deadlineMatchesKind(deadline.taxDeadlineType, kind)) continue
    if (!earliest || deadline.dueDate < earliest.dueDate) earliest = deadline
  }
  return earliest
}

/**
 * Apply the portfolio filters. Pure: `today` (ISO date) defaults to the
 * Swedish calendar day and is injectable for tests. Row order is preserved,
 * so an urgency-sorted input stays urgency-sorted.
 */
export function applyOverviewFilters(
  rows: PortfolioCompanyRow[],
  filters: PortfolioOverviewFilters,
  today: string = todayIsoStockholm(),
): PortfolioCompanyRow[] {
  const hasDeadlineFilter =
    filters.deadlineKind !== undefined || filters.deadlineWithinDays !== undefined
  const dueOnOrBefore =
    filters.deadlineWithinDays !== undefined
      ? addDaysIso(today, filters.deadlineWithinDays)
      : null

  return rows.filter((row) => {
    if (filters.minUnbooked !== undefined && row.unbookedCount < filters.minUnbooked) return false
    if (filters.minInbox !== undefined && row.inboxCount < filters.minInbox) return false
    if (!hasDeadlineFilter) return true
    const deadline = pickDeadlineForFilter(row, filters.deadlineKind)
    if (!deadline) return false
    if (dueOnOrBefore !== null && deadline.dueDate > dueOnOrBefore) return false
    return true
  })
}

export function summarizeOverview(
  scopeSize: number,
  rows: readonly PortfolioCompanyRow[],
): PortfolioOverview['summary'] {
  let unbookedTotal = 0
  let inboxTotal = 0
  let overdue = 0
  let actionNeeded = 0
  for (const row of rows) {
    unbookedTotal += row.unbookedCount
    inboxTotal += row.inboxCount
    if (row.nextDeadline?.urgency === 'overdue') overdue += 1
    else if (row.nextDeadline?.urgency === 'action_needed') actionNeeded += 1
  }
  return {
    companies: scopeSize,
    matched: rows.length,
    unbooked_total: unbookedTotal,
    inbox_total: inboxTotal,
    overdue,
    action_needed: actionNeeded,
  }
}

/**
 * The overview for a resolved scope. The scope is the authorization
 * boundary (membership-checked in resolveCompanyScope); this function
 * queries exactly the ids it was given.
 */
export async function fetchPortfolioOverview(
  supabase: SupabaseClient,
  scope: ResolvedCompanyScope,
  filters: PortfolioOverviewFilters,
): Promise<PortfolioOverview> {
  if (scope.companies.length === 0) {
    return { team: scope.team, summary: summarizeOverview(0, []), companies: [] }
  }

  const rows = await fetchOverviewRowsForCompanies(
    supabase,
    scope.companies.map((company) => ({
      id: company.companyId,
      name: company.name,
      org_number: company.orgNumber,
    })),
    { includeDeadlines: true },
  )

  const scopeById = new Map(scope.companies.map((company) => [company.companyId, company]))
  const merged: PortfolioCompanyRow[] = rows.flatMap((row) => {
    const scoped = scopeById.get(row.companyId)
    // Every row came from an id in the scope; a miss cannot happen, and if
    // it ever did the row would carry no role to show, so drop it.
    if (!scoped) return []
    return [{ ...row, role: scoped.role, teamId: scoped.teamId, entityType: scoped.entityType }]
  })

  const companies = applyOverviewFilters(merged, filters)
  return {
    team: scope.team,
    summary: summarizeOverview(scope.companies.length, companies),
    companies,
  }
}
