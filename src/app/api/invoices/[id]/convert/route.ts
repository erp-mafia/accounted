import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { ConvertQuotePartSchema } from '@/lib/api/schemas'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { convertToInvoice } from '@/lib/invoices/convert-to-invoice'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

/**
 * POST /api/invoices/[id]/convert
 *
 * Converts a proforma invoice or an accepted quote (offert) to a real
 * invoice. The shared implementation (lib/invoices/convert-to-invoice.ts)
 * copies the data, generates an F-series number LAST, marks a proforma
 * cancelled and a quote accepted; the new invoice links back through
 * converted_from_id.
 *
 * Optional body (quotes only, crm#1196): { percent } or { amount } invoices
 * that part of the quote's net; without a body the invoice bills everything
 * not yet invoiced (the whole quote the first time).
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'invoice.convert',
  async (request, { supabase, user, companyId, log, requestId }, { params }) => {
    const { id } = await params

    let rawBody: unknown = {}
    try {
      const text = await request.text()
      if (text.trim()) rawBody = JSON.parse(text)
    } catch {
      return errorResponseFromCode('VALIDATION_ERROR', log, {
        requestId,
        details: { field: 'body', message: 'Body is not valid JSON.' },
      })
    }
    const parsed = ConvertQuotePartSchema.safeParse(rawBody ?? {})
    if (!parsed.success) {
      return errorResponseFromCode('VALIDATION_ERROR', log, {
        requestId,
        details: {
          issues: parsed.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })),
        },
      })
    }
    const { percent, amount } = parsed.data

    const result = await convertToInvoice({
      supabase,
      userId: user.id,
      companyId,
      sourceId: id,
      part: percent !== undefined ? { percent } : amount !== undefined ? { amount } : null,
    })

    if (!result.ok) {
      if (result.code === 'INVOICE_CONVERT_FAILED') {
        log.error('invoice conversion failed', result.cause as Error, { sourceId: id })
        return NextResponse.json({ error: getUserErrorMessage(result.cause) }, { status: 500 })
      }
      if (result.code === 'INVOICE_NUMBER_SERIES_BEHIND') {
        return errorResponseFromCode(result.code, log, {
          requestId,
          messageSv: result.messageSv,
          messageEn: result.messageEn,
          details: result.details,
        })
      }
      return errorResponseFromCode(result.code, log, { requestId, details: result.details })
    }

    return NextResponse.json({ data: result.invoice })
  },
  { requireWrite: true },
)
