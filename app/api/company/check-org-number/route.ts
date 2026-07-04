import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/require-auth'
import { normalizeOrgNumber } from '@/lib/company-lookup/normalize-org-number'

/**
 * GET /api/company/check-org-number?org_number=XXXXXXXXXX
 *
 * Returns `{ data: { exists: boolean, companies: { id, name }[] } }` for the
 * companies the CURRENT USER already has with the given organisation number:
 * scoped to their own account only.
 *
 * Org-number reuse across the platform is intentionally allowed (see
 * lib/company/actions.ts), so this is a soft, account-scoped warning, NOT a
 * uniqueness gate. It uses the normal authenticated client on purpose: the
 * `companies` SELECT RLS policy limits results to companies the caller is a
 * member of (id IN user_company_ids()), so it can never reveal another user's
 * companies and can't be used to enumerate org numbers platform-wide.
 *
 * Normalizes input with the same rule as the create action so a 12-digit form
 * still matches a stored 10-digit canonical. Returns no matches for malformed
 * input: the create action rejects that separately as `org_number_invalid`.
 */
export async function GET(request: Request) {
  // requireAuth() (not a raw getUser()) so MFA AAL2 is enforced on hosted before
  // we run the account-scoped lookup. The returned client carries the caller's
  // RLS context, which is what scopes the companies SELECT below.
  const { supabase, error: authError } = await requireAuth()
  if (authError) return authError

  const url = new URL(request.url)
  const raw = url.searchParams.get('org_number') ?? ''
  if (!raw) {
    return NextResponse.json({ error: 'org_number is required' }, { status: 400 })
  }

  const canonical = normalizeOrgNumber(raw)
  if (!canonical) {
    // Malformed input is not a duplicate of anything by definition.
    return NextResponse.json({ data: { exists: false, companies: [] } })
  }

  // RLS scopes this SELECT to the caller's own memberships (companies_select:
  // id IN user_company_ids()), so the result is inherently account-scoped.
  const { data, error } = await supabase
    .from('companies')
    .select('id, name')
    .eq('org_number', canonical)
    .is('archived_at', null)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const companies = (data ?? []).map((c: { id: string; name: string }) => ({
    id: c.id,
    name: c.name,
  }))
  return NextResponse.json({
    data: { exists: companies.length > 0, companies },
  })
}
