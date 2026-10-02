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
   * null when the user kept every company at full access: the key stays
   * unrestricted and follows future memberships (no api_key_companies rows
   * are written). Otherwise the selected companies, in picker order. A
   * selection with any read-only company is always a list: the level lives
   * on the allowlist row, so an unrestricted key cannot carry one.
   */
  companyIds: string[] | null
  /**
   * Selected companies where the key may only read (api_key_companies.access
   * = 'read'), in picker order; null when there are none. Always a subset of
   * `companyIds`, and never set while `companyIds` is null.
   */
  readOnlyCompanyIds: string[] | null
  /**
   * The company the key is bound to by default: the active company when it
   * is part of the selection, otherwise the first selected company in picker
   * order. Always inside `companyIds` when that is non-null.
   */
  defaultCompanyId: string
}

function uuidSet(values: unknown[]): Set<string> {
  const ids = new Set<string>()
  for (const value of values) {
    if (isUuid(value)) ids.add(value.toLowerCase())
  }
  return ids
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
 *
 * `submittedReadOnly` names the selected companies the key may only read in.
 * Ids that are not also in `submitted` are ignored here: callers that must
 * refuse such input check it before calling.
 */
export function resolveCompanySelection(
  submitted: unknown[],
  memberships: PickerCompany[],
  activeCompanyId: string | null,
  submittedReadOnly: unknown[] = [],
): CompanySelection | null {
  const ticked = uuidSet(submitted)
  const selected = memberships.filter((company) => ticked.has(company.company_id.toLowerCase()))
  if (selected.length === 0) return null

  const readOnlyTicked = uuidSet(submittedReadOnly)
  const readOnlyIds = selected
    .filter((company) => readOnlyTicked.has(company.company_id.toLowerCase()))
    .map((company) => company.company_id)
  const unrestricted = selected.length === memberships.length && readOnlyIds.length === 0
  const selectedIds = selected.map((company) => company.company_id)
  const defaultCompanyId =
    activeCompanyId && selectedIds.includes(activeCompanyId) ? activeCompanyId : selectedIds[0]

  return {
    companyIds: unrestricted ? null : selectedIds,
    readOnlyCompanyIds: readOnlyIds.length > 0 ? readOnlyIds : null,
    defaultCompanyId,
  }
}

/** What a connection may do in one company, as the consent page offers it. */
export type CompanyAccessChoice = 'write' | 'read' | 'none'

const ACCESS_RANK: Record<CompanyAccessChoice, number> = { none: 0, read: 1, write: 2 }

/**
 * Parse the consent page's per-company access fields. Each value is
 * `<company id>:<write|read|none>`; anything else is dropped. When a company
 * appears more than once (only a tampered form does that) the most
 * restrictive choice wins, so a duplicate can never widen a grant. The
 * result feeds resolveCompanySelection: `companyIds` holds every company
 * chosen as read or write, `readOnlyCompanyIds` the ones chosen as read.
 * Membership is not checked here; resolveCompanySelection does that.
 */
export function parseCompanyAccessChoices(values: unknown[]): {
  companyIds: string[]
  readOnlyCompanyIds: string[]
} {
  const choices = new Map<string, CompanyAccessChoice>()
  for (const value of values) {
    if (typeof value !== 'string') continue
    const separator = value.lastIndexOf(':')
    if (separator <= 0) continue
    const companyId = value.slice(0, separator).toLowerCase()
    const choice = value.slice(separator + 1)
    if (!isUuid(companyId)) continue
    if (choice !== 'write' && choice !== 'read' && choice !== 'none') continue
    const previous = choices.get(companyId)
    if (previous === undefined || ACCESS_RANK[choice] < ACCESS_RANK[previous]) {
      choices.set(companyId, choice)
    }
  }
  const companyIds: string[] = []
  const readOnlyCompanyIds: string[] = []
  for (const [companyId, choice] of choices) {
    if (choice === 'none') continue
    companyIds.push(companyId)
    if (choice === 'read') readOnlyCompanyIds.push(companyId)
  }
  return { companyIds, readOnlyCompanyIds }
}
