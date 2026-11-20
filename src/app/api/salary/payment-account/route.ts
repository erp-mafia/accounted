import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateQuery } from '@/lib/api/validate'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { loadPaymentFileAccountView } from '@/lib/salary/payment/payment-account'

const PaymentAccountQuery = z.object({ run_id: z.string().uuid().optional() })

/**
 * GET /api/salary/payment-account[?run_id=<uuid>]
 *
 * The bank account the payment files pay from, as the dashboard shows it
 * (crm#1483): the account summary (name, ledger account, last four of the
 * IBAN), whether a pain.001 can be made from it, the bank whose upload
 * instructions open first, and whether Swedbank's or Nordea's ids are needed. With
 * run_id, a booked run answers the account its salary verifikat credits;
 * without, the primary bank account. Reads only.
 */
export const GET = withRouteContext(
  'salary.payment_account',
  async (request, { supabase, companyId, log, requestId }) => {
    const query = validateQuery(request, PaymentAccountQuery)
    if (!query.success) return query.response

    const result = await loadPaymentFileAccountView(supabase, companyId, log, query.data.run_id ?? null)
    if (!result.ok) return errorResponseFromCode(result.code, log, { requestId })

    return NextResponse.json({ data: result.view })
  },
)
