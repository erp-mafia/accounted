import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { isEntityType } from '@/lib/company/entity-type'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'

/**
 * GET /api/company/entity-type-preview?target=<entity_type>
 *
 * Read-only assessment of changing the active company's legal form
 * (preview_company_entity_type_change): whether the empty-books correction
 * (PATCH /api/company/current { entity_type }) would be accepted, which
 * blockers exist otherwise, and the posted balances on the accounts whose
 * remap needs a human decision (design section 11). Never writes.
 */
const PREVIEW_ERRORS: Record<string, { code: string; status: number }> = {
  ENTITY_TYPE_CHANGE_FORBIDDEN: { code: 'FORBIDDEN', status: 403 },
  ENTITY_TYPE_CHANGE_NOT_FOUND: { code: 'NOT_FOUND', status: 404 },
  ENTITY_TYPE_CHANGE_UNSUPPORTED: { code: 'VALIDATION_ERROR', status: 400 },
}

export const GET = withRouteContext('company.entity_type_preview', async (request, ctx) => {
  const { supabase, companyId, log, requestId } = ctx
  const target = new URL(request.url).searchParams.get('target')
  if (!isEntityType(target)) {
    return errorResponseFromCode('VALIDATION_ERROR', log, {
      requestId,
      reason: 'target must be a supported entity_type',
    })
  }
  const { data, error } = await supabase.rpc('preview_company_entity_type_change', {
    p_company_id: companyId,
    p_entity_type: target,
  })
  if (error) {
    // Thrown inside withRouteContext: errorResponse() turns it into the
    // canonical envelope without echoing the raw Postgres message.
    throw error
  }
  const result = (data ?? {}) as { ok?: boolean; code?: string }
  if (!result.ok) {
    const mapped = PREVIEW_ERRORS[result.code ?? ''] ?? { code: 'VALIDATION_ERROR', status: 400 }
    return errorResponseFromCode(mapped.code, log, { requestId, status: mapped.status, reason: result.code })
  }
  return NextResponse.json({ data: result })
})
