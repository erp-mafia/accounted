import type { SupabaseClient } from '@supabase/supabase-js'
import { getMultiUserState, isMultiUserEnforced } from '@/lib/entitlements/multi-user'
import { isMembershipDormant, MULTI_USER_GRACE_DAYS } from '@/lib/entitlements/multi-user-state'

/**
 * Active-company resolution with no Next.js request-scope dependency.
 *
 * Split out of lib/company/context.ts (which imports `next/headers` for the
 * legacy company cookie) so that modules on the API-key path, notably
 * lib/auth/api-keys.ts, can resolve a user's company without dragging
 * `next/headers` into every bundle that validates a key. context.ts
 * re-exports everything here; import from there unless the cookie import is
 * the problem.
 */

/**
 * Thrown by setActiveCompany so callers can tell a permissions problem
 * ('not_member') apart from a failed/unverified database write
 * ('persist_failed'), and by getActiveCompanyId when a resolution query
 * fails ('resolution_failed': the active company is unknown right now,
 * which is NOT the same as the user having no companies).
 */
export class CompanyContextError extends Error {
  constructor(
    message: string,
    readonly code: 'not_member' | 'persist_failed' | 'resolution_failed' | 'company_locked'
  ) {
    super(message)
    this.name = 'CompanyContextError'
  }
}

/**
 * Get the active company ID for the authenticated user.
 *
 * Resolution order: user_preferences → first non-archived membership.
 *
 * `user_preferences.active_company_id` is the authoritative source. The
 * cookie `gnubok-company-id` is written as a hint for backwards-compat but
 * is no longer READ as a source of truth, because Postgres RLS (via
 * `current_active_company_id()`) can only read the database, not cookies.
 * Having Next.js and RLS both read from `user_preferences` keeps them
 * perfectly in sync.
 *
 * RPC-first: tries `resolve_active_company()` (one round trip, semantically
 * identical to the query path and to `current_active_company_id()`), falling
 * back to the original query path when the function is not deployed
 * (PGRST202), the caller lacks EXECUTE (42501: service-role clients), or the
 * RPC returns zero rows (NULL auth.uid(), also service-role clients).
 *
 * Returns null only when the user positively has no non-archived companies.
 * Throws CompanyContextError('resolution_failed') when a query fails: a
 * transient failure must never read as "no companies", because callers
 * redirect that state to the onboarding wizard (issue #1053).
 */
export async function getActiveCompanyId(
  supabase: SupabaseClient,
  userId: string
): Promise<string | null> {
  // Multi-user seat gate (lib/entitlements/multi-user.ts): when enforced,
  // resolution must skip memberships in companies frozen for this user
  // (non-owner, multi_user lapsed past its grace window). The gated RPC is
  // the zero-arg one plus exactly that predicate; self-hosted and dev keep
  // calling the ungated function so the gate can never bite there.
  const enforced = isMultiUserEnforced()
  const { data, error } = enforced
    ? await supabase.rpc('resolve_active_company_gated', {
        p_grace_days: MULTI_USER_GRACE_DAYS,
      })
    : await supabase.rpc('resolve_active_company')

  if (error) {
    // PGRST202: function not in the schema cache (self-hosted instance not
    // migrated yet, or a deploy racing the branch merge).
    // 42501: EXECUTE is granted to `authenticated` only, so a service-role
    // client is refused. These fallbacks are LOAD-BEARING, not defensive:
    // app/api/mcp-oauth/token/route.ts, app/api/events/route.ts (API-key
    // branch) and lib/auth/api-keys.ts call this with
    // createServiceClientNoCookies(), and must silently resolve via the query
    // path or the OAuth token flow breaks.
    //
    // The two fallbacks differ in seat-gate polarity ON PURPOSE:
    //   PGRST202 = the gated function does not exist here, i.e. the paywall
    //   migration has not reached this database (deploy race, self-host
    //   mid-migration). There are no multi_user rows either, so the gated
    //   query path would freeze every non-owner: fail OPEN via the ungated
    //   path, matching the middleware's own PGRST202 handling.
    //   42501 / zero rows = a migrated database reached with a service-role
    //   client (API keys, MCP, OAuth): the gated query path enforces there.
    if (error.code === 'PGRST202') {
      return getActiveCompanyIdViaQueriesUngated(supabase, userId)
    }
    if (error.code === '42501') {
      return getActiveCompanyIdViaQueries(supabase, userId)
    }
    throw new CompanyContextError(
      `Active company resolution failed: ${error.message}`,
      'resolution_failed'
    )
  }

  const row = (Array.isArray(data) ? data[0] : data) as
    | { company_id: string | null; locale: string | null; used_fallback: boolean }
    | undefined
    | null

  if (!row) {
    // Zero rows = NULL auth.uid() inside the RPC, i.e. a service-role client
    // (same call sites as the 42501 branch above). The query path filters by
    // the explicit userId param and still resolves correctly.
    return getActiveCompanyIdViaQueries(supabase, userId)
  }

  return row.company_id ?? null
}

/**
 * Query-path resolution: the pre-RPC implementation, kept as the fallback for
 * getActiveCompanyId (see the fallback conditions there). With the seat gate
 * enforced it routes to the gated variant below, because every service-role
 * caller (API keys, MCP, OAuth token flow) lands on this path on EVERY
 * request: leaving it ungated would make the API surface a paywall bypass.
 */
async function getActiveCompanyIdViaQueries(
  supabase: SupabaseClient,
  userId: string
): Promise<string | null> {
  if (isMultiUserEnforced()) {
    return getActiveCompanyIdViaQueriesGated(supabase, userId)
  }
  return getActiveCompanyIdViaQueriesUngated(supabase, userId)
}

