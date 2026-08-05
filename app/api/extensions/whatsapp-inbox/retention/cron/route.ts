import { NextResponse } from 'next/server'
import { loadExtensions } from '@/lib/extensions/loader'
import { extensionRegistry } from '@/lib/extensions/registry'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { runRetention } from '@/extensions/general/whatsapp-inbox/lib/retention'

/**
 * GET /api/extensions/whatsapp-inbox/retention/cron: daily GDPR purge for
 * the WhatsApp channel. Enforces the retention table in .compliance/ropa.yaml
 * (whatsapp.receipt_intake): 90-day chat transcripts, 30-day unknown-sender
 * rows, expired link codes, dead rate counters, and the 90-day crypto-shred
 * of revoked phone bindings. Receipts themselves are 7-year WORM under BFL
 * and are never touched here. Scheduled in vercel.json (and the generated
 * Docker crontabs).
 *
 * Overlap with a slow previous run is safe: every predicate only matches
 * rows still carrying the data, so a second pass is a no-op.
 */

// The transcript purge loops over a possibly large first-run backlog.
export const maxDuration = 300

export const GET = withCronContext('cron.whatsapp_retention', async (_request, ctx) => {
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
  const summary = await runRetention(supabase)

  ctx.log.info('whatsapp retention complete', { ...summary })

  return NextResponse.json({ data: summary })
})
