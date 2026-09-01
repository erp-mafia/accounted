import type { SupabaseClient } from '@supabase/supabase-js'
import { isSelfHosted } from '@/lib/env/public-flags'
import { CAPABILITY } from './keys'
import {
  computeMultiUserState,
  isMembershipDormant,
  MULTI_USER_GRACE_DAYS,
  type MultiUserAccess,
  type MultiUserGrantRow,
} from './multi-user-state'

export {
  MULTI_USER_GRACE_DAYS,
  isMembershipDormant,
  computeMultiUserState,
  type MultiUserAccess,
  type MultiUserGrantRow,
} from './multi-user-state'
export type { MultiUserState } from './multi-user-state'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Whether the owner-only dormancy rule is enforced at all in this
 * environment. False on self-hosted instances (multi_user is a local
 * capability: an AGPL operator's own instance is never seat-gated) and under
 * the dev bypass; FORCE_PAYWALL flips it on in dev like every other gate.
 * Callers use this to pick the gated resolution RPC vs the plain one.
 *
 * Deliberately NOT delegated to has-capability's isBypassedFor: multi_user is
 * never a connector capability, so the logic reduces to these env reads, and
 * standing alone keeps this module import-light (it is called from the Edge
 * middleware on every request, and several test suites partially mock
 * has-capability without expecting resolution paths to pull it in).
 */
export function isMultiUserEnforced(): boolean {
  if (isSelfHosted()) return false
  if (process.env.FORCE_PAYWALL === 'true') return true
  const bypassed =
    process.env.NODE_ENV === 'development' || process.env.DISABLE_PAYWALL === 'true'
  return !bypassed
}

/**
 * Resolve a company's multi-user access state (entitled / grace / frozen)
 * from its multi_user grants, company- and team-scoped alike. Fail-open on
 * read errors: a transient grants failure must never lock people out of
 * their bookkeeping (the opposite polarity of hasCapability, which guards
 * paid external services and fails closed).
 *
 * RPC-FIRST: the company_multi_user_state() SECURITY DEFINER function is the
 * primary path, because the capability_grants SELECT policy hides
 * team-scoped rows from users who are not on the team: a byrå client company
 * read through a user-scoped client would misread as frozen when its only
 * coverage is the byrå team's grant. The raw grants read below is only the
 * fallback for a database that does not have the function yet (deploy race,
 * self-host mid-migration), where it fails toward access.
 */
export async function getMultiUserState(
  supabase: SupabaseClient,
  companyId: string,
  options: { teamId?: string | null } = {},
): Promise<MultiUserAccess> {
  if (!isMultiUserEnforced()) return { state: 'entitled', graceEndsAt: null }
  if (!UUID_RE.test(companyId)) return { state: 'frozen', graceEndsAt: null }
  try {
    return await resolveMultiUserState(supabase, companyId, options)
  } catch {
    // Fail OPEN on ANY unexpected throw (a client without .rpc, a network
    // exception): a broken read must never lock people out of their books.
    return { state: 'entitled', graceEndsAt: null }
  }
}

async function resolveMultiUserState(
  supabase: SupabaseClient,
  companyId: string,
  options: { teamId?: string | null },
): Promise<MultiUserAccess> {
  const { data: rpcData, error: rpcError } = await supabase.rpc('company_multi_user_state', {
    p_company_id: companyId,
    p_grace_days: MULTI_USER_GRACE_DAYS,
  })
  if (!rpcError) {
    const row = (Array.isArray(rpcData) ? rpcData[0] : rpcData) as
      | { state: string; grace_ends_at: string | null }
      | null
      | undefined
    if (row?.state === 'entitled' || row?.state === 'grace' || row?.state === 'frozen') {
      return { state: row.state, graceEndsAt: row.grace_ends_at ?? null }
    }
  } else if (rpcError.code === 'PGRST202') {
    // Function absent = the paywall migration (and its backfills) has not
    // reached this database yet: there are no multi_user rows to judge by, so
    // the grants fallback would freeze every non-owner. Fail OPEN for the
    // deploy-race window; the gate arms itself when the migration lands.
    return { state: 'entitled', graceEndsAt: null }
  }

  let teamId = options.teamId
  if (teamId === undefined) {
    const { data: company, error } = await supabase
      .from('companies')
      .select('team_id')
      .eq('id', companyId)
      .maybeSingle()
    if (error) return { state: 'entitled', graceEndsAt: null } // fail-open
    teamId = (company as { team_id: string | null } | null)?.team_id ?? null
  }
  const validTeamId = teamId && UUID_RE.test(teamId) ? teamId : null

  const scopeFilter = validTeamId
    ? `company_id.eq.${companyId},team_id.eq.${validTeamId}`
    : `company_id.eq.${companyId}`
  const { data: grants, error: grantsError } = await supabase
    .from('capability_grants')
    .select('expires_at')
    .eq('capability_key', CAPABILITY.multi_user)
    .or(scopeFilter)
  if (grantsError) return { state: 'entitled', graceEndsAt: null } // fail-open

  return computeMultiUserState((grants ?? []) as MultiUserGrantRow[], Date.now())
}

/**
 * Whether THIS membership may enter the company right now: the dormancy rule
 * applied to a resolved (companyId, role) pair. Owners always pass without a
 * grants read.
 */
export async function isMembershipActive(
  supabase: SupabaseClient,
  companyId: string,
  role: string,
  options: { teamId?: string | null } = {},
): Promise<boolean> {
  if (role === 'owner') return true
  if (!isMultiUserEnforced()) return true
  const access = await getMultiUserState(supabase, companyId, options)
  return !isMembershipDormant(role, access.state)
}
