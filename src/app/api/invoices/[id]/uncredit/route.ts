import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { UncreditInvoiceSchema } from '@/lib/api/schemas'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { sessionFailureResponse } from '@/lib/operations/session'
import { uncreditInvoice } from '@/lib/invoices/uncredit-invoice'

/**
 * POST /api/invoices/[id]/uncredit: "Ångra kreditering" of a customer
 * invoice whose credit note never reached the customer. Body
 * { dry_run?, attest_not_delivered? }. The dry run answers what the undo
 * would do (the delivery it found, whether the person must attest, the
 * storno) and writes nothing. The rules live in
 * lib/invoices/uncredit-invoice.ts.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'invoice.uncredit',
  async (request, { supabase, user, companyId, log, requestId }, { params }) => {
    const { id } = await params
    if (!z.string().uuid().safeParse(id).success) {
      return errorResponseFromCode('VALIDATION_ERROR', log, {
        requestId,
        details: { field: 'id', message: 'Invoice id must be a UUID.' },
      })
    }

    const validation = await validateBody(request, UncreditInvoiceSchema, { log, operation: 'invoice.uncredit' })
    if (!validation.success) return validation.response

    const outcome = await uncreditInvoice(
      { supabase, companyId: companyId!, userId: user.id, log },
      id,
      { attestNotDelivered: validation.data.attest_not_delivered === true },
      { dryRun: validation.data.dry_run === true },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({
      data: outcome.data.invoice,
      changed: outcome.data.changed,
      credit_note_id: outcome.data.credit_note_id,
      reversal_entry_id: outcome.data.reversal_entry_id,
    })
  },
  { requireWrite: true },
)
