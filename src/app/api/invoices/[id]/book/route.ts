import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { bookInvoice } from '@/lib/invoices/book-service'
import { sessionFailureResponse } from '@/lib/operations/session'

/**
 * POST /api/invoices/[id]/book
 *
 * The explicit "Bokför" step for companies with defer_invoice_booking (#967):
 * one person creates and sends the invoice without bookkeeping, ekonomi books
 * the revenue entry here once the kontering is verified. The rules live in
 * lib/invoices/book-service.ts, shared with the bulk Bokför route, the v1
 * operation invoices.book and gnubok_book_invoice.
 */
export const POST = withRouteContext(
  'invoice.book',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx

    const outcome = await bookInvoice({ supabase, companyId, userId: user.id, log }, id)
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })

    const warnings = (outcome.warnings ?? []).map((w) => ({ code: w.code, message: w.message_sv }))
    return NextResponse.json({
      data: outcome.data.invoice,
      journal_entry_id: outcome.data.journal_entry_id,
      ...(warnings.length > 0 ? { warnings } : {}),
    })
  },
  { requireWrite: true },
)
