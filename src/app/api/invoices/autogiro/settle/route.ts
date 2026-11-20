import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { attachBgMaxDeposits } from '@/lib/import/bgmax/attach'
import { depositsFromOwnDebits, markDebitsDebited } from '@/lib/invoices/autogiro/import-report'

/**
 * POST /api/invoices/autogiro/settle: settles the debits whose payment day
 * has come without Bankgirot's report, for a company that reads its reports
 * in Autogiro Online. Each day's debits are offered to the bank rows as one
 * deposit (lib/import/bgmax/attach.ts); a row with exactly that amount takes
 * them, each invoice gets its payment suggested by OCR, and those debits
 * become debited. A day where one debit failed has another sum and waits for
 * the report.
 */
export const POST = withRouteContext(
  'autogiro.settle',
  async (_request, { supabase, companyId, user, log, requestId }) => {
    const own = await depositsFromOwnDebits(supabase, companyId, todayIsoStockholm())
    if ('ok' in own) return errorResponseFromCode(own.code, log, { requestId, details: own.details })
    if (own.deposits.length === 0) {
      return NextResponse.json({ data: { days: 0, matched_days: 0, debited: 0, ready_rows: 0, no_row: 0, ambiguous: 0 } })
    }
    const summary = await attachBgMaxDeposits(supabase, { companyId, userId: user.id, deposits: own.deposits, apply: true })
    let debited = 0
    for (let i = 0; i < summary.outcomes.length; i++) {
      if (summary.outcomes[i]!.status !== 'matched') continue
      await markDebitsDebited(supabase, companyId, own.debitIds[i]!, own.deposits[i]!.date)
      debited += own.debitIds[i]!.length
    }
    log.info('autogiro settled from own debits', { days: own.deposits.length, matched: summary.matched_deposits, debited })
    return NextResponse.json({
      data: {
        days: own.deposits.length,
        matched_days: summary.matched_deposits,
        debited,
        ready_rows: summary.ready_rows,
        no_row: summary.no_row,
        ambiguous: summary.ambiguous,
      },
    })
  },
  { requireWrite: true },
)
