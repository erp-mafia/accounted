import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getActiveCompanyId } from '@/lib/company/context'
import type { CompanyRole } from '@/types'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'

/**
 * Write-permission guard for API routes.
 *
 * Looks up the caller's role in the currently active company. Returns a
 * 403 JSON response if the role is 'viewer' (or if the user has no role
 * in any resolvable company). Any other role (owner / admin / member)
 * passes.
 *
 * Meant to be called AFTER `requireAuth()` in every API route that
 * mutates tenant data (POST / PATCH / PUT / DELETE). Read-only POSTs
 * that only generate PDFs or run utility lookups (e.g. VAT validation)
 * should skip this check.
 *
 * This is the application-layer half of the defense-in-depth story; the
 * RLS helper `public.current_user_can_write()` is the database half.
 * Having both means a viewer who bypasses the JS UI and calls the API
 * directly still gets a clean 403, and even if someone forgets to add
 * this guard to a new route, the RLS policy blocks the write at the
 * database layer.
 */
type WritePermissionResult =
  | { ok: true }
  | { ok: false; response: NextResponse }

/**
 * Facts the caller has already established for this request. Passing
 * `companyId` skips the `resolve_active_company` round trip that
 * `getActiveCompanyId` would otherwise repeat (withRouteContext resolves it
 * two awaits earlier for every route); passing `role` skips the membership
 * select as well. Only ever pass values that came from `getActiveCompanyId`
 * / `company_members` for the same user in the same request: this is a
 * dedupe, not a trust boundary.
 */
export interface KnownRouteContext {
  companyId: string
  role?: CompanyRole
}

async function selectRole(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
): Promise<CompanyRole | null> {
  const { data: membership } = await supabase
    .from('company_members')
    .select('role')
    .eq('company_id', companyId)
    .eq('user_id', userId)
    .maybeSingle()
  return membership ? (membership.role as CompanyRole) : null
}

export async function requireWritePermission(
  supabase: SupabaseClient,
  userId: string,
  known?: KnownRouteContext,
): Promise<WritePermissionResult> {
  const companyId = known?.companyId ?? (await getActiveCompanyId(supabase, userId))

  if (!companyId) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Inget aktivt företag.' },
        { status: 403 },
      ),
    }
  }

  const role = known?.role ?? (await selectRole(supabase, companyId, userId))

  if (!role || role === 'viewer') {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Du har endast läsbehörighet i detta företag.' },
        { status: 403 },
      ),
    }
  }

  return { ok: true }
}

/**
 * Owner/admin predicate for routes that write a table whose RLS policy is
 * `user_is_company_admin(company_id)`: company_settings, companies,
 * company_members, company_invitations, api_keys, invoice_payee_defaults.
 *
 * `requireWritePermission()` lets a `member` through, and RLS then refuses
 * the write without raising: the UPDATE matches zero rows and the route has
 * to guess why. That is two definitions of "may write here" that disagree
 * for exactly one role. This does not restate the rule in TypeScript: it asks
 * the database the SAME predicate the policy evaluates
 * (public.user_is_company_admin, 20260422120000), so the route and the row
 * can never disagree about who is an administrator. Routes opt in through
 * `withRouteContext(..., { requireAdmin: true })`.
 *
 * Owner and admin are both non-viewer roles, so a route gated here does not
 * also need `requireWritePermission()`.
 *
 * Throws when the predicate cannot be evaluated: "we could not check" must
 * not read as "you are not allowed" (withRouteContext maps the throw to the
 * canonical 500 envelope). A null answer fails closed.
 */
export async function isCompanyAdmin(
  supabase: SupabaseClient,
  companyId: string,
): Promise<boolean> {
  const { data, error } = await supabase.rpc('user_is_company_admin', {
    p_company_id: companyId,
  })
  if (error) throw error
  return data === true
}

/**
 * The canonical 403 for an owner/admin-only action: one envelope, whether the
 * wrapper's gate refused or a handler found that RLS refused the row.
 */
export function companyAdminRequiredResponse(
  log: Parameters<typeof errorResponseFromCode>[1],
  requestId: string,
): NextResponse {
  return errorResponseFromCode('FORBIDDEN', log, {
    requestId,
    messageSv: 'Bara företagets ägare eller en administratör kan göra det här.',
    messageEn: 'Only the company owner or an administrator can do this.',
    details: { required_roles: ['owner', 'admin'] },
  })
}

/**
 * Resolves the caller's role in the active company without blocking viewers.
 *
 * Unlike `requireWritePermission()` (which returns 403 for viewers), this
 * returns the actual role so the caller can make conditional decisions:
 * e.g. allowing viewers to import raw bank transactions but nothing else.
 *
 * Use `requireWritePermission()` for routes that are fully off-limits to
 * viewers. Use `getCompanyRole()` only when the route needs viewer-
 * conditional behavior.
 */
export type CompanyRoleResult =
  | { ok: true; role: CompanyRole; companyId: string }
  | { ok: false; response: NextResponse }

export async function getCompanyRole(
  supabase: SupabaseClient,
  userId: string,
  known?: Pick<KnownRouteContext, 'companyId'>,
): Promise<CompanyRoleResult> {
  const companyId = known?.companyId ?? (await getActiveCompanyId(supabase, userId))

  if (!companyId) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Inget aktivt företag.' },
        { status: 403 },
      ),
    }
  }

  const role = await selectRole(supabase, companyId, userId)

  if (!role) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Du har ingen roll i detta företag.' },
        { status: 403 },
      ),
    }
  }

  return { ok: true, role, companyId }
}
