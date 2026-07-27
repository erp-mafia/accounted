import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/require-auth'
import { createServiceClient } from '@/lib/supabase/server'
import { normalizeOrgNumber } from '@/lib/company-lookup/normalize-org-number'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

/**
 * GET /api/company/check-org-number?org_number=XXXXXXXXXX
 *
 * Returns `{ data: { exists, companies, exists_elsewhere } }`:
 * - `exists` / `companies`: matches among the CURRENT USER's own companies
 *   (`{ id, name }[]`), scoped by RLS.
 * - `exists_elsewhere`: true when a non-archived company with this org number
 *   exists in an account the caller is NOT a member of. Existence only: no
 *   id, name, or owner ever leaves the server. This is what lets the wizard
 *   hint "this company already exists in Accounted" before a user rebuilds
 *   their bookkeeping in a second account and strands the first (#1231).
 *
 * Org-number reuse across the platform is intentionally allowed (see
 * lib/company/actions.ts), so both signals are soft warnings, NOT a
 * uniqueness gate. The own-companies query uses the authenticated client on
 * purpose: the `companies` SELECT RLS policy limits results to companies the
 * caller is a member of (id IN user_company_ids()). The cross-account probe
 * uses the service client but deliberately reduces to one boolean.
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
    return NextResponse.json({ data: { exists: false, companies: [], exists_elsewhere: false } })
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

  // Cross-account probe (service role bypasses RLS): does any non-archived
  // company with this org number exist outside the caller's memberships?
  // Fails soft to false: this is advisory, never worth blocking the wizard.
  let existsElsewhere = false
  try {
    const service = createServiceClient()
    const ownIds = new Set(companies.map((c) => c.id))
    const { data: allMatches, error: probeError } = await service
      .from('companies')
      .select('id')
      .eq('org_number', canonical)
      .is('archived_at', null)
      .limit(ownIds.size + 1)
    if (!probeError) {
      existsElsewhere = (allMatches ?? []).some((c: { id: string }) => !ownIds.has(c.id))
    }
  } catch {
    // Service key unavailable (some self-hosted setups): skip the hint.
  }

  return NextResponse.json({
    data: { exists: companies.length > 0, companies, exists_elsewhere: existsElsewhere },
  })
}
