import 'server-only'

import { cache } from 'react'
import { createClient } from '@/lib/supabase/server'
import { getActiveCompanyId } from '@/lib/company/context'
import { ensureSandboxAgentProfile } from '@/lib/sandbox/ensure-agent'

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
