import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/require-auth'
import { normalizeOrgNumber } from '@/lib/company-lookup/normalize-org-number'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { validateBody } from '@/lib/api/validate'
import { CheckOrgNumberBodySchema } from '@/lib/api/schemas'

/**
 * POST /api/company/check-org-number  body: { org_number }
 *
 * A read sent as POST: a sole trader's org number is the owner's personnummer,
 * and a query string is copied into request logs and error telemetry. The GET
 * form it replaced had no caller outside the onboarding journey.
 *
 * Returns `{ data: { exists, companies } }`: matches among the CURRENT USER's
 * own companies (`{ id, name }[]`), scoped by RLS. Nothing about other
 * accounts leaves the server: whether the same org number exists under
 * someone else's account is not the caller's business (a company can be
 * set up in several accounts on purpose; the operator removed the
 * "finns redan i Accounted" hint 2026-09-09).
 *
 * Org-number reuse across the platform is intentionally allowed (see
 * lib/company/actions.ts), so this is a soft "you already have it" note, NOT
 * a uniqueness gate. The query uses the authenticated client on purpose: the
 * `companies` SELECT RLS policy limits results to companies the caller is a
 * member of (id IN user_company_ids()).
 *
 * Normalizes input with the same rule as the create action so a 12-digit form
 * still matches a stored 10-digit canonical. Returns no matches for malformed
 * input: the create action rejects that separately as `org_number_invalid`.
 */
export async function POST(request: Request) {
  // requireAuth() (not a raw getUser()) so MFA AAL2 is enforced on hosted before
  // we run the account-scoped lookup. The returned client carries the caller's
  // RLS context, which is what scopes the companies SELECT below.
  const { supabase, error: authError } = await requireAuth()
  if (authError) return authError

  const validation = await validateBody(request, CheckOrgNumberBodySchema)
  if (!validation.success) return validation.response

  const canonical = normalizeOrgNumber(validation.data.org_number)
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
    return NextResponse.json({ error: getUserErrorMessage(error) }, { status: 500 })
  }

  const companies = (data ?? []).map((c: { id: string; name: string }) => ({
    id: c.id,
    name: c.name,
  }))

  return NextResponse.json({
    data: { exists: companies.length > 0, companies },
  })
}
