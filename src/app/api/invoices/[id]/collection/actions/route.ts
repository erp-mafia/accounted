import { NextResponse } from 'next/server'
import { z } from 'zod'
import { collectionsActionSchema } from '@accounted/connect-contract'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { runCaseAction } from '@/lib/collections/case-actions'
import { caseView, loadCaseEvents } from '@/lib/collections/case'
import { caseRefusalResponse, webCaseServiceDeps } from '@/lib/collections/case-routes'
import { readCollectionsEnv } from '@/lib/collections/flags'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { ensureInitialized } from '@/lib/init'

// Actions emit collection.case_updated and collection.case_closed.
ensureInitialized()

export const maxDuration = 60

const ParamsSchema = z.object({ id: z.uuid() })

const ActionBodySchema = z.object({
  action: collectionsActionSchema,
  step: z.enum(['reminder', 'collection']).nullable().optional(),
  message: z.string().max(2000).nullable().optional(),
  until: z.iso.date().nullable().optional(),
  bank_attested: z.boolean().optional(),
  dismissed_transaction_ids: z.array(z.uuid()).max(200).optional(),
  /** withdraw: the person saw the fee line (the provider may charge after its free days). */
  fee_acknowledged: z.boolean().optional(),
})

/**
 * POST /api/invoices/[id]/collection/actions: an action on the invoice's
 * open case (pause, optionally until a date; resume; withdraw, confirming
 * the fee once the provider's free days have passed; dispute; contest; the
 * decisions the provider waits for; starting reminders on a delivered
 * invoice). Only the actions the provider's last snapshot offers are
 * accepted. Starting, approving the next step and "it is not paid" re-check
 * that the invoice is owed and unpaid in the bank; everything else serves
 * the open case whatever the start gates say. "The customer has paid" is
 * answered by booking the payment, never sent as an action.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'invoice.collection.action',
  async (request, ctx, { params }) => {
    const parsed = ParamsSchema.safeParse(await params)
    if (!parsed.success) return errorResponseFromCode('VALIDATION_ERROR', ctx.log, { requestId: ctx.requestId })
    const body = await validateBody(request, ActionBodySchema, { log: ctx.log, operation: 'invoice.collection.action' })
    if (!body.success) return body.response

    const deps = await webCaseServiceDeps(ctx, readCollectionsEnv())
    const outcome = await runCaseAction(deps, {
      invoiceId: parsed.data.id,
      action: body.data.action,
      step: body.data.step ?? null,
      message: body.data.message ?? null,
      until: body.data.until ?? null,
      attestations: { bank: body.data.bank_attested },
      dismissedTransactionIds: body.data.dismissed_transaction_ids,
      feeAcknowledged: body.data.fee_acknowledged,
    })
    if (!outcome.ok) return caseRefusalResponse(outcome, ctx)
    if (outcome.dryRun) return NextResponse.json({ data: { preview: outcome.preview } })
    const events = await loadCaseEvents(deps.db, outcome.case.id)
    return NextResponse.json({ data: { case: caseView(outcome.case, events) } })
  },
  { requireWrite: true },
)
