/**
 * Owner/admin gate for operations.
 *
 * The v1 and MCP doors run on a service-role client, so RLS does not apply
 * there and user_is_company_admin() (which reads auth.uid()) sees nobody.
 * withApiV1 refuses viewers and nothing more, so without a check here a
 * plain member's API key could do what the dashboard reserves for owners
 * and admins. Any operation that writes what the dashboard gates with
 * requireAdmin (company settings, bank and payee details, members, keys)
 * calls this in its service, before any write and also on a dry run, so an
 * MCP stage is refused up front and approval checks the approving user.
 */
import { getCompanyRole } from '@/lib/auth/require-write'
import type { OperationContext, OperationOutcome } from './types'

export const COMPANY_ADMIN_ROLES = ['owner', 'admin'] as const

export async function requireCompanyAdmin(
  ctx: OperationContext,
  messageSv: string,
): Promise<Extract<OperationOutcome<never>, { ok: false }> | null> {
  // The same membership read the dashboard's requireWrite/requireAdmin use.
  const result = await getCompanyRole(ctx.supabase, ctx.userId, { companyId: ctx.companyId })
  if (result.ok && (COMPANY_ADMIN_ROLES as readonly string[]).includes(result.role)) return null
  return {
    ok: false,
    code: 'FORBIDDEN',
    messageSv,
    details: { required_roles: [...COMPANY_ADMIN_ROLES] },
  }
}
