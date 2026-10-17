import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { sessionFailureResponse } from '@/lib/operations/session'
import { prepareSkattekontoPaymentOrder } from '@/lib/payments/orders/prepare-skattekonto'
import {
  refineSkattekontoSource,
  SKATTEKONTO_SOURCE_FIELDS,
  toSkattekontoSource,
} from '@/lib/payments/orders/skattekonto-sources'

const PrepareSkattekontoSchema = z
  .object({
    cash_account_id: z.uuid(),
    /** Kronor and öre; omitted, it is what the declaration (source) or the next charge asks for. */
    amount: z.number().positive().nullish(),
    execution_date: z.iso.date().nullish(),
    /** Every rule runs and the payment that would be created is answered; nothing is written. The dialog's preview. */
    dry_run: z.boolean().optional(),
    // The declaration paid (vat_declaration, agi) or the next charge, as payment-orders.prepare names it.
    ...SKATTEKONTO_SOURCE_FIELDS,
  })
  .superRefine(refineSkattekontoSource)

/**
 * POST /api/payments/orders/skattekonto: prepare a draft bank payment in to
 * the skattekonto (bankgiro 5050-1055 with the company's OCR number). The
 * amount defaults to what the next charge lacks and the day to the last
 * banking day before Skatteverket draws it; named from a declaration
 * (source vat_declaration or agi), what that declaration asks for by its due
 * date. Nothing reaches the bank: the draft is approved and signed with
 * BankID like a supplier payment. The rules live in
 * lib/payments/orders/prepare-skattekonto.ts.
 */
export const POST = withRouteContext(
  'payment_orders.prepare_skattekonto',
  async (request, { supabase, companyId, user, log, requestId }) => {
    const validation = await validateBody(request, PrepareSkattekontoSchema)
    if (!validation.success) return validation.response
    const body = validation.data

    const outcome = await prepareSkattekontoPaymentOrder(
      { supabase, companyId, userId: user.id, log },
      {
        cashAccountId: body.cash_account_id,
        amount: body.amount ?? null,
        executionDate: body.execution_date ?? null,
        source: toSkattekontoSource(body),
        today: todayIsoStockholm(),
        dryRun: body.dry_run === true,
      },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data }, { status: 201 })
  },
  { requireWrite: true },
)
