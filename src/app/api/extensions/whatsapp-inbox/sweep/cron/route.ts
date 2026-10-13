import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { runSweep } from '@/extensions/general/whatsapp-inbox/lib/sweep'

/**
 * GET /api/extensions/whatsapp-inbox/sweep/cron: per-minute crash recovery
 * for the WhatsApp channel. Re-claims stuck message rows, sends combined
 * acks whose deferred worker died, expires 48h questions and 8h company
 * pins. Scheduled in vercel.json (and the generated Docker crontabs).
 *
 * Overlap with a slow previous run is safe: every mutation is a guarded
 * claim (processing_status / pending_ack), so two sweeps never double-run
 * one row.
 */

// A re-claimed batch can include Bedrock extractions (10-60s each).
export const maxDuration = 300

export const GET = withCronContext('cron.whatsapp_sweep', async (_request, ctx) => {
  const supabase = createServiceClientNoCookies()
  const summary = await runSweep(supabase)

  ctx.log.info('whatsapp sweep complete', { ...summary })

  return NextResponse.json({ data: summary })
}, { requireExtension: 'whatsapp-inbox' })
