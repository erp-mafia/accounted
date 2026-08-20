import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import type { BankFileImportStatus } from '@/types'

const VALID_STATUSES: readonly BankFileImportStatus[] = [
  'pending',
  'processing',
  'completed',
  'failed',
  'undone',
]
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100

/** Strictly-digits nonnegative integer, or null when the value is invalid. */
function parseNonNegativeInt(raw: string | null, fallback: number): number | null {
  if (raw === null) return fallback
  if (!/^\d+$/.test(raw)) return null
  const n = Number(raw)
  return Number.isSafeInteger(n) ? n : null
}

/**
 * GET /api/import/bank-file
 * List the company's bank file imports, newest first. Mirrors
 * GET /api/import/sie; feeds the 'Tidigare bankfilsimporter' history table
 * on the import tab (BankFileImportHistory), which is where the per-import
 * undo lives.
 */
export const GET = withRouteContext(
  'bank_file.list',
  async (request, { supabase, companyId, log, requestId }) => {
    const { searchParams } = new URL(request.url)
    // parseInt would accept 'NaN'-producing and partial values ('12abc',
    // '1e9', '-1') and build an invalid or unbounded range from them; the
    // strict parse rejects them with a mapped 400, and limit is capped so a
    // single request cannot page the whole table.
    const limit = parseNonNegativeInt(searchParams.get('limit'), DEFAULT_LIMIT)
    const offset = parseNonNegativeInt(searchParams.get('offset'), 0)
    const rawStatus = searchParams.get('status')
    const status =
      rawStatus === null
        ? null
        : (VALID_STATUSES as readonly string[]).includes(rawStatus)
          ? (rawStatus as BankFileImportStatus)
          : undefined
    if (limit === null || limit < 1 || limit > MAX_LIMIT || offset === null || status === undefined) {
      return errorResponseFromCode('BANK_FILE_LIST_INVALID_QUERY', log, {
        requestId,
        details: {
          limit: searchParams.get('limit'),
          offset: searchParams.get('offset'),
          status: rawStatus,
          maxLimit: MAX_LIMIT,
        },
      })
    }

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
