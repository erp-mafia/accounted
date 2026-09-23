import { NextResponse } from 'next/server'
import { parseCustomersFile } from '@/lib/import/customers/parser'
import { normalizeOrgNumber, normalizeEmail } from '@/lib/import/shared/column-utils'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import type {
  AnnotatedCustomerRow,
  CustomerImportParseResult,
  DetectedCustomerColumns,
} from '@/lib/import/customers/types'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

const ALLOWED_EXTENSIONS = ['.xlsx', '.xls', '.csv', '.ods']
const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB

/**
 * POST /api/import/customers/parse
 *
 * Accepts an Excel/CSV file via FormData, auto-detects columns, parses rows,
 * and annotates each row with any duplicate-match against existing customers.
 */
export const POST = withRouteContext(
  'register_import.customers.parse',
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

    let columnOverrides: DetectedCustomerColumns | undefined
    if (columnOverridesRaw) {
      try {
        columnOverrides = JSON.parse(columnOverridesRaw)
      } catch {
        return errorResponseFromCode('REG_IMPORT_INVALID_COLUMN_OVERRIDES', opLog, { requestId })
      }
    }

    try {
      const buffer = await file.arrayBuffer()
      const parsed = parseCustomersFile(buffer, file.name, columnOverrides)

      // Fetch existing customers for duplicate detection.
      const existing = await fetchAllRows(({ from, to }) =>
        supabase
          .from('customers')
          .select('id, name, org_number, email')
          .eq('company_id', companyId)
          .range(from, to),
      )

      const byOrg = new Map<string, { id: string; name: string }>()
      const byEmail = new Map<string, { id: string; name: string }>()
      for (const c of existing) {
        const org = normalizeOrgNumber(c.org_number)
        if (org) byOrg.set(org, { id: c.id, name: c.name })
        const email = normalizeEmail(c.email)
        if (email) byEmail.set(email, { id: c.id, name: c.name })
      }

      let duplicateCount = 0
      const annotated: AnnotatedCustomerRow[] = parsed.rows.map((r) => {
        const orgKey = normalizeOrgNumber(r.org_number)
        const emailKey = normalizeEmail(r.email)
        let match: AnnotatedCustomerRow['duplicate_match'] = null
        if (orgKey && byOrg.has(orgKey)) {
          const e = byOrg.get(orgKey)!
          match = { customer_id: e.id, matched_by: 'org_number', existing_name: e.name }
        } else if (emailKey && byEmail.has(emailKey)) {
          const e = byEmail.get(emailKey)!
          match = { customer_id: e.id, matched_by: 'email', existing_name: e.name }
        }
        if (match) duplicateCount++
        return { ...r, duplicate_match: match }
      })

      const result: CustomerImportParseResult = {
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
      opLog.error('customer import parse failed', err as Error)
      return errorResponseFromCode('REG_IMPORT_PARSE_FAILED', opLog, {
        requestId,
        details: { reason: err instanceof Error ? getUserErrorMessage(err) : 'unknown' },
      })
    }
  },
)
