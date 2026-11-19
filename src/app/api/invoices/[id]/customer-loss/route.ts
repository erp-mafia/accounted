import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { recordConfirmedLoss } from '@/lib/customer-loss/confirmed'
import { recordDoubtfulLoss } from '@/lib/customer-loss/doubtful'
import type { CustomerLossOutcome } from '@/lib/customer-loss/errors'
import { customerLossEnabled } from '@/lib/env/customer-loss-switch'
import { recordRecoveredLoss } from '@/lib/customer-loss/recovered'
import { loadCustomerLossState } from '@/lib/customer-loss/state'
import { buildCustomerLossView } from '@/lib/customer-loss/view'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { accountNumberSchema, isoDateSchema } from '@/lib/invariants/zod'
import { todayIsoStockholm } from '@/lib/dates/iso'

const ParamsSchema = z.object({ id: z.uuid() })

const isoDate = isoDateSchema
const reason = z.string().trim().min(1).max(500)

const BodySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('doubtful'),
    entry_date: isoDate.optional(),
    reason,
  }),
  z.object({
    kind: z.literal('confirmed'),
    entry_date: isoDate.optional(),
    reason,
    evidence_document_id: z.uuid().nullable().optional(),
  }),
  z.object({
    kind: z.literal('recovered'),
    entry_date: isoDate.optional(),
    reason,
    amount: z.number().positive().max(1_000_000_000),
    payment_account: accountNumberSchema.optional(),
  }),
])

/**
 * GET /api/invoices/[id]/customer-loss: the invoice's kundförlust view (the
 * menu entry, what befarad and konstaterad would book now, the reserve held,
 * a recovery's room, the decisions made). Decisions already made are shown
 * whatever CUSTOMER_LOSS_ENABLED says; only new ones need it.
 */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'invoice.customer-loss.get',
  async (_request, ctx, { params }) => {
    const parsed = ParamsSchema.safeParse(await params)
    if (!parsed.success) return errorResponseFromCode('VALIDATION_ERROR', ctx.log, { requestId: ctx.requestId })
    const loaded = await loadCustomerLossState(ctx.supabase, ctx.companyId, parsed.data.id)
    if (!loaded.ok) return errorResponseFromCode('INVOICE_NOT_FOUND', ctx.log, { requestId: ctx.requestId })
    const view = buildCustomerLossView(loaded.state, { enabled: customerLossEnabled(), today: todayIsoStockholm() })
    return NextResponse.json({ data: view }, { headers: { 'Cache-Control': 'no-store' } })
  },
)

/**
 * POST /api/invoices/[id]/customer-loss: book a kundförlust decision.
 * kind 'doubtful' (befarad: Dr 6352 / Cr 1519), 'confirmed' (konstaterad:
 * Dr 6351 + 26xx / Cr 1510, evidence required; the invoice becomes
 * written_off) or 'recovered' (a payment after the write-off: Dr bank / Cr
 * 3950 + 26xx). Off unless CUSTOMER_LOSS_ENABLED.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'invoice.customer-loss.record',
  async (request, ctx, { params }) => {
    if (!customerLossEnabled()) return errorResponseFromCode('CUSTOMER_LOSS_DISABLED', ctx.log, { requestId: ctx.requestId })
    const parsed = ParamsSchema.safeParse(await params)
    if (!parsed.success) return errorResponseFromCode('VALIDATION_ERROR', ctx.log, { requestId: ctx.requestId })
    const body = await validateBody(request, BodySchema, { log: ctx.log, operation: 'invoice.customer-loss.record' })
    if (!body.success) return body.response

    const invoiceId = parsed.data.id
    const entryDate = body.data.entry_date ?? todayIsoStockholm()
    const common = { invoiceId, entryDate, reason: body.data.reason, decidedBy: ctx.user.id }
    let outcome: CustomerLossOutcome
    switch (body.data.kind) {
      case 'doubtful':
        outcome = await recordDoubtfulLoss(ctx.supabase, ctx.companyId, ctx.user.id, common)
        break
      case 'confirmed':
        outcome = await recordConfirmedLoss(ctx.supabase, ctx.companyId, ctx.user.id, {
          ...common,
          evidenceDocumentId: body.data.evidence_document_id ?? null,
        })
        break
      case 'recovered':
        outcome = await recordRecoveredLoss(ctx.supabase, ctx.companyId, ctx.user.id, {
          ...common,
          amount: body.data.amount,
          paymentAccount: body.data.payment_account,
        })
        break
    }

    if (!outcome.ok) {
      return errorResponseFromCode(outcome.code, ctx.log, { requestId: ctx.requestId, details: outcome.details })
    }
    return NextResponse.json({
      data: {
        write_off_id: outcome.writeOffId,
        journal_entry_id: outcome.journalEntryId,
        invoice_status: outcome.invoiceStatus,
        amount: outcome.amount,
      },
    })
  },
  { requireWrite: true },
)
