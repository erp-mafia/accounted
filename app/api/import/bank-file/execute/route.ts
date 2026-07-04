import { NextResponse } from 'next/server'
import { eventBus } from '@/lib/events'
import { ensureInitialized } from '@/lib/init'
import { ingestTransactions, type RawTransaction } from '@/lib/transactions/ingest'
import { generateExternalId } from '@/lib/import/bank-file/parser'
import type { IngestOptions } from '@/types'
import { getCompanyRole } from '@/lib/auth/require-write'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import type { ParsedBankTransaction, BankFileFormatId } from '@/lib/import/bank-file/types'
import type { Transaction } from '@/types'

ensureInitialized()

// Bank-file imports run a sequential, per-row ingest (insert + invoice/supplier
// matching + FX lookup). A full-year file (300+ rows) takes ~85s of server time,
// which sits right on the platform's default function limit and gets killed
// mid-run: the import "spins then aborts" for the user. Give it the same 5-minute
// budget the SIE import route uses (app/api/import/sie/execute/route.ts).
export const maxDuration = 300

interface ExecuteRequest {
  transactions: ParsedBankTransaction[]
  format: BankFileFormatId
  filename: string
  file_hash: string
  skip_duplicates: boolean
  auto_categorize: boolean
  settlement_account?: string
}

/**
 * POST /api/import/bank-file/execute
 *
 * Executes the import of confirmed bank transactions. Records the import in
 * `bank_file_imports`, calls `ingestTransactions`, and emits `transaction.synced`.
 */
export const POST = withRouteContext(
  'bank_file.execute',
  async (request, ctx) => {
    const { user, supabase, log, requestId } = ctx

    // We still call getCompanyRole because viewers are allowed through with
    // rawInsertOnly behavior: `requireWrite: true` would block them.
    const roleCheck = await getCompanyRole(supabase, user.id)
    if (!roleCheck.ok) {
      // Inject the request id for traceability and pass through.
      if (!roleCheck.response.headers.get('X-Request-Id')) {
        roleCheck.response.headers.set('X-Request-Id', requestId)
      }
      return roleCheck.response
    }
    const { role, companyId } = roleCheck

    const body: ExecuteRequest = await request.json()
    const {
      transactions, format, filename, file_hash,
      skip_duplicates: _skip_duplicates = true,
      auto_categorize: _auto_categorize = true,
      settlement_account,
    } = body

    if (!transactions || transactions.length === 0) {
      return errorResponseFromCode('BANK_FILE_NO_TRANSACTIONS', log, { requestId })
    }

    const opLog = log.child({ filename, fileHash: file_hash, txCount: transactions.length })

    try {
      const { data: importRecord, error: importError } = await supabase
        .from('bank_file_imports')
        .upsert({
          user_id: user.id,
          company_id: companyId,
          filename,
          file_hash,
          file_format: format,
          transaction_count: transactions.length,
          status: 'processing',
          date_from: transactions.map((t) => t.date).sort()[0] || null,
          date_to: transactions.map((t) => t.date).sort().reverse()[0] || null,
        }, { onConflict: 'user_id,file_hash' })
        .select()
        .single()

      if (importError) {
        opLog.error('failed to create bank_file_imports record', importError)
        return errorResponseFromCode('BANK_FILE_IMPORT_RECORD_FAILED', opLog, {
          requestId,
          details: { reason: importError.message },
        })
      }

      const rawTransactions: RawTransaction[] = transactions.map((tx, index) => ({
        date: tx.date,
        description: tx.description,
        amount: tx.amount,
        currency: tx.currency || 'SEK',
        external_id: generateExternalId(tx, format, index),
        reference: tx.reference || null,
        import_source: format === 'camt053' ? 'camt053' : `csv_${format}`,
      }))

      const ingestOptions: IngestOptions = {}
      if (settlement_account) ingestOptions.settlementAccount = settlement_account
      if (role === 'viewer') ingestOptions.rawInsertOnly = true
      const ingestResult = await ingestTransactions(supabase, companyId, user.id, rawTransactions, ingestOptions)

      if (ingestResult.errors > 0 && ingestResult.first_error) {
        opLog.error('bank file ingest reported insert errors', new Error(ingestResult.first_error.message), {
          errorCount: ingestResult.errors,
          code: ingestResult.first_error.code,
          details: ingestResult.first_error.details,
          hint: ingestResult.first_error.hint,
        })
      }

      const errorMessage = ingestResult.errors > 0
        ? ingestResult.first_error
          ? `${ingestResult.errors} fel: ${ingestResult.first_error.message}${ingestResult.first_error.details ? ` (${ingestResult.first_error.details})` : ''}`
          : `${ingestResult.errors} transactions failed to import`
        : null

      await supabase
        .from('bank_file_imports')
        .update({
          imported_count: ingestResult.imported,
          duplicate_count: ingestResult.duplicates,
          matched_count: ingestResult.auto_matched_invoices,
          status: ingestResult.errors > 0 && ingestResult.imported === 0 ? 'failed' : 'completed',
          error_message: errorMessage,
        })
        .eq('id', importRecord.id)

      if (ingestResult.imported > 0 && ingestResult.transaction_ids.length > 0) {
        try {
          const { data: importedTransactions } = await supabase
            .from('transactions')
            .select('*')
            .in('id', ingestResult.transaction_ids)

          if (importedTransactions && importedTransactions.length > 0) {
            await eventBus.emit({
              type: 'transaction.synced',
              payload: {
                transactions: importedTransactions as Transaction[],
                userId: user.id,
                companyId,
              },
            })
          }
        } catch (err) {
          opLog.warn('transaction.synced event emission failed', err as Error)
        }
      }

      return NextResponse.json({
        data: {
          import_id: importRecord.id,
          ...ingestResult,
        },
      })
    } catch (err) {
      opLog.error('bank file execute failed', err as Error)
      return errorResponseFromCode('BANK_FILE_EXECUTE_FAILED', opLog, {
        requestId,
        details: { reason: err instanceof Error ? err.message : 'unknown' },
      })
    }
  },
)
