import type { SupabaseClient } from '@supabase/supabase-js'

export interface LiveMembership {
  role: string
  /** company_settings.company_name, else companies.name; null when neither holds a name. */
  companyName: string | null
}

/** The display name out of the row's embedded companies(...), either PostgREST shape. */
function embeddedCompanyName(embedded: unknown): string | null {
  const company = Array.isArray(embedded) ? embedded[0] : embedded
  if (!company || typeof company !== 'object') return null
  const record = company as { name?: unknown; company_settings?: unknown }
  const settings = Array.isArray(record.company_settings) ? record.company_settings[0] : record.company_settings
  const displayName =
    settings && typeof settings === 'object' ? (settings as { company_name?: unknown }).company_name : undefined
  if (typeof displayName === 'string' && displayName.trim().length > 0) return displayName
  if (typeof record.name === 'string' && record.name.trim().length > 0) return record.name
  return null
}

/**
 * The user's membership in a company that is still live. Null when the user is
 * not a member or the company is archived: the two read alike, so a door tells
 * an outsider nothing about a deleted company. Throws when the read failed:
 * "could not check" is not "no".
 *
 * The one answer for the doors that run as the service role: the v1 company
 * gate, MCP routing, /api/events, the calendar feed and the attest mail's link.
 * RLS does not apply there, so this read is all that keeps an archived company
 * out of reach; a session gets the same rule from user_company_ids().
 *
 * Archived includes the retained source of a migration reset. Nothing here
 * touches it: its write freeze is in the database, and its statutory archive
 * is read by the replacement company's owner through
 * /api/company/[id]/migration-reset/archive, which does not come through here.
 * The other sanctioned reader of an archived company is the 18-month export
 * window of a deleted one (lib/company/deleted-company-export, terms 9.3):
 * read only, owners and admins, session routes only.
 */
export async function readLiveMembership(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
): Promise<LiveMembership | null> {
  // One query: the membership, the archived flag and both name sources
  // (company_settings is one-to-one on company_id).
  const { data, error } = await supabase
    .from('company_members')
    .select('company_id, role, companies!inner(archived_at, name, company_settings(company_name))')
    .eq('user_id', userId)
    .eq('company_id', companyId)
    .is('companies.archived_at', null)
    .maybeSingle()

  if (error) throw error
  if (!data) return null
  return { role: data.role as string, companyName: embeddedCompanyName((data as { companies?: unknown }).companies) }
}
