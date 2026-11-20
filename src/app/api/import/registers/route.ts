import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import type { RegisterImportRunListRow } from '@/lib/import/register-runs'

/** The history shows the latest runs; older ones stay in the table. */
const LIST_LIMIT = 20

/**
 * GET /api/import/registers
 *
 * The company's customer, supplier and article imports, newest first. Feeds
 * the 'Tidigare registerimporter' history on the import tab
 * (RegisterImportHistory), which is where the per-import undo lives.
 */
export const GET = withRouteContext(
  'register_import.list',
  async (_request, { supabase, companyId, log, requestId }) => {
    const { data, error } = await supabase
      .from('register_import_runs')
      .select('id, kind, created_count, updated_count, created_at, undone_at, undo_result')
      .eq('company_id', companyId)
      .order('created_at', { ascending: false })
      .limit(LIST_LIMIT)

    if (error) {
      log.error('register import list failed', error)
      return errorResponseFromCode('REG_IMPORT_LIST_FAILED', log, { requestId })
    }

    return NextResponse.json({ data: (data ?? []) as RegisterImportRunListRow[] })
  },
)
