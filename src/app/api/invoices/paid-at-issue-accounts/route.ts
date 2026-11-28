import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateQuery } from '@/lib/api/validate'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { loadPaidAtIssueProviderAccounts, paidAtIssueOrderAccount } from '@/lib/invoices/paid-at-issue-accounts'

const QuerySchema = z.object({
  invoice_id: z.string().uuid().optional(),
})

/**
 * GET /api/invoices/paid-at-issue-accounts?invoice_id=
 *
 * What the kontantfaktura confirm offers (crm#2323, crm#2324):
 * provider_accounts, the accounts the company's webshop stores book a
 * payment method to, which a kontantfaktura may be paid to besides 19xx and
 * 1686; and order_account, for an invoice made from a paid webshop order,
 * the account that order's store books its payment method to (the confirm's
 * default), else null.
 */
export const GET = withRouteContext(
  'invoice.paid_at_issue_accounts',
  async (request, { supabase, companyId, log, requestId }) => {
    const query = validateQuery(request, QuerySchema, { log, operation: 'invoice.paid_at_issue_accounts' })
    if (!query.success) return query.response
    const invoiceId = query.data.invoice_id

    try {
      const [providerAccounts, orderAccount] = await Promise.all([
        loadPaidAtIssueProviderAccounts(supabase, companyId),
        invoiceId ? paidAtIssueOrderAccount(supabase, companyId, invoiceId) : Promise.resolve(null),
      ])
      return NextResponse.json({ data: { provider_accounts: providerAccounts, order_account: orderAccount } })
    } catch (err) {
      log.error('paid-at-issue accounts load failed', err as Error)
      return errorResponse(err, log, { requestId })
    }
  },
)
