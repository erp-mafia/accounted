import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateQuery } from '@/lib/api/validate'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { getLatePaymentInterestReport } from '@/lib/invoices/late-payment-interest-report'
import { latePaymentInterestInputSchema } from '@/lib/operations/late-payment-interest'

/**
 * GET /api/invoices/late-payment-interest: dröjsmålsränta per customer
 * invoice for the Dröjsmålsränta page. The same answer as the v1 door
 * (invoices.late-payment-interest.get). `?as_of=YYYY-MM-DD`, default today.
 */
export const GET = withRouteContext('invoices.late_payment_interest', async (request, { supabase, companyId, log }) => {
  const query = validateQuery(request, latePaymentInterestInputSchema, {
    log,
    operation: 'invoices.late_payment_interest',
  })
  if (!query.success) return query.response

  const report = await getLatePaymentInterestReport(supabase, companyId, query.data.as_of ?? todayIsoStockholm())
  return NextResponse.json({ data: report })
})
