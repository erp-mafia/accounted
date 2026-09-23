import { NextResponse } from 'next/server'
import { parseOpeningBalanceFile } from '@/lib/import/opening-balance/parser'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import type { DetectedColumns } from '@/lib/import/opening-balance/types'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

const ALLOWED_EXTENSIONS = ['.xlsx', '.xls', '.csv', '.ods']
const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB

/**
 * POST /api/import/opening-balance/parse
 *
 * Accepts an Excel/CSV file via FormData, auto-detects columns, and returns
 * parsed opening balance rows with BAS matching.
 */
export const POST = withRouteContext(
  'opening_balance.parse',
  async (request, ctx) => {
    const { log, requestId } = ctx

    const formData = await request.formData()
    const file = formData.get('file') as File | null
    const columnOverridesRaw = formData.get('column_overrides') as string | null

    if (!file) {
      return errorResponseFromCode('OB_NO_FILE', log, { requestId })
    }

    if (file.size > MAX_FILE_SIZE) {
      return errorResponseFromCode('OB_FILE_TOO_LARGE', log, {
        requestId,
        details: { sizeMb: +(file.size / 1024 / 1024).toFixed(1) },
      })
    }

    const ext = '.' + file.name.split('.').pop()?.toLowerCase()
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return errorResponseFromCode('OB_INVALID_FORMAT', log, {
        requestId,
        details: { extension: ext, allowed: ALLOWED_EXTENSIONS },
      })
    }

    const opLog = log.child({ filename: file.name, sizeBytes: file.size })

    let columnOverrides: DetectedColumns | undefined
    if (columnOverridesRaw) {
      try {
        columnOverrides = JSON.parse(columnOverridesRaw)
      } catch {
        return errorResponseFromCode('OB_INVALID_COLUMN_OVERRIDES', opLog, { requestId })
      }
    }

    try {
      const buffer = await file.arrayBuffer()
      const result = parseOpeningBalanceFile(buffer, file.name, columnOverrides)
      return NextResponse.json({ data: result })
    } catch (err) {
      opLog.error('opening balance parse failed', err as Error)
      return errorResponseFromCode('OB_PARSE_FAILED', opLog, {
        requestId,
        details: { reason: err instanceof Error ? getUserErrorMessage(err) : 'unknown' },
      })
    }
  },
)
