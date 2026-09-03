import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { SetInvoicePayeeDefaultSchema } from '@/lib/api/schemas'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { loadInvoicePayeeState, setInvoicePayeeDefault } from '@/lib/cash-accounts/invoice-payee'
import { getCompanyRole } from '@/lib/auth/require-write'

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
 * company_settings map from the chosen account.
 */
export const PUT = withRouteContext(
  'cash_accounts.payee_defaults.set',
  async (request, { supabase, companyId, log, requestId, user }) => {
    const validation = await validateBody(request, SetInvoicePayeeDefaultSchema)
    if (!validation.success) return validation.response
    const { currency, cash_account_id } = validation.data

    const roleResult = await getCompanyRole(supabase, user.id, { companyId })
    if (!roleResult.ok) return roleResult.response
    if (!['owner', 'admin'].includes(roleResult.role)) {
      return errorResponseFromCode('FORBIDDEN', log, {
        requestId,
        details: { required_roles: ['owner', 'admin'] },
      })
    }

    if (cash_account_id) {
      const { data: account, error } = await supabase
        .from('cash_accounts')
        .select('id, invoice_payee, enabled')
        .eq('company_id', companyId)
        .eq('id', cash_account_id)
        .maybeSingle()
      if (error) {
        log.error('invoice payee default account lookup failed', error)
        return errorResponse(error, log, { requestId })
      }
      if (!account) {
        return NextResponse.json(
          {
            error: {
              code: 'CASH_ACCOUNT_NOT_FOUND',
              message: 'Bankkontot hittades inte.',
              message_en: 'Bank account not found.',
            },
          },
          { status: 404 },
        )
      }
    }

    try {
      await setInvoicePayeeDefault(supabase, companyId, currency, cash_account_id)
      const state = await loadInvoicePayeeState(supabase, companyId)
      return NextResponse.json({ data: state })
    } catch (err) {
      log.error('invoice payee default set failed', err as Error)
      return errorResponse(err, log, { requestId })
    }
  },
  { requireWrite: true },
)
