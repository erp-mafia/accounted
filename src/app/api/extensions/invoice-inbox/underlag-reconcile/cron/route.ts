import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { reconcileStrandedInboxUnderlag } from '@/lib/transactions/inbox-underlag-reconcile'

/**
 * GET /api/extensions/invoice-inbox/underlag-reconcile/cron: daily
 * reconciliation of inbox items stranded on already-booked transactions
 * (#1548). Re-runs the underlag propagation for matched items whose
 * transaction is booked but whose stamp never landed, so a transient link
 * failure heals without an ad-hoc script run, and counts the permanent
 * conflicts (document anchored to another verifikat) so they are visible
 * in one summary instead of scattered warn lines. Scheduled daily in
 * vercel.json (and the generated Docker crontabs).
 *
 * Idempotent and safe to overlap with a slow previous run: the propagation
 * skips documents that already reference the verifikat and CASes the stamp
 * on its null predicate.
 */

// One bounded scan (1000 items) plus a handful of batched lookups per
// company, and a document link per stranded item. Same budget as the
// WhatsApp sweep so a large backlog on first run cannot time out midway.
export const maxDuration = 300

export const GET = withCronContext('cron.invoice_inbox_underlag_reconcile', async (_request, ctx) => {
  const supabase = createServiceClientNoCookies()
  const summary = await reconcileStrandedInboxUnderlag(supabase, {
    execute: true,
    log: ctx.log,
    actorId: 'cron.invoice_inbox_underlag_reconcile',
  })

  ctx.log.info('invoice inbox underlag reconcile complete', { ...summary })

  return NextResponse.json({ data: summary })
}, { requireExtension: 'invoice-inbox' })
