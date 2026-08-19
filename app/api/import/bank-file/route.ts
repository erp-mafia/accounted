import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

/**
 * GET /api/import/bank-file
 * List the company's bank file imports, newest first. Mirrors
 * GET /api/import/sie; feeds the 'Tidigare bankfilsimporter' history table
 * on the import tab (BankFileImportHistory), which is where the per-import
 * undo lives.
 */
export const GET = withRouteContext(
  'bank_file.list',
  async (request, { supabase, companyId }) => {
    // Parse query params
    const { searchParams } = new URL(request.url)
    const limit = parseInt(searchParams.get('limit') || '20', 10)
    const offset = parseInt(searchParams.get('offset') || '0', 10)
    const status = searchParams.get('status')

    let query = supabase
      .from('bank_file_imports')
      .select('*', { count: 'exact' })
      .eq('company_id', companyId)
      .order('created_at', { ascending: false })
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
