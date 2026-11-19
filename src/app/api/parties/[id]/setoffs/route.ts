import { NextResponse } from 'next/server'
import { z } from 'zod'
import { validateBody } from '@/lib/api/validate'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { counterpartySetoffEnabled } from '@/lib/env/counterparty-setoff-switch'
import { bookCounterpartySetoff } from '@/lib/invoices/counterparty-setoff/book'
import { resolveCanonicalParties } from '@/lib/invoices/counterparty-setoff/state'
import { isoDateSchema } from '@/lib/invariants/zod'
import { sessionFailureResponse } from '@/lib/operations/session'

const ParamsSchema = z.object({ id: z.uuid() })

const BodySchema = z.object({
  invoice_id: z.uuid(),
  supplier_invoice_id: z.uuid(),
  amount: z.number().positive().max(1_000_000_000).optional(),
  setoff_date: isoDateSchema.optional(),
  note: z.string().trim().max(500).optional(),
  dry_run: z.boolean().optional(),
})

/**
 * POST /api/parties/[id]/setoffs: set off one of the counterparty's open
 * customer invoices against one of its open supplier invoices (kvittning).
 * dry_run answers the preview (what is booked, what each invoice is left
 * with, the net) and writes nothing. Off unless COUNTERPARTY_SETOFF_ENABLED.
 * The rules are lib/invoices/counterparty-setoff's, shared with the v1
 * operation invoices.setoff.book.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'parties.setoffs.book',
  async (request, ctx, { params }) => {
    if (!counterpartySetoffEnabled()) return errorResponseFromCode('SETOFF_DISABLED', ctx.log, { requestId: ctx.requestId })
    const parsed = ParamsSchema.safeParse(await params)
    if (!parsed.success) return errorResponseFromCode('NOT_FOUND', ctx.log, { requestId: ctx.requestId })
    const body = await validateBody(request, BodySchema, { log: ctx.log, operation: 'parties.setoffs.book' })
    if (!body.success) return body.response

    // The dossier may show a party that was merged into another; the set-off
    // belongs to the surviving one.
    const canonical = await resolveCanonicalParties(ctx.supabase, ctx.companyId, [parsed.data.id])
    const partyId = canonical.get(parsed.data.id)
    if (!partyId) return errorResponseFromCode('SETOFF_PARTY_NOT_FOUND', ctx.log, { requestId: ctx.requestId })

    const outcome = await bookCounterpartySetoff(
      { supabase: ctx.supabase, companyId: ctx.companyId, userId: ctx.user.id, log: ctx.log },
      {
        invoiceId: body.data.invoice_id,
        supplierInvoiceId: body.data.supplier_invoice_id,
        amount: body.data.amount ?? null,
        setoffDate: body.data.setoff_date ?? null,
        note: body.data.note ?? null,
        expectedPartyId: partyId,
      },
      { dryRun: body.data.dry_run === true },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, ctx.log, ctx.requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data, warnings: outcome.warnings ?? [] }, { status: 201 })
  },
  { requireWrite: true },
)
