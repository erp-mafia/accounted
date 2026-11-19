import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { runInboxSweep } from '@/extensions/general/invoice-inbox/lib/sweep'

/**
 * GET /api/extensions/invoice-inbox/sweep/cron: crash recovery for the
 * staged upload. Flips invoice_inbox_items rows stuck in 'processing' (a
 * deferred extraction worker that died with its instance) to 'received'
 * with the empty extraction skeleton. A crashed worker is not read again:
 * the UI retry button covers that. The only re-read is a reading the AI
 * provider could not take, capped and gapped (lib/provider-retry.ts).
 * Scheduled every 2 minutes in vercel.json (and the Docker crontabs).
 *
 * Overlap with a slow previous run is safe: the flip is a guarded claim on
 * status='processing' with extracted_data still NULL, and the re-read claims
 * the document's stamp before it reads.
 */

// The flip and the routing take seconds. The provider re-read runs up to
// three readings side by side, each ending at the 250 s extraction deadline,
// so the function gets the same 300 s as the upload routes that read.
export const maxDuration = 300

export const GET = withCronContext('cron.invoice_inbox_sweep', async (_request, ctx) => {
  const supabase = createServiceClientNoCookies()
  const summary = await runInboxSweep(supabase)

  ctx.log.info('invoice inbox sweep complete', { ...summary })

  return NextResponse.json({ data: summary })
}, { requireExtension: 'invoice-inbox' })
