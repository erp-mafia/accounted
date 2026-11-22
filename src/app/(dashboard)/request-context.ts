import 'server-only'

import { cache } from 'react'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import type { User } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { claimsPinned, userFromClaims } from '@/lib/auth/claims'
import { ACTIVE_COMPANY_HEADER, verifyActiveCompany } from '@/lib/auth/active-company-verdict'
import { invoicerPageRedirect } from '@/lib/auth/invoicer-role'
import { getActiveCompanyId } from '@/lib/company/context'
import { ensureSandboxAgentProfile } from '@/lib/sandbox/ensure-agent'
import { loadOpenObligations, type ObligationCode } from '@/lib/modules/obligations'
import type { PackageId } from '@/lib/modules/packages'
import type { FiscalPeriod, Team } from '@/types'

/**
 * Request-local dashboard auth context. React cache shares the Supabase client
 * and auth lookup between the dashboard layout and every nested server page.
 */
export const getDashboardAuthContext = cache(async () => {
  const supabase = await createClient()
  // Local JWT verification first (same pinning + mapping as requireAuth,
  // lib/auth/claims.ts): the proxy already performed the per-request
  // revocation check with getUser() before this layout runs, so a second
  // network round trip to Supabase Auth on every hard load, refresh and
  // router.refresh() bought nothing. getUser() stays as the authoritative
  // fallback when claims are missing, unpinned or unverifiable.
  let user: User | null = null
  // The verified session id, which the proxy's active-company verdict is
  // bound to. Null on the getUser() fallback, where no verified claims exist.
  let sessionId: string | null = null
  if (typeof supabase.auth.getClaims === 'function') {
    try {
      const { data } = await supabase.auth.getClaims()
      if (data?.claims?.sub && claimsPinned(data.claims)) {
        user = userFromClaims(data.claims)
        sessionId = typeof data.claims.session_id === 'string' ? data.claims.session_id : null
      }
    } catch {
      // Fall through to the network check.
    }
  }
  if (!user) {
    const {
      data: { user: fetched },
    } = await supabase.auth.getUser()
    user = fetched
  }

  return { supabase, user, sessionId }
})

/**
 * The active company the proxy resolved for this very request, when it
 * vouched for one (lib/auth/active-company-verdict.ts): GET page requests of
 * a signed-in user with a company. Null otherwise, and then the caller
 * resolves it itself.
 */
async function proxyResolvedCompanyId(userId: string, sessionId: string | null): Promise<string | null> {
  if (!sessionId) return null
  let verdict: string | null
  try {
    verdict = (await headers()).get(ACTIVE_COMPANY_HEADER)
  } catch {
    // Outside a request (a script, a test): there is no verdict.
    return null
  }
  return verifyActiveCompany(verdict, { userId, sessionId })
}

/**
 * Request-local active company resolution. Nested layouts and pages commonly
 * need the same value, so resolving it once removes repeated preference and
 * membership round trips without caching anything across requests. The
 * proxy has usually resolved it a moment earlier for the same request; its
 * signed verdict then replaces the resolve_active_company round trip.
 */
export const getDashboardCompanyId = cache(async () => {
  const { supabase, user, sessionId } = await getDashboardAuthContext()
  if (!user) return null
  return (await proxyResolvedCompanyId(user.id, sessionId)) ?? getActiveCompanyId(supabase, user.id)
})

/**
 * Request-local company memberships of the signed-in user, each with its
 * company row embedded. The layout builds the company switcher and the
 * active company's row and role from them, and getDashboardCompanyRole reads
 * the role from the same rows, so a page asking for it costs no extra query.
 */
export const getDashboardCompanyMemberships = cache(async () => {
  const { supabase, user } = await getDashboardAuthContext()
  if (!user) return { data: null, error: null }

  return supabase
    .from('company_members')
    .select('company_id, role, companies:company_id(id, name, org_number, entity_type, accounting_framework, jurisdiction, ledger_currency, created_by, team_id, archived_at, created_at, updated_at, bolaget_registers_enabled)')
    .eq('user_id', user.id)
})

/**
 * Request-local role of the signed-in user in the active company. Null with
 * no active company or no membership in it.
 */
export const getDashboardCompanyRole = cache(async (): Promise<string | null> => {
  const [companyId, { data: memberships }] = await Promise.all([
    getDashboardCompanyId(),
    getDashboardCompanyMemberships(),
  ])
  if (!companyId) return null
  return (memberships ?? []).find((m) => m.company_id === companyId)?.role ?? null
})

/**
 * Sends an invoicer to the invoices before a page outside the role's pages
 * reads anything (lib/auth/invoicer-role.ts). The layout redirects too, but
 * Next renders a page in parallel with its layout, and a client navigation
 * does not render the layout at all. A page whose own server reads go
 * through the user's session (Hem's worklist RPCs, a capability check) would
 * otherwise run them for a role the database does not count as a member, and
 * log every refusal. Call it before the page's first read. On a full load it
 * shares the layout's memberships read.
 */
