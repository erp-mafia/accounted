import { NextResponse } from 'next/server'
import { withServiceCronContext } from '@/lib/api/with-cron-context'
import { sweepFloatingSupplierInvoiceDocuments } from '@/lib/core/documents/supplier-invoice-underlag'

/**
 * GET /api/documents/reanchor/cron: daily 03:30 UTC (schedule in vercel.json).
 *
 * Re-anchors supplier-invoice retained documents that are floating although
 * the invoice has a posted verifikat. The inline anchoring in the payment
 * routes is best-effort (the booking is already committed when it runs), so a
 * transient failure there leaves the verifikat flagged "Underlag saknas" with
 * the PDF plainly attached to the invoice, and until now only a hand-written
 * repair migration ever retried. A case seen 2026-08-28: kontantmetod payment
 * verifikat posted, document eligible, anchor silently did nothing.
 *
 * Idempotent: an anchored document is never moved, locked/closed periods are
 * skipped, and a clean run touches nothing.
 */

export const maxDuration = 120

export const GET = withServiceCronContext('cron.documents_reanchor', async (_request, ctx) => {
  const supabase = ctx.supabase
  const result = await sweepFloatingSupplierInvoiceDocuments(supabase)

  ctx.log.info('reanchor sweep finished', { ...result })
  return NextResponse.json({ data: result })
})
