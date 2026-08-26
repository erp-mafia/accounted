import { NextResponse } from 'next/server'
import { loadExtensions } from '@/lib/extensions/loader'
import { extensionRegistry } from '@/lib/extensions/registry'
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
  // Load the registry so it reflects extensions.config.json.
  loadExtensions()

  // Physical routes under app/api/extensions/<id>/ compile into EVERY build,
  // including the core-with-zero-extensions one: the registry (generated from
  // extensions.config.json) is what actually switches an extension on. Mirror
  // the ext/[...path] dispatcher: a disabled extension must not expose a live
  // surface, and a scheduled-but-disabled cron must fail visibly (503)
  // instead of quietly doing the work anyway.
  if (!extensionRegistry.get('whatsapp-inbox')) {
    ctx.log.warn('whatsapp-inbox extension is not enabled; cron refused')
    return NextResponse.json(
      { error: 'WhatsApp inbox extension is not enabled', code: 'EXTENSION_DISABLED' },
      { status: 503 },
    )
  }

  const supabase = createServiceClientNoCookies()
  const summary = await runSweep(supabase)

  ctx.log.info('whatsapp sweep complete', { ...summary })

  return NextResponse.json({ data: summary })
})
