import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { CompanyMigrationResetSchema } from '@/lib/api/schemas'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import type { CompanyMigrationResetRpcResult } from '@/types'

type Params = { params: Promise<{ id: string }> }

const EXPECTED_CODES = new Set([
  'COMPANY_RESET_NOT_FOUND',
  'COMPANY_RESET_FORBIDDEN',
  'COMPANY_RESET_INELIGIBLE',
  'COMPANY_RESET_CONFIRMATION_MISMATCH',
  'COMPANY_RESET_REASON_INVALID',
  'COMPANY_RESET_CONFIRMATION_REQUIRED',
])

function rpcFailure(
  result: CompanyMigrationResetRpcResult,
  log: Parameters<typeof errorResponseFromCode>[1],
  requestId: string,
) {
  const code = result.code && EXPECTED_CODES.has(result.code)
    ? result.code
    : 'COMPANY_RESET_FAILED'
  return errorResponseFromCode(code, log, {
    requestId,
    details: result.details,
  })
}

function privateNoStore(response: NextResponse): NextResponse {
  response.headers.set('Cache-Control', 'private, no-store')
  return response
}

/**
 * GET /api/company/[id]/migration-reset
 *
 * Returns the owner-only, fail-closed eligibility preview. The execution RPC
 * rechecks every condition, so this response is informational only.
 */
export const GET = withRouteContext<Params>(
  'company.migration-reset.preview',
  async (_request, { supabase, companyId, log, requestId }, { params }) => {
    const { id } = await params
    if (id !== companyId) {
      return privateNoStore(errorResponseFromCode('COMPANY_RESET_NOT_FOUND', log, { requestId }))
    }

    const { data, error } = await supabase.rpc(
      'get_company_migration_reset_eligibility',
      { p_company_id: companyId },
    )

    if (error) {
      log.error('migration reset eligibility RPC failed', error)
      return privateNoStore(errorResponseFromCode('COMPANY_RESET_FAILED', log, { requestId }))
    }

    const result = data as CompanyMigrationResetRpcResult | null
    if (!result?.ok) {
      return privateNoStore(rpcFailure(result ?? { ok: false }, log, requestId))
    }

    return privateNoStore(NextResponse.json({ data: result.eligibility }))
  },
)

/**
 * POST /api/company/[id]/migration-reset
 *
 * Atomically archives the source company and creates a clean active company.
 * No source accounting record is deleted, detached, renumbered, or copied.
 */
export const POST = withRouteContext<Params>(
  'company.migration-reset.execute',
  async (request, { supabase, companyId, log, requestId }, { params }) => {
    const { id } = await params
    if (id !== companyId) {
      return privateNoStore(errorResponseFromCode('COMPANY_RESET_NOT_FOUND', log, { requestId }))
    }

    const validation = await validateBody(request, CompanyMigrationResetSchema, {
      log,
      operation: 'company.migration-reset.execute',
    })
    if (!validation.success) return privateNoStore(validation.response)

    const body = validation.data
    const { data, error } = await supabase.rpc('reset_company_for_migration', {
      p_company_id: companyId,
      p_confirmed_name: body.confirm_name,
      p_reason: body.reason,
      p_confirm_no_filed_declarations: body.confirm_no_filed_declarations,
      p_confirm_retained_archive: body.confirm_retained_archive,
    })

    if (error) {
      log.error('migration reset RPC failed', error)
      return privateNoStore(errorResponseFromCode('COMPANY_RESET_FAILED', log, { requestId }))
    }

    const result = data as CompanyMigrationResetRpcResult | null
    if (!result?.ok) {
      return privateNoStore(rpcFailure(result ?? { ok: false }, log, requestId))
    }
    if (!result.replacement_company_id) {
      log.error('migration reset RPC returned no replacement company id')
      return privateNoStore(errorResponseFromCode('COMPANY_RESET_FAILED', log, { requestId }))
    }

    const response = NextResponse.json({
      data: {
        resetId: result.reset_id,
        sourceCompanyId: result.source_company_id,
        replacementCompanyId: result.replacement_company_id,
        archivedAt: result.archived_at,
        retainedCounts: result.counts,
      },
    })
    response.cookies.set('gnubok-company-id', result.replacement_company_id, {
      path: '/',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 365,
    })
    return privateNoStore(response)
  },
  { requireWrite: true },
)
