import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { decodeFileContent } from '@/lib/import/shared/encoding'
import { normalizeOrgNumber } from '@/lib/import/shared/column-utils'
import { generateFileHash } from '@/lib/import/bank-file/parser'
import {
  detectSkattekontoFile,
  parseSkattekontoFile,
} from '@/lib/import/skattekonto-file/parser'
import { assignFileDedupKeys, partitionFileRows } from '@/lib/skatteverket/skattekonto-dedup'
import { fetchExistingSkattekontoRows } from '@/lib/import/skattekonto-file/import-service'

/**
 * POST /api/import/skattekonto-file/parse
 *
 * Accepts a skattekontoutdrag (Skatteverket tax account statement, CSV or
 * legacy .skv) via FormData and returns a parsed preview with row-level
 * duplicate/promotion detection against skattekonto_transactions.
 *
 * Unlike the bank-file flow there is no separate check-duplicates route: the
 * bank flow needs one only for its client-side generic_csv re-parse, which
 * has no equivalent here, so the partition is computed inline.
 */
export const POST = withRouteContext(
  'skattekonto_file.parse',
  async (request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx

    const formData = await request.formData()
    const file = formData.get('file') as File | null

    if (!file) {
      return errorResponseFromCode('SKATTEKONTO_FILE_NO_FILE', log, { requestId })
    }
    if (file.size > 10 * 1024 * 1024) {
      return errorResponseFromCode('SKATTEKONTO_FILE_TOO_LARGE', log, {
        requestId,
        details: { sizeMb: +(file.size / 1024 / 1024).toFixed(1) },
      })
    }

    const opLog = log.child({ filename: file.name, sizeBytes: file.size })

    try {
      const arrayBuffer = await file.arrayBuffer()
      const content = decodeFileContent(arrayBuffer)
      const fileHash = generateFileHash(content)

      const { data: existingImport } = await supabase
        .from('skattekonto_file_imports')
        .select('id, status, imported_count, created_at')
        .eq('company_id', companyId)
        .eq('file_hash', fileHash)
        .maybeSingle()

      if (existingImport && existingImport.status === 'completed') {
        return errorResponseFromCode('SKATTEKONTO_FILE_DUPLICATE', opLog, {
          requestId,
          details: {
            importId: existingImport.id,
            importedCount: existingImport.imported_count,
            importedAt: existingImport.created_at,
          },
        })
      }

      // Strict gate on purpose: without it, a bank CSV uploaded here by
      // mistake could parse "well enough" (date;text;number) and land bank
      // rows on the skattekonto.
      if (!detectSkattekontoFile(content, file.name)) {
        return errorResponseFromCode('SKATTEKONTO_FILE_NOT_RECOGNIZED', opLog, { requestId })
      }

      const parseResult = parseSkattekontoFile(content, file.name)

      if (parseResult.rows.length === 0) {
        return errorResponseFromCode('SKATTEKONTO_FILE_NO_ROWS', opLog, { requestId })
      }

      // A statement that does not sum is no longer refused: the preview shows
      // the gap and asks for confirmation (see parser.ts). Log the figures so
      // a report of "utdraget summerar inte" can be diagnosed without the
      // file: amounts and counts only, never row text.
      if (parseResult.sum_valid === false) {
        opLog.warn('skattekonto file does not sum', {
          openingSaldo: parseResult.opening_saldo,
          closingSaldo: parseResult.closing_saldo,
          eventsSum: parseResult.events_sum,
          sumDifference: parseResult.sum_difference,
          parsedRows: parseResult.stats.parsed_rows,
          skippedRows: parseResult.stats.skipped_rows,
          unreadableAmountRows: parseResult.stats.unreadable_amount_rows,
          dateFrom: parseResult.date_from,
          dateTo: parseResult.date_to,
          variant: parseResult.variant,
        })
      }

      // Wrong-company guard: the modern export names its orgnr in the header
      // row. A mismatch is surfaced for the preview step to confirm, not a
      // hard block (legacy files have no header at all).
      let orgNumberMismatch = false
      if (parseResult.org_number) {
        const { data: settings } = await supabase
          .from('company_settings')
          .select('org_number')
          .eq('company_id', companyId)
          .maybeSingle()
        const companyOrg = normalizeOrgNumber(settings?.org_number ?? null)
        const fileOrg = normalizeOrgNumber(parseResult.org_number)
        orgNumberMismatch = companyOrg !== null && fileOrg !== null && companyOrg !== fileOrg
      }

      const existing = await fetchExistingSkattekontoRows(
        supabase,
        companyId,
        parseResult.date_from as string,
        parseResult.date_to as string,
      )
      const partition = partitionFileRows(
        assignFileDedupKeys(parseResult.rows),
        existing,
      )

      return NextResponse.json({
        data: {
          parse_result: parseResult,
          file_hash: fileHash,
          filename: file.name,
          org_number_mismatch: orgNumberMismatch,
          duplicate_row_indexes: partition.duplicates.map((d) => d.index),
          promotion_row_indexes: partition.promotions.map((p) => p.index),
        },
      })
    } catch (err) {
      opLog.error('skattekonto file parse failed', err as Error)
      return errorResponseFromCode('SKATTEKONTO_FILE_PARSE_FAILED', opLog, {
        requestId,
        details: { reason: err instanceof Error ? getUserErrorMessage(err) : 'unknown' },
      })
    }
  },
)
