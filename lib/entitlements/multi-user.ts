import type { SupabaseClient } from '@supabase/supabase-js'
import { CAPABILITY } from './keys'
import { isBypassedFor } from './has-capability'
import {
  computeMultiUserState,
  isMembershipDormant,
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
 */
export function isMultiUserEnforced(): boolean {
  return !isBypassedFor(CAPABILITY.multi_user)
}

/**
 * Resolve a company's multi-user access state (entitled / grace / frozen)
 * from its multi_user grants, company- and team-scoped alike. Fail-open on
 * read errors: a transient grants failure must never lock people out of
 * their bookkeeping (the opposite polarity of hasCapability, which guards
 * paid external services and fails closed).
 */
export async function getMultiUserState(
  supabase: SupabaseClient,
  companyId: string,
  options: { teamId?: string | null } = {},
): Promise<MultiUserAccess> {
  if (!isMultiUserEnforced()) return { state: 'entitled', graceEndsAt: null }
  if (!UUID_RE.test(companyId)) return { state: 'frozen', graceEndsAt: null }

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
