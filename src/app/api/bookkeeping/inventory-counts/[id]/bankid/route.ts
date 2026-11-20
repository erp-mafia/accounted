import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { sessionFailureResponse } from '@/lib/operations/session'
import { stockCountEnabledFor } from '@/lib/env/stock-count-switch'
import { requestStockCountBankIdSignature } from '@/lib/bokslut/stock-count/signing'
import { BankIdStockCountSchema } from '@/lib/bokslut/stock-count/schemas'
import { stockCountDisabledResponse, stockCountErrorResponse } from '@/lib/bokslut/stock-count/route-errors'

type Params = { params: Promise<{ id: string }> }

/**
 * POST /api/bookkeeping/inventory-counts/[id]/bankid: send the list for
 * BankID signing "på heder och samvete" (LIV 2 §), where BankID signing is
 * open for the company (SIGNING_ENABLED and the plan). The PDF is archived
 * and the member asking is the signer; the answer carries their link when
 * no mail went out. The count is frozen while the request runs and signed
 * when it completes.
 */
export const POST = withRouteContext<Params>(
  'bookkeeping.inventory-counts.bankid',
  async (request, ctx, { params }) => {
    if (!stockCountEnabledFor(ctx.companyId)) return stockCountDisabledResponse(ctx)
    const { id } = await params
    const body = await validateBody(request, BankIdStockCountSchema, { log: ctx.log, operation: 'bookkeeping.inventory-counts.bankid' })
    if (!body.success) return body.response
    try {
      const outcome = await requestStockCountBankIdSignature(
        { supabase: ctx.supabase, companyId: ctx.companyId, userId: ctx.user.id, log: ctx.log },
        id,
        { signerName: body.data.signer_name, email: body.data.email ?? null },
      )
      if (!outcome.ok) return sessionFailureResponse(outcome, ctx.log, ctx.requestId)
      if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
      return NextResponse.json({ data: outcome.data }, { status: 201 })
    } catch (err) {
      const response = stockCountErrorResponse(err, ctx)
      if (response) return response
      throw err
    }
  },
  { requireWrite: true },
)