/**
 * Gated query path: same resolution order (validated preference, else first
 * membership by created_at) restricted to memberships the seat gate lets
 * through: owner role, or a company whose multi_user grant is active or
 * within its 20-day grace window. Mirrors resolve_active_company_gated().
 *
 * Fail-open on the grants read specifically: a transient capability_grants
 * failure must never lock people out of their bookkeeping. The membership
 * and preference reads keep the fail-loud behavior of the ungated path.
 */
async function getActiveCompanyIdViaQueriesGated(
  supabase: SupabaseClient,
  userId: string
): Promise<string | null> {
  const [prefsRes, membershipsRes] = await Promise.all([
    supabase
      .from('user_preferences')
      .select('active_company_id')
      .eq('user_id', userId)
      .maybeSingle(),
    supabase
      .from('company_members')
      .select('company_id, role, created_at, companies!inner(archived_at, team_id)')
      .eq('user_id', userId)
      .is('companies.archived_at', null)
      .order('created_at', { ascending: true }),
  ])

  const resolutionError = prefsRes.error ?? membershipsRes.error
  if (resolutionError) {
    throw new CompanyContextError(
      `Active company resolution failed: ${resolutionError.message}`,
      'resolution_failed'
    )
  }

  type MembershipRow = {
    company_id: string
    role: string
    companies: { team_id: string | null }
  }
  const memberships = (membershipsRes.data ?? []) as unknown as MembershipRow[]
  if (memberships.length === 0) return null

  const dormant = await resolveDormantCompanyIds(supabase, memberships)

  const accessible = memberships.filter((m) => !dormant.has(m.company_id) || m.role === 'owner')
  const preferred = prefsRes.data?.active_company_id
  if (preferred && accessible.some((m) => m.company_id === preferred)) {
    return preferred
  }
  return accessible[0]?.company_id ?? null
}

/**
 * Which of these memberships' companies are dormant FOR THE MEMBER ROLE
 * (owner rows are exempt by the caller): companies whose multi_user grants
 * (company- or team-scoped) are all lapsed past the grace window. Shared by
 * the gated query fallback here and the switcher's locked-state computation
 * in the dashboard layout.
 *
 * Resolved per company through getMultiUserState (RPC-first): the
 * capability_grants SELECT policy hides team-scoped rows from users outside
 * the team, so a direct grants read through a user-scoped client would mark
 * every team-covered (byrå) company dormant. Fail-open by construction:
 * getMultiUserState answers 'entitled' on any read failure.
 */
export async function resolveDormantCompanyIds(
  supabase: SupabaseClient,
  memberships: readonly { company_id: string; role: string; companies: { team_id: string | null } }[]
): Promise<Set<string>> {
  const nonOwner = memberships.filter((m) => m.role !== 'owner')
  if (nonOwner.length === 0 || !isMultiUserEnforced()) return new Set()

  const companyIds = [...new Set(nonOwner.map((m) => m.company_id))]
  const states = await Promise.all(
    companyIds.map((companyId) => getMultiUserState(supabase, companyId))
  )
  const dormant = new Set<string>()
  companyIds.forEach((companyId, index) => {
    if (isMembershipDormant('member', states[index].state)) dormant.add(companyId)
  })
  return dormant
}

/**
 * Ungated query-path resolution: the pre-RPC implementation, kept verbatim.
 */
async function getActiveCompanyIdViaQueriesUngated(
  supabase: SupabaseClient,
  userId: string
): Promise<string | null> {
  // user_preferences (authoritative) + first membership, fetched in parallel:
  // the fallback query result doubles as validation when the preferred
  // company happens to be the first membership, which is the common
  // single-company case. Most requests pay one round trip instead of two
  // sequential ones. This runs on every withRouteContext API request and
  // every dashboard layout render, so the sequential version was pure
  // wall-clock cost. Mirrors resolveCompanyForMiddleware, minus the
  // write-back (read paths shouldn't write).
  const [prefsRes, firstRes] = await Promise.all([
    supabase
      .from('user_preferences')
      .select('active_company_id')
      .eq('user_id', userId)
      .maybeSingle(),
    supabase
      .from('company_members')
      .select('company_id, companies!inner(archived_at)')
      .eq('user_id', userId)
      .is('companies.archived_at', null)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle(),
  ])

  const resolutionError = prefsRes.error ?? firstRes.error
  if (resolutionError) {
    throw new CompanyContextError(
      `Active company resolution failed: ${resolutionError.message}`,
      'resolution_failed'
    )
  }

  const prefs = prefsRes.data
  const firstCompany = firstRes.data

  if (prefs?.active_company_id) {
    if (firstCompany && prefs.active_company_id === firstCompany.company_id) {
      return firstCompany.company_id
    }

    // Preference points at a different company than the first membership:
    // validate it still resolves to a non-archived company the user is a
    // member of before trusting it.
    const { data: membership, error: membershipError } = await supabase
      .from('company_members')
      .select('company_id, companies!inner(archived_at)')
      .eq('company_id', prefs.active_company_id)
      .eq('user_id', userId)
      .is('companies.archived_at', null)
      .maybeSingle()

    // Falling back to the first membership on a FAILED validation would
    // silently switch a multi-company user's active company: fail loudly.
    if (membershipError) {
      throw new CompanyContextError(
        `Active company validation failed: ${membershipError.message}`,
        'resolution_failed'
      )
    }

    if (membership) return membership.company_id
  }

  // Fallback: first non-archived membership by created_at (already fetched)
  return firstCompany?.company_id ?? null
}
