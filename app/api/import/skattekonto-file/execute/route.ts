import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { SkattekontoFileExecuteSchema } from '@/lib/api/schemas'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { executeSkattekontoFileImport } from '@/lib/import/skattekonto-file/import-service'

/**
 * POST /api/import/skattekonto-file/execute
 *
 * Executes the import of confirmed skattekonto statement rows into
 * skattekonto_transactions. The route recomputes dedup keys and re-partitions
 * server-side (never trusts client-side duplicate indexes), records the
 * import in skattekonto_file_imports, and counts residual unique-constraint
 * conflicts as duplicates rather than failures.
 */
export const POST = withRouteContext(
  'skattekonto_file.execute',
  async (request, ctx) => {
    const { supabase, companyId, user, log, requestId } = ctx

    const validation = await validateBody(request, SkattekontoFileExecuteSchema)
    if (!validation.success) return validation.response
    const { rows, filename, file_hash, variant, closing_saldo } = validation.data

    const dates = rows.map((r) => r.transaktionsdatum).sort()
    const opLog = log.child({ filename, fileHash: file_hash, rowCount: rows.length })

    try {
      const { data: importRecord, error: importError } = await supabase
        .from('skattekonto_file_imports')
        .upsert(
          {
            company_id: companyId,
            user_id: user.id,
            filename,
            file_hash,
            file_variant: variant,
            row_count: rows.length,
            date_from: dates[0],
            date_to: dates[dates.length - 1],
            closing_saldo: closing_saldo ?? null,
            status: 'processing',
          },
          { onConflict: 'company_id,file_hash' },
        )
        .select()
        .single()

      if (importError || !importRecord) {
        opLog.error(
          'failed to create skattekonto_file_imports record',
          importError ?? new Error('no record returned'),
        )
        return errorResponseFromCode('SKATTEKONTO_FILE_IMPORT_RECORD_FAILED', opLog, {
          requestId,
          details: { reason: importError ? getUserErrorMessage(importError) : 'unknown' },
        })
      }

      const outcome = await executeSkattekontoFileImport(
        supabase,
        companyId,
        importRecord.id,
        rows,
      )

      if (outcome.errors > 0) {
        opLog.error('skattekonto file import reported row errors', new Error(outcome.first_error ?? 'unknown'), {
          errorCount: outcome.errors,
        })
      }

      const { error: statusError } = await supabase
        .from('skattekonto_file_imports')
        .update({
          imported_count: outcome.imported,
          duplicate_count: outcome.duplicates,
          promoted_count: outcome.promoted,
          status: outcome.errors > 0 && outcome.imported === 0 ? 'failed' : 'completed',
          error_message:
            outcome.errors > 0
              ? `${outcome.errors} rader kunde inte importeras: ${outcome.first_error ?? ''}`
              : null,
        })
        .eq('id', importRecord.id)
      if (statusError) {
        // The rows are written; only the record would misreport "processing".
        opLog.error('failed to finalize skattekonto_file_imports record', statusError)
      }

      return NextResponse.json({
        data: {
          import_id: importRecord.id,
          imported: outcome.imported,
          duplicates: outcome.duplicates,
          promoted: outcome.promoted,
          errors: outcome.errors,
          date_from: dates[0],
          date_to: dates[dates.length - 1],
          closing_saldo: closing_saldo ?? null,
        },
      })
    } catch (err) {
      opLog.error('skattekonto file execute failed', err as Error)
      return errorResponseFromCode('SKATTEKONTO_FILE_EXECUTE_FAILED', opLog, {
        requestId,
        details: { reason: err instanceof Error ? getUserErrorMessage(err) : 'unknown' },
      })
    }
  },
  { requireWrite: true },
)
