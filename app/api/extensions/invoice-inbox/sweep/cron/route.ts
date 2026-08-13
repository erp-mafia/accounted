import { NextResponse } from 'next/server'
import { loadExtensions } from '@/lib/extensions/loader'
import { extensionRegistry } from '@/lib/extensions/registry'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { runInboxSweep } from '@/extensions/general/invoice-inbox/lib/sweep'

/**
 * GET /api/extensions/invoice-inbox/sweep/cron: crash recovery for the
 * staged upload. Flips invoice_inbox_items rows stuck in 'processing' (a
 * deferred extraction worker that died with its instance) to 'received'
 * with the empty extraction skeleton. No re-extraction here: the UI retry
 * button covers that. Scheduled every 2 minutes in vercel.json (and the
 * Docker crontabs).
 *
 * Overlap with a slow previous run is safe: the flip is a guarded claim on
 * status='processing' with extracted_data still NULL.
 */

// The work is one indexed select plus one guarded update: seconds, not
// minutes. Kept well under the WhatsApp sweep's 300s Bedrock budget.
export const maxDuration = 60

export const GET = withCronContext('cron.invoice_inbox_sweep', async (_request, ctx) => {
  // Load the registry so it reflects extensions.config.json.
  loadExtensions()

  // Physical routes under app/api/extensions/<id>/ compile into EVERY build,
  // including the core-with-zero-extensions one: the registry (generated from
  // extensions.config.json) is what actually switches an extension on. Mirror
  // the ext/[...path] dispatcher: a disabled extension must not expose a live
  // surface, and a scheduled-but-disabled cron must fail visibly (503)
  // instead of quietly doing the work anyway.
  if (!extensionRegistry.get('invoice-inbox')) {
    ctx.log.warn('invoice-inbox extension is not enabled; cron refused')
    return NextResponse.json(
      { error: 'Invoice inbox extension is not enabled', code: 'EXTENSION_DISABLED' },
      { status: 503 },
    )
  }

  const supabase = createServiceClientNoCookies()
  const summary = await runInboxSweep(supabase)

  ctx.log.info('invoice inbox sweep complete', { ...summary })

  return NextResponse.json({ data: summary })
})
