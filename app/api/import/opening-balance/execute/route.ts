import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { validateBody } from '@/lib/api/validate'
import { OpeningBalanceExecuteSchema } from '@/lib/api/schemas'
import { createJournalEntry } from '@/lib/bookkeeping/engine'
import { isBookkeepingError } from '@/lib/bookkeeping/errors'
import {
  validateOpeningBalanceLines,
  activateMissingAccounts,
  buildOpeningBalanceEntryLines,
} from '@/lib/import/opening-balance/execute-helpers'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'

ensureInitialized()

/**
 * POST /api/import/opening-balance/execute
 *
 * Creates an opening balance journal entry from user-confirmed lines and
 * auto-activates BAS accounts not yet in the company's chart.
 */
export const POST = withRouteContext(
  'opening_balance.execute',
  async (request, ctx) => {
    const { user, supabase, companyId, log, requestId } = ctx

    const result = await validateBody(request, OpeningBalanceExecuteSchema, {
      log,
      operation: 'opening_balance.execute',
    })
    if (!result.success) return result.response

    const { fiscal_period_id, lines } = result.data
    const opLog = log.child({ fiscalPeriodId: fiscal_period_id })

    try {
      // 1. Verify fiscal period belongs to the company and is open.
      const { data: period, error: periodError } = await supabase
        .from('fiscal_periods')
        .select('*')
        .eq('id', fiscal_period_id)
        .eq('company_id', companyId)
        .single()

      if (periodError || !period) {
        return errorResponseFromCode('OB_PERIOD_NOT_FOUND', opLog, { requestId })
      }

      if (period.is_closed) {
        return errorResponseFromCode('OB_PERIOD_CLOSED', opLog, { requestId })
      }

      if (period.locked_at) {
        return errorResponseFromCode('OB_PERIOD_LOCKED', opLog, { requestId })
      }

      if (period.opening_balances_set) {
        return errorResponseFromCode('OB_PERIOD_ALREADY_HAS_BALANCES', opLog, {
          requestId,
          details: { existingEntryId: period.opening_balance_entry_id },
        })
      }

      // 2. Validate lines (drop zeros, ≥2 rows, no P&L accounts, must balance).
      const validation = validateOpeningBalanceLines(lines)
      if (!validation.ok) {
        return errorResponseFromCode(validation.code, opLog, {
          requestId,
          details:
            validation.code === 'OB_PNL_ACCOUNT'
              ? { accounts: validation.accounts }
              : validation.code === 'OB_UNBALANCED'
                ? { totalDebit: validation.totalDebit, totalCredit: validation.totalCredit, diff: validation.diff }
                : undefined,
        })
      }
      const { validLines, totalDebit, totalCredit } = validation

      // 3. Auto-activate BAS accounts not in the company's chart.
      const accountNumbers = [...new Set(validLines.map((l) => l.account_number))]
      const activation = await activateMissingAccounts(supabase, companyId!, user.id, accountNumbers)
      if (!activation.ok) {
        opLog.error('opening balance account activation failed', new Error(activation.reason))
        return errorResponseFromCode('OB_ACCOUNT_ACTIVATION_FAILED', opLog, {
          requestId,
          details: { reason: activation.reason },
        })
      }

      // 4. Create the opening balance journal entry.
      const entryLines = buildOpeningBalanceEntryLines(validLines)

      const entry = await createJournalEntry(supabase, companyId!, user.id, {
        fiscal_period_id,
        entry_date: period.period_start,
        description: 'Ingående balanser (Excel-import)',
        source_type: 'opening_balance',
        voucher_series: 'A',
        lines: entryLines,
      })

      // 5. Mark the fiscal period.
      await supabase
        .from('fiscal_periods')
        .update({
          opening_balance_entry_id: entry.id,
          opening_balances_set: true,
        })
        .eq('id', fiscal_period_id)
        .eq('company_id', companyId)

      return NextResponse.json({
        data: {
          success: true,
          journal_entry_id: entry.id,
          fiscal_period_id,
          lines_created: entryLines.length,
          total_debit: totalDebit,
          total_credit: totalCredit,
        },
      })
    } catch (err) {
      // Bookkeeping errors flow through the standard envelope; everything else
      // becomes OB_EXECUTE_FAILED so the user gets a Swedish toast.
      if (isBookkeepingError(err)) {
        return errorResponse(err, opLog, { requestId })
      }
      opLog.error('opening balance execute failed', err as Error)
      return errorResponseFromCode('OB_EXECUTE_FAILED', opLog, {
        requestId,
        details: { reason: err instanceof Error ? err.message : 'unknown' },
      })
    }
  },
  { requireWrite: true },
)
