/**
 * Role gates for operations: owner/admin, and the writer gate an operation
 * that writes through the service role checks first.
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
import { isBookkeepingWriterRole } from '@/lib/auth/invoicer-role'
import { getCompanyRole, readOnlyRefusal } from '@/lib/auth/require-write'
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

/**
 * For an operation that writes through the service role what the caller's
 * own client may not (a table only the service role writes): the caller
 * keeps the books of ctx.companyId, the roles caller_can_write_company lets
 * through. Every door checks the role before run() as well, but the
 * escalation must not rest on that alone. Read on the door's client, as
 * requireCompanyAdmin reads it.
 */
export async function requireCompanyWriter(
  ctx: OperationContext,
): Promise<Extract<OperationOutcome<never>, { ok: false }> | null> {
  const result = await getCompanyRole(ctx.supabase, ctx.userId, { companyId: ctx.companyId })
  if (result.ok && isBookkeepingWriterRole(result.role)) return null
  return { ok: false, code: 'FORBIDDEN', ...readOnlyRefusal('ROLE_READ_ONLY') }
}
