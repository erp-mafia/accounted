/**
 * Reading a company's stored profile, in a module of its own so the light
 * readers (the package start gate in every route, ./package-gate.ts) need
 * nothing else from the capabilities resolver.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { StoredProfile } from './profiles'

/**
 * A company's stored profile (companies.profile_id and profile_version), in
 * a read of its own beside the company row. Null when none is stored and
 * when the read fails: a failed read, or a deploy that reaches a database
 * without the columns yet, then resolves to Standard (every package on)
 * instead of failing the menu or the report. A reader never hides on a
 * guess. The company row reads stay as they were, so the columns are never
 * on a path that a missing column would break.
 */
export async function readStoredProfile(supabase: SupabaseClient, companyId: string): Promise<StoredProfile | null> {
  try {
    const { data, error } = await supabase
      .from('companies')
      .select('profile_id, profile_version')
      .eq('id', companyId)
      .maybeSingle()
    if (error || !data) return null
    const row = data as { profile_id?: string | null; profile_version?: number | null }
    return row.profile_id ? { id: row.profile_id, version: row.profile_version ?? null } : null
  } catch {
    return null
  }
}
