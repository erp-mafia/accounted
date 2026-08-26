import 'server-only'

import { cache } from 'react'
import { createClient } from '@/lib/supabase/server'
import { getActiveCompanyId } from '@/lib/company/context'
import { ensureSandboxAgentProfile } from '@/lib/sandbox/ensure-agent'
import type { Team } from '@/types'

/**
 * Request-local dashboard auth context. React cache shares the Supabase client
 * and auth lookup between the dashboard layout and every nested server page.
 */
export const getDashboardAuthContext = cache(async () => {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  return { supabase, user }
})

/**
 * Request-local active company resolution. Nested layouts and pages commonly
 * need the same value, so resolving it once removes repeated preference and
 * membership round trips without caching anything across requests.
 */
export const getDashboardCompanyId = cache(async () => {
  const { supabase, user } = await getDashboardAuthContext()
  return user ? getActiveCompanyId(supabase, user.id) : null
})

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

export const getDashboardSettings = cache(async () => {
  const [{ supabase }, companyId] = await Promise.all([
    getDashboardAuthContext(),
    getDashboardCompanyId(),
  ])
  if (!companyId) return { data: null, error: null }

  return supabase
    .from('company_settings')
    .select('company_name, onboarding_complete, entity_type, pays_salaries, is_sandbox, dimensions_enabled, mileage_enabled, ore_rounding, initial_setup_path, initial_setup_completed_at, initial_setup_dismissed_at, vat_registered, moms_period')
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