export async function redirectInvoicerOffPage(): Promise<void> {
  const [role, headerStore] = await Promise.all([getDashboardCompanyRole(), headers()])
  const destination = invoicerPageRedirect(role, headerStore.get('x-pathname') ?? '')
  if (destination) redirect(destination)
}

export interface DashboardTeamMembership {
  team_id: string
  role: string
  teams: Team | null
}

/**
 * Request-local team memberships with the team row embedded. ALL memberships:
 * multi-team membership (own personal team + byrå team) is the supported
 * shape after WL-08; a `.limit(1)` would pick an arbitrary row and could hide
 * a consultant's byrå membership. Shared between the dashboard layout (byrå
 * cockpit gate) and the home page (byrå landing redirect), so the byrå check
 * costs no extra query.
 */
export const getDashboardTeamMemberships = cache(
  async (): Promise<DashboardTeamMembership[]> => {
    const { supabase, user } = await getDashboardAuthContext()
    if (!user) return []

    const { data } = await supabase
      .from('team_members')
      .select('team_id, role, teams:team_id(*)')
      .eq('user_id', user.id)

    return (data ?? []) as unknown as DashboardTeamMembership[]
  },
)

/**
 * Request-local profile of the signed-in user (full_name). The layout shows
 * it in the account popover and Hem greets with the first name: one read per
 * request instead of one per server component.
 */
export const getDashboardUserProfile = cache(async () => {
  const { supabase, user } = await getDashboardAuthContext()
  if (!user) return { data: null, error: null }

  return supabase.from('profiles').select('full_name').eq('id', user.id).maybeSingle()
})

/**
 * Request-local fiscal periods of the active company, newest first. The
 * layout seeds the client reference-data cache with them and the focused
 * report and reconciliation pages hand the same list to their period
 * pickers, so a hard load of those pages reads fiscal_periods once, not
 * twice. Same select and order as period.list, so the seed and the client
 * refetch agree.
 */
export const getDashboardFiscalPeriods = cache(async () => {
  const [{ supabase }, companyId] = await Promise.all([
    getDashboardAuthContext(),
    getDashboardCompanyId(),
  ])
  if (!companyId) return { data: [] as FiscalPeriod[], error: null }

  return supabase
    .from('fiscal_periods')
    .select('*')
    .eq('company_id', companyId)
    .order('period_start', { ascending: false })
})

export const getDashboardSettings = cache(async () => {
  const [{ supabase }, companyId] = await Promise.all([
    getDashboardAuthContext(),
    getDashboardCompanyId(),
  ])
  if (!companyId) return { data: null, error: null }

  // Full row: the layout hands it to the client reference-data cache as the
  // seed for useCompanySettings (which reads select('*') itself), so the
  // narrow column list this once carried would have been refetched on the
  // first mount anyway. The other consumers read a subset of the row.
  return supabase
    .from('company_settings')
    .select('*')
    .eq('company_id', companyId)
    .maybeSingle()
})

const getDashboardAgentProfile = cache(async () => {
  const [{ supabase }, companyId] = await Promise.all([
    getDashboardAuthContext(),
    getDashboardCompanyId(),
  ])
  if (!companyId) return { data: null, error: null }

  return supabase
    .from('agent_profiles')
    .select('display_name, avatar_id, verified_at')
    .eq('company_id', companyId)
    .maybeSingle()
})

export const getResolvedDashboardAgentProfile = cache(async () => {
  const [{ supabase }, companyId, settingsResult, profileResult] = await Promise.all([
    getDashboardAuthContext(),
    getDashboardCompanyId(),
    getDashboardSettings(),
    getDashboardAgentProfile(),
  ])

  let profile = profileResult.data
  if (companyId && settingsResult.data?.is_sandbox === true && !profile?.verified_at) {
    await ensureSandboxAgentProfile(supabase, companyId)
    const refreshed = await supabase
      .from('agent_profiles')
      .select('display_name, avatar_id, verified_at')
      .eq('company_id', companyId)
      .maybeSingle()
    profile = refreshed.data ?? profile
  }

  return profile
})

/**
 * Request-local open obligations (lib/modules/obligations.ts) of the
 * packages the active company has switched off, keyed by their ids joined
 * with commas so the layout (the menu keeps a winding-down package) and the
 * Anpassa page share one probe. Never called for a company with every
 * package on.
 */
export const getDashboardOpenObligations = cache(
  async (packageIdsKey: string): Promise<Partial<Record<PackageId, ObligationCode[]>>> => {
    const [{ supabase }, companyId] = await Promise.all([getDashboardAuthContext(), getDashboardCompanyId()])
    if (!companyId || !packageIdsKey) return {}
    return loadOpenObligations(supabase, companyId, packageIdsKey.split(',') as PackageId[])
  },
)
