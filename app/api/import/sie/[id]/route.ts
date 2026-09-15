import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { z } from 'zod'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'

/**
 * GET /api/import/sie/[id]
 * Get details of a specific SIE import
 */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'sie_import.get',
  async (request, { supabase, companyId, log, requestId }, { params }) => {
    const id = z.uuid().parse((await params).id)

    const query = new URL(request.url).searchParams.has('progress')
      ? supabase.from('sie_imports').select('id,company_id,fiscal_period_id,job_state,job_kind,job_phase,chunks_total,chunks_done,transactions_count,prepared_through,error_message,job_result,supersedes_import_id')
      : supabase.from('sie_imports').select('*')
    const { data, error } = await query
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle()

    if (error) throw error

    if (!data) {
      return errorResponseFromCode('NOT_FOUND', log, { requestId })
    }

    return NextResponse.json({ data, ...(!data.job_state ? { recovery_url: `/api/import/sie/${id}/recovery` } : {}) },
      { headers: { 'Cache-Control': 'private, no-store' } })
  },
)

/**
 * DELETE /api/import/sie/[id]
 * Retain import history, including legacy failed rows whose outcome is unknown.
 */
export const DELETE = withRouteContext<{ params: Promise<{ id: string }> }>(
  'sie_import.delete',
  async (_request, { supabase, companyId, log, requestId }, { params }) => {
    const id = z.uuid().parse((await params).id)

    const { data: importRecord, error } = await supabase
      .from('sie_imports')
      .select('status, job_state')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle()

    if (error) throw error

    if (!importRecord) {
      return errorResponseFromCode('NOT_FOUND', log, { requestId })
    }

    return errorResponseFromCode(importRecord.job_state ? 'SIE_IMPORT_HISTORY_RETAINED' : 'SIE_IMPORT_LEGACY_REVIEW_REQUIRED', log, { requestId })
  },
  { requireWrite: true },
)
