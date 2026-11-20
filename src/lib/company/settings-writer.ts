/**
 * The one write of company_settings columns a door makes on behalf of a person
 * or a key, outside the settings save itself (./settings-service.ts).
 *
 * company_settings is an owner's or admin's table. RLS says so for a session,
 * by refusing without a word: the UPDATE matches zero rows and raises nothing,
 * so a door that trusts the missing error reports a save that never happened.
 * The v1 and MCP doors run as the service role, where RLS does not apply at
 * all, so a member's key wrote what the member's session may not. Here the
 * role is asked on every door, a dry run included, and a write that matched no
 * row answers as a failure.
 */
import { requireCompanyAdmin } from '@/lib/operations/access'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import type { CompanySettings } from '@/types'

const ADMIN_MESSAGE = 'Bara företagets ägare eller en administratör kan ändra företagsinställningarna.'

type Failure = Extract<OperationOutcome<never>, { ok: false }>

/** Owner or admin, or the refusal a member gets at every door. */
export function requireSettingsAdmin(ctx: OperationContext): Promise<Failure | null> {
  return requireCompanyAdmin(ctx, ADMIN_MESSAGE)
}

/**
 * Write these columns on the company's settings row and answer the row as it
 * now stands. Undefined columns are left alone (JSON drops them), null clears.
 */
export async function writeCompanySettings(
  ctx: OperationContext,
  columns: Partial<CompanySettings>,
): Promise<{ ok: true; data: Record<string, unknown> } | Failure> {
  const denied = await requireSettingsAdmin(ctx)
  if (denied) return denied

  const { data, error } = await ctx.supabase
    .from('company_settings')
    .update(columns)
    .eq('company_id', ctx.companyId)
    .select('*')
    .maybeSingle()

  if (error) return { ok: false, code: 'UNKNOWN_ERROR', error }
  if (!data) {
    return {
      ok: false,
      code: 'NOT_FOUND',
      messageSv: 'Inställningarna hittades inte.',
      details: { resource: 'company_settings' },
    }
  }
  return { ok: true, data: data as Record<string, unknown> }
}
