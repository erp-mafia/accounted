import { NextResponse } from 'next/server'
import { parseSuppliersFile } from '@/lib/import/suppliers/parser'
import { createRegisterMatcher, supplierOrgKey } from '@/lib/import/shared/register-match'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import type {
  AnnotatedSupplierRow,
  SupplierImportParseResult,
  DetectedSupplierColumns,
} from '@/lib/import/suppliers/types'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

const ALLOWED_EXTENSIONS = ['.xlsx', '.xls', '.csv', '.ods']
const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB

export const POST = withRouteContext(
  'register_import.suppliers.parse',
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

    let columnOverrides: DetectedSupplierColumns | undefined
    if (columnOverridesRaw) {
      try {
        columnOverrides = JSON.parse(columnOverridesRaw)
      } catch {
        return errorResponseFromCode('REG_IMPORT_INVALID_COLUMN_OVERRIDES', opLog, { requestId })
      }
    }

    try {
      const buffer = await file.arrayBuffer()
      const parsed = parseSuppliersFile(buffer, file.name, columnOverrides)

      const existing = await fetchAllRows(({ from, to }) =>
        supabase
          .from('suppliers')
          .select('id, name, org_number, email')
          .eq('company_id', companyId)
          .range(from, to),
      )

      // The same matcher execute uses, so the preview cannot promise a match
      // the import then misses.
      const matcher = createRegisterMatcher(existing, { orgKey: supplierOrgKey })

      let duplicateCount = 0
      const annotated: AnnotatedSupplierRow[] = parsed.rows.map((r) => {
        const found = matcher.find(r)
        const match: AnnotatedSupplierRow['duplicate_match'] = found && !found.possible
          ? { supplier_id: found.record.id, matched_by: found.matched_by, existing_name: found.record.name }
          : null
        const possible: AnnotatedSupplierRow['possible_duplicate'] = found?.possible
          ? { supplier_id: found.record.id, existing_name: found.record.name }
          : null
        if (match) duplicateCount++
        return { ...r, duplicate_match: match, possible_duplicate: possible }
      })

      const result: SupplierImportParseResult = {
        filename: parsed.filename,
        sheet_name: parsed.sheet_name,
        total_rows: annotated.length,
        detected_columns: parsed.detected_columns,
        headers: parsed.headers,
        preview_rows: parsed.preview_rows,
        rows: annotated,
        duplicate_count: duplicateCount,
        warnings: parsed.warnings,
      }

      return NextResponse.json({ data: result })
    } catch (err) {
      opLog.error('supplier import parse failed', err as Error)
      return errorResponseFromCode('REG_IMPORT_PARSE_FAILED', opLog, {
        requestId,
        details: { reason: err instanceof Error ? getUserErrorMessage(err) : 'unknown' },
      })
    }
  },
)
