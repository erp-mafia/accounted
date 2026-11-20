import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { loadBooksFindings } from '@/lib/onboarding/findings'
import { todayIsoStockholm } from '@/lib/dates/iso'

/**
 * GET /api/onboarding/findings
 *
 * The Genomlysning behind the books act (issue #2438): entries, periods,
 * latest-year revenue and result, overdue invoices, VAT balance, bank and
 * Skatteverket connection state with their first verdict numbers. Read-only.
 */
export const GET = withRouteContext(
  'onboarding-findings.get',
  async (_request, { supabase, companyId, user, log, requestId }) => {
    try {
      const data = await loadBooksFindings(supabase, companyId, todayIsoStockholm(), user.id)
      return NextResponse.json({ data })
    } catch (error) {
      log.error('books findings failed', error as Error)
      return errorResponseFromCode('INTERNAL_ERROR', log, {
        requestId,
        details: { reason: getErrorMessage(error) },
      })
    }
  },
)
