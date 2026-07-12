import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'

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

    let query = supabase
      .from('sie_imports')
      .select('*', { count: 'exact' })
      .eq('company_id', companyId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (status) {
      query = query.eq('status', status)
    }

    const { data, error, count } = await query

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({
      data,
      count,
      limit,
      offset,
    })
  },
)
