import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/require-auth'
import { normalizeOrgNumber } from '@/lib/company-lookup/normalize-org-number'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { validateBody } from '@/lib/api/validate'
import { CheckOrgNumberBodySchema } from '@/lib/api/schemas'
import { orderCompanyCopies } from '@/lib/company/company-copies'

type EmbeddedCompany = {
  id: string
  name: string
  created_at: string | null
  company_settings: { company_name: string | null } | { company_name: string | null }[] | null
}

type MembershipRow = {
  role: string
  companies: EmbeddedCompany | EmbeddedCompany[] | null
}

/** An embedded to-one resource, in either shape PostgREST hands it back. */
function one<T>(embedded: T | T[] | null | undefined): T | null {
  return (Array.isArray(embedded) ? embedded[0] : embedded) ?? null
}

/**
 * POST /api/company/check-org-number  body: { org_number }
 *
 * A read sent as POST: a sole trader's org number is the owner's personnummer,
 * and a query string is copied into request logs and error telemetry. The GET
 * form it replaced had no caller outside the onboarding journey.
 *
 * Returns `{ data: { exists, companies } }`: the live (non-archived)
 * companies with that org number that the CURRENT USER is a member of, as
 * `{ id, name, role, created_at }[]` (display name, the caller's role there),
 * oldest first (orderCompanyCopies). A user can hold several copies of one
 * company; the order and the created time let the onboarding stop list them
 * as a choice. Nothing about other accounts leaves the server: whether the
 * same org number exists under someone else's account is not the caller's
 * business (a company can be set up in several accounts on purpose; the
 * operator removed the "finns redan i Accounted" hint 2026-09-09).
 *
 * Org-number reuse across the platform is intentionally allowed (see
 * lib/company/actions.ts), so this is a soft "you already have it" note, NOT
 * a uniqueness gate. The query reads the caller's own company_members rows
 * (user_id = caller) through the authenticated client, so RLS
 * (user_company_ids(), invoicer_company_ids()) scopes it as well.
 *
 * Normalizes input with the same rule as the create action so a 12-digit form
 * still matches a stored 10-digit canonical. Returns no matches for malformed
 * input: the create action rejects that separately as `org_number_invalid`.
 */
export async function POST(request: Request) {
  // requireAuth() (not a raw getUser()) so MFA AAL2 is enforced on hosted before
  // we run the account-scoped lookup. The returned client carries the caller's
  // RLS context, which scopes the membership read below as well.
  const auth = await requireAuth()
  if (auth.error) return auth.error
  const { supabase, user } = auth

  const validation = await validateBody(request, CheckOrgNumberBodySchema)
  if (!validation.success) return validation.response

  const canonical = normalizeOrgNumber(validation.data.org_number)
  if (!canonical) {
    // Malformed input is not a duplicate of anything by definition.
    return NextResponse.json({ data: { exists: false, companies: [] } })
  }

  // The caller's own memberships, each with its company embedded (inner:
  // a membership whose company does not match is left out). RLS scopes the
  // same rows again.
  const { data, error } = await supabase
    .from('company_members')
    .select('role, companies!inner(id, name, created_at, org_number, archived_at, company_settings(company_name))')
    .eq('user_id', user.id)
    .eq('companies.org_number', canonical)
    .is('companies.archived_at', null)

  if (error) {
    return NextResponse.json({ error: getUserErrorMessage(error) }, { status: 500 })
  }

  const matches = ((data ?? []) as MembershipRow[]).flatMap((row) => {
    const company = one(row.companies)
    if (!company) return []
    const displayName = one(company.company_settings)?.company_name?.trim()
    return [{ id: company.id, name: displayName || company.name, role: row.role, createdAt: company.created_at }]
  })
  const companies = orderCompanyCopies(matches).map((c) => ({
    id: c.id,
    name: c.name,
    role: c.role,
    created_at: c.createdAt,
  }))

  return NextResponse.json({
    data: { exists: companies.length > 0, companies },
  })
}
