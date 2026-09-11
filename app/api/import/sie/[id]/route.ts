import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

/**
 * GET /api/import/sie/[id]
 * Get details of a specific SIE import
 */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'sie_import.get',
  async (request, { supabase, companyId }, { params }) => {
    const { id } = await params

    const { data, error } = await supabase
      .from('sie_imports')
      .select(new URL(request.url).searchParams.has('progress') ? 'id,company_id,fiscal_period_id,job_state,job_kind,job_phase,chunks_total,chunks_done,transactions_count,prepared_through,error_message,job_result,supersedes_import_id' : '*')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle()

    if (error) {
      return NextResponse.json({ error: getUserErrorMessage(error) }, { status: 500 })
    }

    if (!data) {
      return NextResponse.json({ error: 'Import not found' }, { status: 404 })
    }

    return NextResponse.json({ data })
  },
)

/**
 * DELETE /api/import/sie/[id]
 * Retain import history, including legacy failed rows whose outcome is unknown.
 */
export const DELETE = withRouteContext<{ params: Promise<{ id: string }> }>(
  'sie_import.delete',
  async (_request, { supabase, companyId }, { params }) => {
    const { id } = await params

    // Check current status before deleting
    const { data: importRecord } = await supabase
      .from('sie_imports')
      .select('status, job_state')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (!importRecord) {
      return NextResponse.json({ error: 'Import not found' }, { status: 404 })
    }

    return NextResponse.json({
      error: 'Importhistoriken bevaras. Fortsätt eller ångra importen i stället.',
    }, { status: 403 })
  },
  { requireWrite: true },
)
