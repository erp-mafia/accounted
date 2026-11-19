import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { accountNumberSchema } from '@/lib/invariants/zod'
import { bookSettlement } from '@/lib/collections/settlements'
import { chooseSettlementLineAccounts, loadSettlementDetail } from '@/lib/collections/settlements-view'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { createServiceClient } from '@/lib/supabase/server'

const ParamsSchema = z.object({ id: z.uuid() })

const BookSettlementBodySchema = z.object({
  /** A person's account for lines the ledger could not place (an unknown line, VAT it does not deduct on its own). */
  lines: z
    .array(
      z.object({
        position: z.number().int().min(0),
        account_number: accountNumberSchema.optional(),
        vat_account_number: accountNumberSchema.optional(),
      }),
    )
    .max(200)
    .optional(),
})

const REFUSALS = {
  not_found: 'COLLECTION_SETTLEMENT_NOT_FOUND',
  not_bookable: 'COLLECTION_SETTLEMENT_NOT_BOOKABLE',
  busy: 'COLLECTION_SETTLEMENT_BUSY',
  document_unavailable: 'COLLECTION_SETTLEMENT_DOCUMENT_PENDING',
} as const

/**
 * POST /api/collections/settlements/[id]/book: book a payout from the
 * collections provider (one voucher, the settlement PDF as its underlag),
 * after recording the accounts a person chose for the lines the ledger
 * could not place. A payout that still needs a person answers 200 with
 * outcome needs_mapping and the reason; the view shows what is missing.
 * An obligation path: served whatever the start gates say.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'collections.settlements.book',
  async (request, ctx, { params }) => {
    const parsed = ParamsSchema.safeParse(await params)
    if (!parsed.success) return errorResponseFromCode('VALIDATION_ERROR', ctx.log, { requestId: ctx.requestId })
    const body = await validateBody(request, BookSettlementBodySchema, { log: ctx.log, operation: 'collections.settlements.book' })
    if (!body.success) return body.response

    const db = createServiceClient()
    if (body.data.lines && body.data.lines.length > 0) {
      const chosen = await chooseSettlementLineAccounts(
        db,
        ctx.companyId,
        parsed.data.id,
        ctx.user.id,
        body.data.lines.map((line) => ({
          position: line.position,
          accountNumber: line.account_number,
          vatAccountNumber: line.vat_account_number,
        })),
      )
      if (!chosen.ok) return errorResponseFromCode(chosen.code, ctx.log, { requestId: ctx.requestId })
    }

    const result = await bookSettlement({ db, log: ctx.log }, ctx.companyId, parsed.data.id, { userId: ctx.user.id })
    if (!result.ok && result.outcome !== 'needs_mapping') {
      return errorResponseFromCode(REFUSALS[result.outcome], ctx.log, { requestId: ctx.requestId })
    }
    const settlement = await loadSettlementDetail(db, ctx.companyId, parsed.data.id)
    return NextResponse.json({
      data: result.ok
        ? { outcome: 'booked', journal_entry_id: result.journalEntryId, already_booked: result.alreadyBooked, acknowledged: result.acknowledged, settlement }
        : { outcome: 'needs_mapping', reason: result.reason, issues: result.issues, settlement },
    })
  },
  { requireWrite: true },
)
