import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { getUserCompanies } from '@/lib/company/context'
import { isUuid } from '@/lib/invariants/uuid'

/**
 * One row of the company picker shown wherever a user narrows what a key or
 * a consent may reach: the OAuth consent page and the API-key settings.
 */
export interface PickerCompany {
  company_id: string
  /** Display name: company_settings.company_name, falling back to companies.name. */
  name: string
  /** The caller's role in that company (company_members.role). */
  role: string
}

type MembershipRow = {
  company_id: string
  role: string | null
  companies:
    | { id: string; name: string; archived_at: string | null }
    | Array<{ id: string; name: string; archived_at: string | null }>
    | null
}

/**
 * Every non-archived company the user belongs to, with the display name the
 * rest of the app shows (mirrors listAccessibleCompanies in the MCP server).
 *
 * Order is the membership order (stable), except that `activeCompanyId`,
 * when given and present, is moved first: the pickers render the active
 * company on top and use "first" as the default when the active one is
 * unticked.
 *
 * Errors propagate: the callers use this list to validate what a form
 * submitted, and an empty list on a transient failure would read as "no
 * memberships" and fail every selection, so they decide how to fail closed.
 */
export async function listUserCompaniesForPicker(
  supabase: SupabaseClient,
  userId: string,
  options: { activeCompanyId?: string | null } = {},
): Promise<PickerCompany[]> {
  const memberships = (await getUserCompanies(supabase, userId)) as unknown as MembershipRow[]

  const accessible = memberships.flatMap((membership) => {
    const company = Array.isArray(membership.companies)
      ? membership.companies[0]
      : membership.companies
    if (!company || company.archived_at !== null) return []
    return [{ company_id: company.id, name: company.name, role: membership.role ?? '' }]
  })
  if (accessible.length === 0) return []

  const displayNames = new Map<string, string>()
  const settings = await fetchAllRows<{ company_id: string; company_name: string | null }>(
    ({ from, to }) =>
      supabase
        .from('company_settings')
        .select('company_id, company_name')
        .in(
          'company_id',
          accessible.map((company) => company.company_id),
        )
        .order('company_id', { ascending: true })
        .range(from, to),
  )
  for (const row of settings) {
    if (row.company_name) displayNames.set(row.company_id, row.company_name)
  }

  const named = accessible.map((company) => ({
    ...company,
    name: displayNames.get(company.company_id) ?? company.name,
  }))

  const activeId = options.activeCompanyId ?? null
  if (!activeId) return named
  const activeIndex = named.findIndex((company) => company.company_id === activeId)
  if (activeIndex <= 0) return named
  const [active] = named.splice(activeIndex, 1)
  return [active, ...named]
}

export interface CompanySelection {
  /**
   * null when the user kept every company: the key stays unrestricted and
   * follows future memberships (no api_key_companies rows are written).
   * Otherwise the strict subset, in picker order.
   */
  companyIds: string[] | null
  /**
   * The company the key is bound to by default: the active company when it
   * is part of the selection, otherwise the first selected company in picker
   * order. Always inside `companyIds` when that is non-null.
   */
  defaultCompanyId: string
}

/**
 * Turn what a form or JSON body submitted into a validated selection.
 *
 * Never trusts the input: ids that are not UUID-shaped or not among the
 * user's live memberships are dropped, duplicates collapse, and the result is
 * ordered by the picker (`memberships`), not by the submission. Returns null
 * when nothing valid remains (the caller answers 400).
 *
 * `activeCompanyId` is the company the caller was working in; it becomes the
 * default when selected. Pass null when there is none.
 */
export function resolveCompanySelection(
  submitted: unknown[],
  memberships: PickerCompany[],
  activeCompanyId: string | null,
): CompanySelection | null {
  const ticked = new Set<string>()
  for (const value of submitted) {
    if (isUuid(value)) ticked.add(value.toLowerCase())
  }
  const selected = memberships.filter((company) => ticked.has(company.company_id.toLowerCase()))
  if (selected.length === 0) return null

  const unrestricted = selected.length === memberships.length
  const selectedIds = selected.map((company) => company.company_id)
  const defaultCompanyId =
    activeCompanyId && selectedIds.includes(activeCompanyId) ? activeCompanyId : selectedIds[0]

  return {
    companyIds: unrestricted ? null : selectedIds,
    defaultCompanyId,
  }
}
