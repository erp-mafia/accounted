import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { InvoicesBulkBookSchema } from '@/lib/api/schemas'
import { bulkBookInvoices } from '@/lib/invoices/book-service'
import { sessionFailureResponse } from '@/lib/operations/session'

ensureInitialized()

/**
 * POST /api/invoices/bulk-book
 *
 * One "Bokför" click for many customer invoices: drafts are issued and booked
 * (only when the company books at issue), sent/overdue unbooked invoices get
 * the deferred Bokför step, and every item reports its own outcome. The rules
 * and the partial-success semantics live in lib/invoices/book-service.ts,
 * shared with the v1 operation invoices.bulk-book and
 * gnubok_bulk_book_invoices.
 */
export const POST = withRouteContext(
  'invoice.bulk_book',
  async (request, { user, supabase, companyId, log, requestId }) => {
    const validated = await validateBody(request, InvoicesBulkBookSchema)
    if (!validated.success) return validated.response

    const outcome = await bulkBookInvoices(
      { supabase, companyId, userId: user.id, log },
      validated.data.ids,
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
