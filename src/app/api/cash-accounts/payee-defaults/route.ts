import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { SetInvoicePayeeDefaultSchema } from '@/lib/api/schemas'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { loadInvoicePayeeState } from '@/lib/cash-accounts/invoice-payee'
import { setCashAccountPayeeDefault } from '@/lib/cash-accounts/manage'
import { sessionFailureResponse } from '@/lib/operations/session'

/**
 * GET /api/cash-accounts/payee-defaults
 *
 * The company's bank accounts together with which one an invoice in each
 * currency prints as payee when the invoice does not choose.
 */
export const GET = withRouteContext(
  'cash_accounts.payee_defaults.list',
  async (_request, { supabase, companyId, log, requestId }) => {
    try {
      const state = await loadInvoicePayeeState(supabase, companyId)
      return NextResponse.json({ data: state })
    } catch (err) {
      log.error('invoice payee defaults load failed', err as Error)
      return errorResponse(err, log, { requestId })
    }
  },
)

/**
 * PUT /api/cash-accounts/payee-defaults
 *
 * Set (or clear with null) the default payee account for one currency.
 * Owner/admin only: this decides where every new invoice in that currency
 * tells the customer to pay. The mirror trigger rewrites the legacy
 * company_settings map from the chosen account. The rules live in
 * lib/cash-accounts/manage.ts, shared with the v1 operation
 * cash-accounts.set-payee-default and gnubok_set_invoice_payee_default.
 */
export const PUT = withRouteContext(
  'cash_accounts.payee_defaults.set',
  async (request, { supabase, companyId, log, requestId, user }) => {
    const validation = await validateBody(request, SetInvoicePayeeDefaultSchema)
    if (!validation.success) return validation.response

    const outcome = await setCashAccountPayeeDefault({ supabase, companyId, userId: user.id, log }, validation.data)
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
