import type { SupabaseClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import type { EntityType } from '@/types'

const COMPANY_COOKIE = 'gnubok-company-id'

/**
 * Thrown by setActiveCompany so callers can tell a permissions problem
 * ('not_member') apart from a failed/unverified database write
 * ('persist_failed') and surface the right message to the user.
 */
export class CompanyContextError extends Error {
  constructor(
    message: string,
    readonly code: 'not_member' | 'persist_failed'
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
 * Returns null if the user has no non-archived companies.
 */
export async function getActiveCompanyId(
  supabase: SupabaseClient,
  userId: string
): Promise<string | null> {
  // 1. user_preferences: authoritative
  const { data: prefs } = await supabase
    .from('user_preferences')
    .select('active_company_id')
    .eq('user_id', userId)
    .maybeSingle()

  if (prefs?.active_company_id) {
    // Validate the preference still points to a non-archived company the
    // user is a member of.
    const { data: membership } = await supabase
      .from('company_members')
      .select('company_id, companies!inner(archived_at)')
      .eq('company_id', prefs.active_company_id)
      .eq('user_id', userId)
      .is('companies.archived_at', null)
      .maybeSingle()

    if (membership) return membership.company_id
  }

  // 2. Fallback: first non-archived membership by created_at
  const { data: firstCompany } = await supabase
    .from('company_members')
    .select('company_id, companies!inner(archived_at)')
    .eq('user_id', userId)
    .is('companies.archived_at', null)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

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
 * Get all companies the user is a member of, with their roles.
 */
export async function getUserCompanies(
  supabase: SupabaseClient,
  userId: string
) {
  const { data, error } = await supabase
    .from('company_members')
    .select(`
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
    .order('joined_at', { ascending: true })

  if (error) throw error
  return data ?? []
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
  const cookieStore = await cookies()
  cookieStore.set(COMPANY_COOKIE, companyId, {
    path: '/',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 365, // 1 year
  })
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
