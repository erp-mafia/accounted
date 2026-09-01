import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { cookies } from 'next/headers'
import type { EntityType } from '@/types'
import { CompanyContextError, getActiveCompanyId } from '@/lib/company/active-company'
import { isMembershipActive } from '@/lib/entitlements/multi-user'

// The resolver and its error class live in active-company.ts (no
// `next/headers` there) so the API-key path can use them; re-exported here so
// every existing import site and test mock keeps working.
export { CompanyContextError, getActiveCompanyId }

const COMPANY_COOKIE = 'gnubok-company-id'

/**
 * Session marker for an EXPLICIT company choice (WL byrå landing). Set only
 * by setActiveCompany, which every deliberate switch funnels through
 * (company switcher, cockpit client entry, onboarding). The middleware's
 * first-membership fallback write-back upserts user_preferences directly and
 * never sets this, so "/" can tell a picked company from an auto-resolved
 * one. Session-scoped on purpose: a new browser session starts unpicked.
 */
export const COMPANY_PICKED_COOKIE = 'gnubok-company-picked'

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
    .select('company_id, role')
    .eq('company_id', companyId)
    .eq('user_id', userId)
    .single()

  if (!membership) {
    throw new CompanyContextError('User is not a member of this company', 'not_member')
  }

  // Multi-user seat gate: a non-owner may not switch INTO a company frozen
  // for them (multi_user lapsed past its grace window). Without this check
  // the preference write would stick and every subsequent gated resolution
  // would silently bounce them elsewhere, which reads as a broken switch.
  const seatGateOk = await isMembershipActive(supabase, companyId, membership.role)
  if (!seatGateOk) {
    throw new CompanyContextError(
      'Company is frozen for this membership: multi-user access requires a paid plan',
      'company_locked'
    )
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
    // Explicit-choice marker (see COMPANY_PICKED_COOKIE). No maxAge: a session
    // cookie, gone when the browser closes.
    cookieStore.set(COMPANY_PICKED_COOKIE, '1', {
      path: '/',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
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
