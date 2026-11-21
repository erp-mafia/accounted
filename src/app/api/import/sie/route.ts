import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

/**
 * GET /api/import/sie
 * List all SIE imports for the user
 */
export const GET = withRouteContext(
  'sie_import.list',
  async (request, { supabase, companyId }) => {
    // Parse query params
    const { searchParams } = new URL(request.url)
    const limit = parseInt(searchParams.get('limit') || '20', 10)
    const offset = parseInt(searchParams.get('offset') || '0', 10)
    const status = searchParams.get('status')

    // The columns the history renders. `select('*')` sent each row's manifest
    // and job_result (about 20 KB a row) on a page the history polls.
    // removed_at: when support removed an undone import from the ledger
    // (support_remove_undone_sie_import, crm#1954).
    let query = supabase
      .from('sie_imports')
      .select(
        'id, filename, fiscal_year_start, fiscal_year_end, transactions_count, status, job_state, job_kind, imported_at, created_at, repair_outcome:job_result->>repairOutcome, removed_at:job_result->support_removal->>removed_at',
        { count: 'exact' },
      )
      .eq('company_id', companyId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(offset, offset + limit - 1)

    if (status) {
      query = query.eq('status', status)
    }

    const { data, error, count } = await query

    if (error) {
      return NextResponse.json({ error: getUserErrorMessage(error) }, { status: 500 })
    }

    return NextResponse.json({
      data,
      count,
      limit,
      offset,
    })
  },
)
