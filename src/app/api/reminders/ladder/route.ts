import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateQuery } from '@/lib/api/validate'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { ReminderInvoiceNotFoundError } from '@/lib/reminders/facts'
import { loadInvoiceReminderLadder } from '@/lib/reminders/invoice-ladder'
import { createServiceClient } from '@/lib/supabase/server'

const QuerySchema = z.object({
  invoice_id: z.uuid(),
})

/**
 * GET /api/reminders/ladder?invoice_id=: whether the daily ladder reminds the
 * invoice by itself, and after which days, so the invoice page promises the
 * schedule only where it holds (lib/reminders/invoice-ladder.ts).
 */
export const GET = withRouteContext('reminders.ladder', async (request, { companyId, log, requestId }) => {
  const query = validateQuery(request, QuerySchema, { log, operation: 'reminders.ladder' })
  if (!query.success) return query.response
  try {
    // Service role, filtered by the active company the wrapper resolved: the
    // facts span tables a member reads only in part (delivery evidence, cases).
    const ladder = await loadInvoiceReminderLadder(createServiceClient(), companyId, query.data.invoice_id, { now: new Date() })
    return NextResponse.json({ data: ladder })
  } catch (error) {
    if (error instanceof ReminderInvoiceNotFoundError) return errorResponseFromCode('INVOICE_NOT_FOUND', log, { requestId })
    throw error
  }
})
