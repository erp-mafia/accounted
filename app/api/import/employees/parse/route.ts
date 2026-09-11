import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { parseEmployeesFile, normalizeKommunName } from '@/lib/import/employees/parser'
import { loadExistingEmployeeIndex } from '@/lib/import/employees/existing'
import { fetchKommunTaxRates } from '@/lib/salary/tax-tables'
import type {
  AnnotatedEmployeeRow,
  DetectedEmployeeColumns,
  EmployeeImportParseResult,
} from '@/lib/import/employees/types'

ensureInitialized()

const ALLOWED_EXTENSIONS = ['.xlsx', '.xls', '.csv', '.ods']
const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB

// Kommun -> skattetabell, one fetch per year per process (the mapping changes
// once a year). A failed fetch is not fatal: rows that only give a kommun
// then fail the schema's "skattetabell krävs" check and say so per row.
const kommunCache = new Map<number, Record<string, number>>()

async function kommunTableMap(year: number, log: { warn: (msg: string, err?: Error) => void }) {
  const cached = kommunCache.get(year)
  if (cached) return cached
  try {
    const list = await fetchKommunTaxRates(year)
    const map: Record<string, number> = {}
    for (const entry of list) map[normalizeKommunName(entry.kommun)] = entry.tableNumber
    kommunCache.set(year, map)
    return map
  } catch (err) {
    log.warn('employee import: kommun tax table map unavailable', err as Error)
    return undefined
  }
}

/** First day of the current month: the cutover a file without brytdatum gets. */
function defaultCutoverDate(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
}

/**
 * POST /api/import/employees/parse
 *
 * Accepts an Excel/CSV file via FormData, auto-detects columns, parses and
 * validates rows with the same schema as the "Ny anställd" dialog, and
 * annotates each row with any duplicate against the company's roster.
 */
export const POST = withRouteContext(
  'register_import.employees.parse',
  async (request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx

    const formData = await request.formData()
    const file = formData.get('file') as File | null
    const columnOverridesRaw = formData.get('column_overrides') as string | null

    if (!file) {
      return errorResponseFromCode('REG_IMPORT_NO_FILE', log, { requestId })
    }
    if (file.size > MAX_FILE_SIZE) {
      return errorResponseFromCode('REG_IMPORT_FILE_TOO_LARGE', log, {
        requestId,
        details: { sizeMb: +(file.size / 1024 / 1024).toFixed(1) },
      })
    }
    const ext = '.' + file.name.split('.').pop()?.toLowerCase()
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return errorResponseFromCode('REG_IMPORT_INVALID_FORMAT', log, {
        requestId,
        details: { extension: ext, allowed: ALLOWED_EXTENSIONS },
      })
    }

    const opLog = log.child({ filename: file.name, sizeBytes: file.size })

    let columnOverrides: DetectedEmployeeColumns | undefined
    if (columnOverridesRaw) {
      try {
        columnOverrides = JSON.parse(columnOverridesRaw)
      } catch {
        return errorResponseFromCode('REG_IMPORT_INVALID_COLUMN_OVERRIDES', opLog, { requestId })
      }
    }

    try {
      const now = new Date()
      const buffer = await file.arrayBuffer()
      const parsed = parseEmployeesFile(buffer, file.name, columnOverrides, {
        kommunTableByName: await kommunTableMap(now.getFullYear(), opLog),
        defaultCutoverDate: defaultCutoverDate(now),
        now,
      })

      const existing = await loadExistingEmployeeIndex(supabase, companyId)

      let duplicateCount = 0
      const annotated: AnnotatedEmployeeRow[] = parsed.rows.map((r) => {
        const match = existing.get(r.employee.personnummer) ?? null
        if (match) duplicateCount++
        return { ...r, duplicate_match: match }
      })

      const result: EmployeeImportParseResult = {
        filename: parsed.filename,
        sheet_name: parsed.sheet_name,
        total_rows: annotated.length,
        detected_columns: parsed.detected_columns,
        headers: parsed.headers,
        preview_rows: parsed.preview_rows,
        rows: annotated,
        duplicate_count: duplicateCount,
        warnings: parsed.warnings,
        notices: parsed.notices,
      }

      return NextResponse.json({ data: result })
    } catch (err) {
      opLog.error('employee import parse failed', err as Error)
      return errorResponseFromCode('REG_IMPORT_PARSE_FAILED', opLog, {
        requestId,
        details: { reason: err instanceof Error ? getUserErrorMessage(err) : 'unknown' },
      })
    }
  },
)
