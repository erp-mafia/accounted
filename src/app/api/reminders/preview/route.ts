import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateQuery } from '@/lib/api/validate'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { ReminderInvoiceNotFoundError } from '@/lib/reminders/facts'
import { NoInvoiceToPreviewError, renderReminderPreview } from '@/lib/reminders/preview'
import { createServiceClient } from '@/lib/supabase/server'

const QuerySchema = z.object({
  invoice_id: z.uuid().optional(),
  level: z.enum(['1', '2', '3']).optional(),
})

/**
 * GET /api/reminders/preview?invoice_id=&level=: the reminder mail as the
 * customer would get it, rendered with the send's own template. Without an
 * invoice it shows the company's most recent overdue (else issued) invoice.
 * The page shows the HTML in a sandboxed frame.
 */
export const GET = withRouteContext('reminders.preview', async (request, { companyId, log, requestId }) => {
  const query = validateQuery(request, QuerySchema, { log, operation: 'reminders.preview' })
  if (!query.success) return query.response
  try {
    const preview = await renderReminderPreview(createServiceClient(), companyId, {
      invoiceId: query.data.invoice_id,
      level: query.data.level ? (Number(query.data.level) as 1 | 2 | 3) : undefined,
      now: new Date(),
    })
    return NextResponse.json({ data: preview })
  } catch (error) {
    if (error instanceof NoInvoiceToPreviewError) return errorResponseFromCode('REMINDER_NO_INVOICE_TO_PREVIEW', log, { requestId })
    if (error instanceof ReminderInvoiceNotFoundError) return errorResponseFromCode('INVOICE_NOT_FOUND', log, { requestId })
    throw error
  }
})
