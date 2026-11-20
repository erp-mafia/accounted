import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createServiceClient } from '@/lib/supabase/server'
import { vendorLogosFetchEnabled } from '@/lib/vendor-logos/flag'
import { runVendorLogos } from '@/lib/vendor-logos/run'

/**
 * GET /api/vendor-logos/cron, hourly at :20 (schedule in vercel.json).
 *
 * Fetches vendor icons from the vendors' own websites, once per domain, into
 * the public logos bucket (lib/vendor-logos). Off until VENDOR_LOGOS_FETCH
 * is true: then each run fetches at most 50 due domains, four at a time.
 * Collecting new domains reads a year of suppliers, inbox documents and
 * bank texts across every company, so it runs once a day (the 03 UTC run)
 * and on the first run, not every hour. Logs and answers counts only.
 */
export const maxDuration = 300

const COLLECT_HOUR_UTC = 3

export const GET = withCronContext('cron.vendor_logos', async (_request, ctx) => {
  if (!vendorLogosFetchEnabled()) {
    ctx.log.info('vendor logos skipped: VENDOR_LOGOS_FETCH off')
    return NextResponse.json({ success: true, skipped: true, reason: 'VENDOR_LOGOS_FETCH off' })
  }

  const service = createServiceClient()
  try {
    const { count, error } = await service.from('vendor_logos').select('domain', { count: 'exact', head: true })
    if (error) throw new Error('vendor_logos count failed')
    const collect = new Date(ctx.startedAt).getUTCHours() === COLLECT_HOUR_UTC || (count ?? 0) === 0
    const summary = await runVendorLogos(service, { collect })
    const { read, ...counts } = summary
    ctx.log.info('vendor logos run finished', { collect, ...counts, ...(read ?? {}) })
    return NextResponse.json({ success: true, collect, ...counts })
  } catch (err) {
    ctx.log.error('vendor logos run failed', err instanceof Error ? new Error(err.message.slice(0, 120)) : undefined)
    return NextResponse.json({ success: false, failed: true }, { status: 500 })
  }
})
