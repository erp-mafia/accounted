import type { SupabaseClient } from '@supabase/supabase-js'
import type { CompanyInbox } from '@/types'

export function composeInboxAddress(localPart: string, domain: string): string {
  return `${localPart}@${domain}`
}

export async function getActiveInbox(
  supabase: SupabaseClient,
  companyId: string
): Promise<CompanyInbox | null> {
  const { data, error } = await supabase
    .from('company_inboxes')
    .select('*')
    .eq('company_id', companyId)
    .eq('status', 'active')
    .maybeSingle()

  if (error) throw new Error(`Failed to load inbox: ${error.message}`)
  return (data as CompanyInbox | null) ?? null
}

// Rotate the company's inbox address. Delegates to the rotate_company_inbox
// RPC so the three steps (deprecate, generate, insert) run inside a single
// Postgres transaction; a failure on any step rolls the whole thing back
// and the company is never left without an active inbox.
export async function rotateCompanyInbox(
  supabase: SupabaseClient,
  companyId: string
): Promise<CompanyInbox> {
  const { data, error } = await supabase
    .rpc('rotate_company_inbox', { p_company_id: companyId })

  if (error || !data) {
    throw new Error(`Failed to rotate inbox: ${error?.message ?? 'no data'}`)
  }

  // The RPC returns a single row (SETOF company_inboxes).
  const row = Array.isArray(data) ? data[0] : data
  if (!row) throw new Error('Failed to rotate inbox: RPC returned no row')

  return row as CompanyInbox
}
