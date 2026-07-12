import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { ensureInitialized } from '@/lib/init'
import { requireAuth } from '@/lib/auth/require-auth'
import { validateBody } from '@/lib/api/validate'
import { eventBus } from '@/lib/events'
import { createLogger } from '@/lib/logger'

const log = createLogger('api/company/delete')

ensureInitialized()

const DeleteCompanySchema = z.object({
  confirm_name: z.string().min(1),
})

/**
 * POST /api/company/[id]/delete
 *
 * Soft-delete a company. Sets archived_at + archived_by. The underlying
 * bookkeeping data is retained for 7 years per BFL 7 kap. 2§. All reads
 * flow through user_company_ids() which filters archived rows, so the
 * company disappears from the user's UI immediately.
 *
 * Rules:
 *  - Only callers with role='owner' in company_members may delete.
 *  - The body must include confirm_name matching the company's display name
 *    exactly as the UI shows it: company_settings.company_name, falling back
 *    to companies.name only when no settings row exists. ONLY that single
 *    name is accepted (see step 3) — accepting alternates would weaken the
 *    confirmation gate on an irreversible action.
 *  - Already-archived companies return 404 (treated as not found).
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: companyId } = await params

  const auth = await requireAuth()
  if (auth.error) return auth.error
  const { user, supabase } = auth

  const result = await validateBody(request, DeleteCompanySchema)
  if (!result.success) return result.response
  const { confirm_name } = result.data

  // Service client for writes that must bypass RLS (audit_log insert,
  // user_preferences clearing). All queries still filter by company_id
  // and user.id for defense in depth.
  const service = createServiceClient()

  // 1. Fetch company: must exist and be active. Query via service client
  // because we need the raw row regardless of RLS visibility, but we still
  // enforce membership below.
  const { data: company, error: fetchError } = await service
    .from('companies')
    .select('id, name, archived_at')
    .eq('id', companyId)
    .maybeSingle()

  if (fetchError) {
    log.error('Failed to fetch company', { companyId, error: fetchError.message })
    return NextResponse.json({ error: 'Kunde inte hämta företag.' }, { status: 500 })
  }

  if (!company || company.archived_at) {
    return NextResponse.json({ error: 'Företaget hittades inte.' }, { status: 404 })
  }

  // 2. Caller must be an owner of this company
  const { data: membership, error: membershipError } = await service
    .from('company_members')
    .select('role')
    .eq('company_id', companyId)
    .eq('user_id', user.id)
    .maybeSingle()

  if (membershipError) {
    log.error('Failed to fetch membership', { companyId, error: membershipError.message })
    return NextResponse.json({ error: 'Kunde inte verifiera behörighet.' }, { status: 500 })
  }

  if (!membership) {
    return NextResponse.json({ error: 'Företaget hittades inte.' }, { status: 404 })
  }

  if (membership.role !== 'owner') {
    return NextResponse.json(
      { error: 'Endast ägaren kan radera ett företag.' },
      { status: 403 }
    )
  }

  // 3. Confirm name matches the exact name the UI displays. The dashboard layout
  // resolves the displayed name as `company_settings.company_name || companies.name`
  // (companies.name may be stale) and CompanyDangerZone gates on that value, so
  // the server must accept ONLY that single name. Accepting the stale
  // companies.name as an alternative would open a confirmation path the user was
  // never shown, weakening the gate on an irreversible action (ASVS V8.2.1).
  // Case-sensitive trim, mirror of the client-side check.
  const { data: companySettings } = await service
    .from('company_settings')
    .select('company_name')
    .eq('company_id', companyId)
    .maybeSingle()

  const displayName = (companySettings?.company_name || company.name).trim()
  const typed = confirm_name.trim()

  if (typed !== displayName) {
    return NextResponse.json(
      { error: 'Företagsnamnet stämmer inte överens.' },
      { status: 400 }
    )
  }

  // 4. Soft delete
  const archivedAt = new Date().toISOString()
  const { error: updateError } = await service
    .from('companies')
    .update({ archived_at: archivedAt, archived_by: user.id })
    .eq('id', companyId)

  if (updateError) {
    log.error('Failed to archive company', { companyId, error: updateError.message })
    return NextResponse.json({ error: 'Kunde inte radera företaget.' }, { status: 500 })
  }

  // 5. Clear user_preferences.active_company_id if it pointed here so the
  // middleware falls through to another membership next request.
  await service
    .from('user_preferences')
    .update({ active_company_id: null })
    .eq('user_id', user.id)
    .eq('active_company_id', companyId)

  // 6. Write audit log row. companies has no auto-audit trigger, so do it
  // explicitly. Service client bypasses audit_log RLS (no INSERT policy).
  // The archive already happened — don't fail the request, but an audit
  // write failing on an irreversible action must never be silent.
  const { error: auditError } = await service.from('audit_log').insert({
    user_id: user.id,
    company_id: companyId,
    action: 'DELETE',
    table_name: 'companies',
    record_id: companyId,
    actor_id: user.id,
    old_state: { archived_at: null },
    new_state: { archived_at: archivedAt, archived_by: user.id },
    description: `Company archived: ${company.name}`,
  })
  if (auditError) {
    log.error('Failed to write audit_log row for company archive', {
      companyId,
      error: auditError.message,
    })
  }

  // 7. Emit event
  await eventBus.emit({
    type: 'company.deleted',
    payload: { companyId, userId: user.id, archivedAt },
  })

  // 8. Build response and clear company cookie if it matched
  const response = NextResponse.json({ data: { companyId, archivedAt } })

  const cookieCompanyId = request.headers.get('cookie')?.match(/gnubok-company-id=([^;]+)/)?.[1]
  if (cookieCompanyId === companyId) {
    response.cookies.set('gnubok-company-id', '', {
      path: '/',
      maxAge: 0,
    })
  }

  // Ignore supabase server-client cookie warnings; the response is what
  // the browser sees. RLS session isn't relevant here.
  void supabase

  return response
}
