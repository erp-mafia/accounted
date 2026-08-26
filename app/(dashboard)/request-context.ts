import 'server-only'

import { cache } from 'react'
import type { User } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { claimsPinned, userFromClaims } from '@/lib/auth/claims'
import { getActiveCompanyId } from '@/lib/company/context'
import { ensureSandboxAgentProfile } from '@/lib/sandbox/ensure-agent'

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
  if (typeof supabase.auth.getClaims === 'function') {
    try {
      const { data } = await supabase.auth.getClaims()
      if (data?.claims?.sub && claimsPinned(data.claims)) user = userFromClaims(data.claims)
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
