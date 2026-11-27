import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { UUID_RE } from '@/lib/invariants/uuid'
import { checkBankHeldPayments } from '@/lib/payments/orders/signed-payment'
import { ID_READ_CHUNK } from '@/lib/supabase/read-in-slices'

const QuerySchema = z.object({
  ids: z
    .string()
    .transform((raw) => raw.split(',').map((id) => id.trim()).filter(Boolean))
    .pipe(z.array(z.string().regex(UUID_RE)).min(1).max(ID_READ_CHUNK)),
  via: z.enum(['bank_row', 'other']),
})

/**
 * GET /api/supplier-invoices/bank-held-payments?ids=a,b&via=bank_row|other
 *
 * What the bank holds for these supplier invoices (Betala via banken), as a
 * dialog says it before its confirm: one warning per payment order the bank
 * holds, naming the order and the invoice, or one saying that the check
 * could not run (checkBankHeldPayments, lib/payments/orders/signed-payment.ts).
 * The read runs here rather than in the browser, so the pages' bundles carry
 * none of it. A warning, never a refusal. At most ID_READ_CHUNK ids, which a
 * gateway takes in a URL: a dialog with more asks in slices.
 */
export const GET = withRouteContext('supplier_invoice.bank_held_payments', async (request, ctx) => {
  const { supabase, companyId, log, requestId } = ctx
  const url = new URL(request.url)
  const parsed = QuerySchema.safeParse({
    ids: url.searchParams.get('ids') ?? '',
    via: url.searchParams.get('via') ?? undefined,
  })
  if (!parsed.success) {
    return errorResponseFromCode('VALIDATION_ERROR', log, {
      requestId,
      details: { field: String(parsed.error.issues[0]?.path[0] ?? 'ids'), message: parsed.error.issues[0]?.message ?? '' },
    })
  }

  const check = await checkBankHeldPayments(supabase, companyId!, parsed.data.ids, parsed.data.via)
  if (check.failed) log.warn('bank payment orders could not be read', check.error)
  return NextResponse.json({ data: { warnings: check.warnings, failed: check.failed } })
})
