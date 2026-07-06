import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/require-auth'

/**
 * GET /api/company?owned=true&archived=false
 *
 * Returns companies the caller has access to, filtered by query:
 *  - owned=true     → only companies where caller's role is 'owner'
 *  - archived=false → only non-archived companies (default)
 *
 * Used by the account danger zone to show a blockers list before
 * allowing account deletion. User-level (spans ALL memberships), so it uses
 * requireAuth() directly — no single active-company context applies.
 */
export async function GET(request: Request) {
  const auth = await requireAuth()
  if (auth.error) return auth.error
  const { user, supabase } = auth

  const url = new URL(request.url)
  const ownedOnly = url.searchParams.get('owned') === 'true'
  const includeArchived = url.searchParams.get('archived') === 'true'

  let query = supabase
    .from('company_members')
    .select('role, companies!inner(id, name, archived_at)')
    .eq('user_id', user.id)

  if (ownedOnly) query = query.eq('role', 'owner')
  if (!includeArchived) query = query.is('companies.archived_at', null)

  const { data, error } = await query

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const companies = (data ?? []).map((row) => {
    const company = (row.companies as unknown) as {
      id: string
      name: string
      archived_at: string | null
    }
    return {
      id: company.id,
      name: company.name,
      archived_at: company.archived_at,
      role: row.role as string,
    }
  })

  return NextResponse.json({ data: companies })
}
