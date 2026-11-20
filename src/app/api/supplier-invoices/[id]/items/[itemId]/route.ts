import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { SupplierInvoiceItemAccountSchema } from '@/lib/api/schemas'
import { moveSupplierInvoiceItemAccount } from '@/lib/supplier-invoices/item-account'
import { sessionFailureResponse } from '@/lib/operations/session'

export { planAccountMove } from '@/lib/supplier-invoices/item-account'

/**
 * PATCH /api/supplier-invoices/[id]/items/[itemId]: move the line to another
 * expense account, the way a category chip works on a transaction. While the
 * invoice is unsettled and its registration verifikat is posted in an open
 * period, the verifikat is corrected inline in the same call; the item row
 * is updated first so a refused correction leaves both sides untouched.
 * Rules live in lib/supplier-invoices/item-account.ts, shared with v1
 * supplier-invoices.update-item-account.
 */
export const PATCH = withRouteContext<{ params: Promise<{ id: string; itemId: string }> }>(
  'supplier_invoice.item.account',
  async (request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id, itemId } = await params
    const validated = await validateBody(request, SupplierInvoiceItemAccountSchema, { log, operation: 'supplier_invoice.item.account' })
    if (!validated.success) return validated.response

    const outcome = await moveSupplierInvoiceItemAccount(
      { supabase, companyId, userId: user.id, log },
      id,
      itemId,
      validated.data.account_number,
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
