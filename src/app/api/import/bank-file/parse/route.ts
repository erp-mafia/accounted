import { NextResponse } from 'next/server'
import { parseBankFile, generateFileHash, detectFileFormat } from '@/lib/import/bank-file/parser'
import { detectSkattekontoFile } from '@/lib/import/skattekonto-file/parser'
import { detectBgMax } from '@/lib/import/bgmax/parser'
import { decodeFileContent } from '@/lib/import/shared/encoding'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import type { BankFileFormatId } from '@/lib/import/bank-file/types'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { loadFileAccountMatch, type FileAccountMatch } from '@/lib/cash-accounts/file-account'
import { dominantCurrency } from '@/lib/import/bank-file/currency-summary'

/**
 * POST /api/import/bank-file/parse
 *
 * Accepts a bank file (CSV/XML) via FormData, auto-detects format, and returns
 * a parsed transactions preview with duplicate detection.
 */
export const POST = withRouteContext(
  'bank_file.parse',
  async (request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx

    const formData = await request.formData()
    const file = formData.get('file') as File | null
    const formatOverride = formData.get('format') as BankFileFormatId | null

    if (!file) {
      return errorResponseFromCode('BANK_FILE_NO_FILE', log, { requestId })
    }

    if (file.size > 10 * 1024 * 1024) {
      return errorResponseFromCode('BANK_FILE_TOO_LARGE', log, {
        requestId,
        details: { sizeMb: +(file.size / 1024 / 1024).toFixed(1) },
      })
    }

    const opLog = log.child({ filename: file.name, sizeBytes: file.size })

    try {
      const arrayBuffer = await file.arrayBuffer()
      const content = decodeFileContent(arrayBuffer)

      // Bankgirot's deposit specification (BG Max) is not a statement: its
      // deposits are bank rows that already exist, so it never creates rows.
      // The wizard sends it to the deposit-specification route, which
      // attaches each deposit's payments to its row (crm#1170). No format
      // override reaches past this: parsed as a statement it would only
      // create rows that double the deposits.
      if (detectBgMax(content)) {
        return errorResponseFromCode('BANK_FILE_DEPOSIT_SPEC_DETECTED', opLog, { requestId })
      }

      const fileHash = generateFileHash(content)

      const { data: existingImport } = await supabase
        .from('bank_file_imports')
        .select('id, status, imported_count, created_at')
        .eq('company_id', companyId)
        .eq('file_hash', fileHash)
        .single()

      if (existingImport && existingImport.status === 'completed') {
        return errorResponseFromCode('BANK_FILE_DUPLICATE', opLog, {
          requestId,
          details: {
            importId: existingImport.id,
            importedCount: existingImport.imported_count,
            importedAt: existingImport.created_at,
          },
        })
      }

      // A skattekontoutdrag is not a bank statement: its rows belong on the
      // skattekonto (1630), not on a bank account. Redirect the user to the
      // dedicated importer. An explicit format override still forces a bank
      // parse as the escape hatch.
      if (!formatOverride && detectSkattekontoFile(content, file.name)) {
        return errorResponseFromCode('BANK_FILE_SKATTEKONTO_DETECTED', opLog, { requestId })
      }

      const detectedFormat = formatOverride
        ? null
        : detectFileFormat(content, file.name)

      const parseResult = parseBankFile(content, file.name, formatOverride || undefined)

      // The cash account the file's own account already is (crm#1204): the
      // wizard pre-selects it and execute refuses any other. Advisory here: a
      // failed read leaves the choice to the user, and execute reads again.
      let accountMatch: FileAccountMatch | null = null
      try {
        accountMatch = await loadFileAccountMatch(
          supabase, companyId, parseResult.account, dominantCurrency(parseResult.transactions),
        )
      } catch (err) {
        opLog.warn('bank file account match failed', err as Error)
      }

      // Per-row duplicate detection deliberately does NOT live here: the
      // wizard calls POST /api/import/bank-file/check-duplicates after every
      // (re-)parse, including the client-side generic_csv re-parse that never
      // hits this route. The old existing_transaction_count field (a raw count
      // of ALL transactions in the date range) was consumed by nothing and has
      // been removed.
      return NextResponse.json({
        data: {
          parse_result: parseResult,
          detected_format: detectedFormat?.id || formatOverride || null,
          detected_format_name: detectedFormat?.name || parseResult.format_name,
          file_hash: fileHash,
          filename: file.name,
          account_match: accountMatch,
          headers: parseResult.format === 'generic_csv'
            ? content.split('\n')[0]?.split(',').map((h) => h.trim()) || []
            : null,
        },
      })
    } catch (err) {
      opLog.error('bank file parse failed', err as Error)
      return errorResponseFromCode('BANK_FILE_PARSE_FAILED', opLog, {
        requestId,
        details: { reason: err instanceof Error ? getUserErrorMessage(err) : 'unknown' },
      })
    }
  },
)
