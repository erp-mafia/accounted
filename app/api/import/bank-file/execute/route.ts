import { NextResponse } from 'next/server'
import { eventBus } from '@/lib/events'
import { ensureInitialized } from '@/lib/init'
import { ingestTransactions } from '@/lib/transactions/ingest'
import type { RawTransaction } from '@/types'
import { generateExternalId } from '@/lib/import/bank-file/parser'
import type { IngestOptions } from '@/types'
import { getCompanyRole } from '@/lib/auth/require-write'
import { ensureManualCashAccount } from '@/lib/cash-accounts/service'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import type { ParsedBankTransaction, BankFileFormatId } from '@/lib/import/bank-file/types'
import type { Transaction } from '@/types'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import {
  runUnattendedReconciliationSweep,
  toSweepSummary,
} from '@/lib/reconciliation/unattended-sweep'

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

/** The currency most rows of the file are denominated in ('SEK' when none say). */
function dominantCurrency(transactions: ParsedBankTransaction[]): string {
  const counts = new Map<string, number>()
  for (const tx of transactions) {
    const currency = (tx.currency || 'SEK').toUpperCase()
    counts.set(currency, (counts.get(currency) ?? 0) + 1)
  }
  let best = 'SEK'
  let bestCount = 0
  for (const [currency, count] of counts) {
    if (count > bestCount) {
      best = currency
      bestCount = count
    }
  }
  return best
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

    // The wizard offers any active 19xx chart account, but a row only binds to
    // a cash_accounts row (ingestTransactions looks the ledger up and tolerates
    // a miss). Without this step a picked ledger with no cash account was
    // silently dropped: every row stayed unbound and the booking dialog fell
    // back to 1930. Find or create the manual row first, before any import
    // record exists, so a refused account leaves nothing behind.
    if (settlement_account !== undefined) {
      if (typeof settlement_account !== 'string' || !/^19\d{2}$/.test(settlement_account)) {
        return errorResponseFromCode('BANK_FILE_INVALID_SETTLEMENT_ACCOUNT', opLog, { requestId })
      }
      // The ledger must be an active class 19 account in this company's own
      // chart, the same set the wizard offers: a cash account on a ledger the
      // chart does not know would strand every row at booking time.
      const { data: chartRow, error: chartError } = await supabase
        .from('chart_of_accounts')
        .select('account_number')
        .eq('company_id', companyId)
        .eq('account_number', settlement_account)
        .eq('is_active', true)
        .maybeSingle()
      if (chartError) {
        opLog.error('settlement account chart lookup failed', chartError, {
          settlementAccount: settlement_account,
        })
        return errorResponseFromCode('BANK_FILE_EXECUTE_FAILED', opLog, {
          requestId,
          details: { reason: getUserErrorMessage(chartError) },
        })
      }
      if (!chartRow) {
        return errorResponseFromCode('BANK_FILE_INVALID_SETTLEMENT_ACCOUNT', opLog, {
          requestId,
          details: { account: settlement_account },
        })
      }
      // One file is one physical account, so its rows share that account's
      // currency. Wise and camt.053 files can still carry a few rows in
      // another currency; the account is denominated in the one most rows
      // use, exactly as ingest binds every row of a batch to one account.
      const batchCurrency = dominantCurrency(transactions)
      try {
        // Named after the ledger, not the currency: two manual accounts in
        // the same currency must stay distinguishable in the account pickers.
        await ensureManualCashAccount(
          supabase, companyId, settlement_account, batchCurrency, `Bankkonto ${settlement_account}`,
        )
      } catch (err) {
        opLog.error('settlement cash account unavailable', err as Error, {
          settlementAccount: settlement_account,
          currency: batchCurrency,
        })
        return errorResponseFromCode('BANK_FILE_SETTLEMENT_ACCOUNT_UNAVAILABLE', opLog, {
          requestId,
          details: {
            account: settlement_account,
            reason: err instanceof Error ? getUserErrorMessage(err) : 'unknown',
          },
        })
      }
    }

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
        }, { onConflict: 'company_id,file_hash' })
        .select()
        .single()

      if (importError) {
        opLog.error('failed to create bank_file_imports record', importError)
        return errorResponseFromCode('BANK_FILE_IMPORT_RECORD_FAILED', opLog, {
          requestId,
          details: { reason: getUserErrorMessage(importError) },
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

      // Detect SIE overlap, mirroring the enable-banking sync paths: a bank
      // file covering a period a completed SIE import already booked must be
      // matched against the imported verifikat, not re-booked. CSV is the only
      // way a migrator gets deep history (PSD2 windows stop at ~90 days), so
      // this path is the primary one for the Fortnox/SIE migrator journey.
      const fileDateFrom = transactions.map((t) => t.date).sort()[0] || undefined
      const fileDateTo = transactions.map((t) => t.date).sort().reverse()[0] || undefined
      let sieOverlap: { id: string } | null = null
      if (fileDateFrom) {
        const { data } = await supabase
          .from('sie_imports')
          .select('id')
          .eq('company_id', companyId)
          .eq('status', 'completed')
          .gte('fiscal_year_end', fileDateFrom)
          .limit(1)
          .maybeSingle()
        sieOverlap = data ?? null
      }

      const ingestOptions: IngestOptions = {
        // Stamp every inserted row with this batch so the owner/admin
        // "undo this import" action can scope its bulk delete exactly.
        bankFileImportId: importRecord.id,
      }
      if (settlement_account) ingestOptions.settlementAccount = settlement_account
      if (role === 'viewer') ingestOptions.rawInsertOnly = true
      if (sieOverlap) ingestOptions.skipAutoCategorization = true
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

      // SIE-overlap-gated reconciliation sweep (issue: no sweep fired after a
      // bank CSV import, yet CSV is how a migrator gets pre-PSD2 history). One
      // scoped run per enabled cash account; >= 0.9 auto-links, the 0.75-0.89
      // band persists as reviewable suggestions. Viewers skip it: the sweep
      // updates transactions, which viewers cannot do.
      if (sieOverlap && ingestResult.imported > 0 && role !== 'viewer') {
        try {
          const sweepResult = await runUnattendedReconciliationSweep(supabase, companyId, user.id, {
            dateFrom: fileDateFrom,
            dateTo: fileDateTo,
          })
          const { error: stampError } = await supabase
            .from('bank_file_imports')
            .update({
              sie_sweep: toSweepSummary(sweepResult, {
                dateFrom: fileDateFrom,
                dateTo: fileDateTo,
              }),
            })
            .eq('id', importRecord.id)
          if (stampError) {
            // The links/suggestions are already written; only the UI summary
            // is missing. Say so instead of letting the sweep look unrun.
            opLog.warn('failed to stamp sie_sweep summary on bank_file_imports', stampError)
          }
          if (sweepResult.applied > 0 || sweepResult.suggested > 0) {
            opLog.info('post-import SIE reconciliation sweep', {
              applied: sweepResult.applied,
              suggested: sweepResult.suggested,
              unmatched: sweepResult.unmatched,
            })
          }
        } catch (err) {
          // Non-critical: rows stay in "Att bokföra" for manual matching.
          opLog.warn('post-import SIE reconciliation sweep failed', err as Error)
        }
      }

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
        details: { reason: err instanceof Error ? getUserErrorMessage(err) : 'unknown' },
      })
    }
  },
)
