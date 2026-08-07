import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { cookies } from 'next/headers'
import type { EntityType } from '@/types'

const COMPANY_COOKIE = 'gnubok-company-id'

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
    readonly code: 'not_member' | 'persist_failed' | 'resolution_failed'
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
  const { data, error } = await supabase.rpc('resolve_active_company')

  if (error) {
    // PGRST202: function not in the schema cache (self-hosted instance not
    // migrated yet, or a deploy racing the branch merge).
    // 42501: EXECUTE is granted to `authenticated` only, so a service-role
    // client is refused. These fallbacks are LOAD-BEARING, not defensive:
    // app/api/mcp-oauth/token/route.ts and app/api/events/route.ts (API-key
    // branch) call requireCompanyId with createServiceClientNoCookies(), and
    // must silently resolve via the query path or the OAuth token flow breaks.
    if (error.code === 'PGRST202' || error.code === '42501') {
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
 * Query-path resolution: the pre-RPC implementation, kept verbatim as the
 * fallback for getActiveCompanyId (see the fallback conditions there).
 */
async function getActiveCompanyIdViaQueries(
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

/**
 * Resolve a company's effective entity type.
 *
 * `company_settings.entity_type` is the read-primary source (what the user
 * edits in settings and what the sidebar reads), with the canonical
 * `companies.entity_type` as the fallback: mirroring app/api/settings and the
 * report engines. Returns null only if the company can't be found.
 */
export async function getCompanyEntityType(
  supabase: SupabaseClient,
  companyId: string
): Promise<EntityType | null> {
  const { data: settings } = await supabase
    .from('company_settings')
    .select('entity_type')
    .eq('company_id', companyId)
    .maybeSingle()

  if (settings?.entity_type) return settings.entity_type as EntityType

  const { data: company } = await supabase
    .from('companies')
    .select('entity_type')
    .eq('id', companyId)
    .maybeSingle()

  return (company?.entity_type as EntityType | undefined) ?? null
}

/**
 * Resolve a company's current display name.
 *
 * `company_settings.company_name` is the read-primary source (what the user
 * edits in Settings and what the invoice PDF renders), with the canonical
 * `companies.name` as the fallback. `companies.name` is written once at
 * onboarding (via create_company_with_owner) and never updated afterwards, so
 * reading it directly shows a stale name after a rename (e.g. a lagerbolag
 * renamed post-signup). Mirrors getCompanyEntityType and the invoice surfaces.
 *
 * Returns null only if the company can't be resolved from either table.
 */
export async function getCompanyDisplayName(
  supabase: SupabaseClient,
  companyId: string
): Promise<string | null> {
  const { data: settings } = await supabase
    .from('company_settings')
    .select('company_name')
    .eq('company_id', companyId)
    .maybeSingle()

  // Truthiness (not != null) so an empty string falls through to companies.name.
  if (settings?.company_name) return settings.company_name as string

  const { data: company } = await supabase
    .from('companies')
    .select('name')
    .eq('id', companyId)
    .maybeSingle()

  return (company?.name as string | undefined) ?? null
}

/**
 * Get all companies the user is a member of, with their roles.
 */
export async function getUserCompanies(
  supabase: SupabaseClient,
  userId: string
) {
  return fetchAllRows(({ from, to }) =>
    supabase
      .from('company_members')
      .select(`
        id,
        company_id,
        role,
        joined_at,
        companies:company_id (
          id,
          name,
          org_number,
          entity_type,
          archived_at,
          created_at
        )
      `)
      .eq('user_id', userId)
      .order('id', { ascending: true })
      .range(from, to),
  )
}

/**
 * Set the active company for the user.
 *
 * Writes to `user_preferences` (authoritative, consulted by RLS via
 * `current_active_company_id()`) and refreshes the `gnubok-company-id`
 * cookie for backwards-compat with any code still reading it.
 */
export async function setActiveCompany(
  supabase: SupabaseClient,
  userId: string,
  companyId: string
): Promise<void> {
  // Validate membership
  const { data: membership } = await supabase
    .from('company_members')
    .select('company_id')
    .eq('company_id', companyId)
    .eq('user_id', userId)
    .single()

  if (!membership) {
    throw new CompanyContextError('User is not a member of this company', 'not_member')
  }

  // Update user_preferences: this is the authoritative value RLS reads.
  // The write MUST be verified: an UPDATE filtered out by RLS affects zero
  // rows without raising an error, which previously made failed switches
  // look successful while middleware kept resolving the old company (#701).
  // `.select().single()` reads the row back, so both an explicit error and
  // a silent zero-row write surface as a thrown CompanyContextError.
  const { data: persisted, error: upsertError } = await supabase
    .from('user_preferences')
    .upsert(
      { user_id: userId, active_company_id: companyId },
      { onConflict: 'user_id' }
    )
    .select('active_company_id')
    .single()

  if (upsertError) {
    throw new CompanyContextError(
      `Failed to persist active company: ${upsertError.message}`,
      'persist_failed'
    )
  }
  if (persisted?.active_company_id !== companyId) {
    throw new CompanyContextError(
      'Active company write did not persist',
      'persist_failed'
    )
  }

  // Refresh the cookie as a compat hint: only after the DB write is
  // confirmed, so the cookie can never diverge from user_preferences.
  // Best-effort: Next only allows cookie mutation in Server Actions and
  // Route Handlers, and setActiveCompany is also called from Server
  // Component render (the /select-company single-company auto-forward),
  // where cookies() is sealed and set() throws. The cookie is a write-only
  // legacy hint that nothing reads anymore (see CLAUDE.md tenancy notes),
  // and the authoritative DB write above is already verified, so a skipped
  // refresh cannot desync anything. Swallowing here mirrors the setAll
  // pattern in lib/supabase/server.ts.
  try {
    const cookieStore = await cookies()
    cookieStore.set(COMPANY_COOKIE, companyId, {
      path: '/',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 365, // 1 year
    })
  } catch {
    // Sealed cookie store (render phase): the DB write is what matters.
  }
}

/**
 * Get the active company ID for API routes.
 * Throws if no company context can be resolved.
 */
export async function requireCompanyId(
  supabase: SupabaseClient,
  userId: string
): Promise<string> {
  const companyId = await getActiveCompanyId(supabase, userId)
  if (!companyId) {
    throw new Error('No company context')
  }
  return companyId
}
