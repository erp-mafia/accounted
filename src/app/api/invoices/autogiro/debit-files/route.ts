import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { isAutogiroEnabled } from '@/lib/invoices/autogiro/flag'
import { createDebitFile } from '@/lib/invoices/autogiro/service'

const BodySchema = z.object({
  /** The invoices to debit; omitted: every invoice that can go in now. */
  invoice_ids: z.array(z.uuid()).min(1).max(300).optional(),
})

/**
 * POST /api/invoices/autogiro/debit-files: writes the payment file
 * (betalningsunderlag) for Bankgirot: one debit per invoice on its payment
 * day (the due date, at least 8 banking days after the invoice went out),
 * stored for download through GET /api/invoices/autogiro/files/[id]. An
 * invoice that cannot go in is returned in `skipped` with its reason.
 */
export const POST = withRouteContext(
  'autogiro.debit_file.create',
  async (request, { supabase, companyId, user, log, requestId }) => {
    if (!isAutogiroEnabled(companyId)) return errorResponseFromCode('AUTOGIRO_NOT_ENABLED', log, { requestId })
    const body = await validateBody(request, BodySchema, { log, operation: 'autogiro.debit_file.create' })
    if (!body.success) return body.response
    const result = await createDebitFile(supabase, companyId, user.id, {
      invoice_ids: body.data.invoice_ids,
      today: todayIsoStockholm(),
    })
    if (!result.ok) return errorResponseFromCode(result.code, log, { requestId, details: result.details })
    log.info('autogiro debit file written', { debits: result.debits, skipped: result.skipped.length })
    return NextResponse.json(
      { data: { file: result.file, debits: result.debits, total: result.total, skipped: result.skipped } },
      { status: 201 },
    )
  },
  { requireWrite: true },
)
