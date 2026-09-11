import { NextResponse } from 'next/server'
import { parseSuppliersFile } from '@/lib/import/suppliers/parser'
import { normalizeEmail } from '@/lib/import/shared/column-utils'
import { orgNumberKey } from '@/lib/invariants/org-number'

// Same dedup key as the execute route (#2391): the Swedish 10-digit key when
// the value is one, else the value as typed.
const orgDedupKey = (value: string | null): string | null =>
  orgNumberKey(value) ?? (value?.trim() || null)
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

      const byOrg = new Map<string, { id: string; name: string }>()
      const byEmail = new Map<string, { id: string; name: string }>()
      for (const s of existing) {
        const org = orgDedupKey(s.org_number)
        if (org) byOrg.set(org, { id: s.id, name: s.name })
        const email = normalizeEmail(s.email)
        if (email) byEmail.set(email, { id: s.id, name: s.name })
      }

      let duplicateCount = 0
      const annotated: AnnotatedSupplierRow[] = parsed.rows.map((r) => {
        const orgKey = orgDedupKey(r.org_number)
        const emailKey = normalizeEmail(r.email)
        let match: AnnotatedSupplierRow['duplicate_match'] = null
        if (orgKey && byOrg.has(orgKey)) {
          const e = byOrg.get(orgKey)!
          match = { supplier_id: e.id, matched_by: 'org_number', existing_name: e.name }
        } else if (emailKey && byEmail.has(emailKey)) {
          const e = byEmail.get(emailKey)!
          match = { supplier_id: e.id, matched_by: 'email', existing_name: e.name }
        }
        if (match) duplicateCount++
        return { ...r, duplicate_match: match }
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
