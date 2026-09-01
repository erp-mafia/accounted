import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createServiceRoleClient } from '@/lib/supabase/service-client'
import { sweepFloatingSupplierInvoiceDocuments } from '@/lib/core/documents/supplier-invoice-underlag'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'

/**
 * GET /api/documents/reanchor/cron: daily 03:30 UTC (schedule in vercel.json).
 *
 * Re-anchors supplier-invoice retained documents that are floating although
 * the invoice has a posted verifikat. The inline anchoring in the payment
 * routes is best-effort (the booking is already committed when it runs), so a
 * transient failure there leaves the verifikat flagged "Underlag saknas" with
 * the PDF plainly attached to the invoice, and until now only a hand-written
 * repair migration ever retried. Prod case 2026-08-28: kontantmetod payment
 * verifikat posted, document eligible, anchor silently did nothing.
 *
 * Idempotent: an anchored document is never moved, locked/closed periods are
 * skipped, and a clean run touches nothing.
 */

export const maxDuration = 120

export const GET = withCronContext('cron.documents_reanchor', async (_request, ctx) => {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !supabaseServiceKey) {
    return errorResponseFromCode('INTERNAL_ERROR', ctx.log, {
      requestId: ctx.requestId,
      details: { reason: 'Missing Supabase configuration' },
    })
  }

  const supabase = createServiceRoleClient(supabaseUrl, supabaseServiceKey)
  const result = await sweepFloatingSupplierInvoiceDocuments(supabase)

  ctx.log.info('reanchor sweep finished', { ...result })
  return NextResponse.json({ data: result })
})
