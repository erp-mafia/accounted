import { createServiceRoleClient } from '@/lib/supabase/service-client'
import { NextResponse } from 'next/server'
import { loadExtensions } from '@/lib/extensions/loader'
import { extensionRegistry } from '@/lib/extensions/registry'
import {
  sendTaxDeadlineNotifications,
  sendInvoiceNotifications,
  sendMissingUnderlagNotifications,
} from '@/extensions/general/push-notifications/notification-scheduler'
import { withCronContext } from '@/lib/api/with-cron-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'

/**
 * GET /api/extensions/push-notifications/cron: daily 09:00 UTC.
 * Sends due tax, invoice and missing-underlag push notifications.
 *
 * NOT scheduled: this path is absent from vercel.json's crons (and therefore
 * from the Docker crontabs generated from it). Adding it there is a product
 * decision, not a code change.
 */
export const GET = withCronContext('cron.push_notifications', async (_request, ctx) => {
  // Load the registry so it reflects extensions.config.json.
  loadExtensions()

  // Physical routes under app/api/extensions/<id>/ compile into EVERY build,
  // including the core-with-zero-extensions one: the registry (generated from
  // extensions.config.json) is what actually switches an extension on. Mirror
  // the ext/[...path] dispatcher: a disabled extension must not expose a live
  // send/query surface, and a scheduled-but-disabled cron must fail visibly
  // (503) instead of quietly doing the work anyway.
  if (!extensionRegistry.get('push-notifications')) {
    ctx.log.warn('push-notifications extension is not enabled; cron refused')
    return NextResponse.json(
      { error: 'Push notifications extension is not enabled', code: 'EXTENSION_DISABLED' },
      { status: 503 }
    )
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !supabaseServiceKey) {
    return errorResponseFromCode('INTERNAL_ERROR', ctx.log, {
      requestId: ctx.requestId,
      details: { reason: 'Missing Supabase configuration' },
    })
  }

  const supabase = createServiceRoleClient(supabaseUrl, supabaseServiceKey)

  try {
    const [taxResult, invoiceResult, underlagResult] = await Promise.all([
      sendTaxDeadlineNotifications(supabase),
      sendInvoiceNotifications(supabase),
      sendMissingUnderlagNotifications(supabase),
    ])

    const totalSent = taxResult.sent + invoiceResult.sent + underlagResult.sent
    const totalSkipped = taxResult.skipped + invoiceResult.skipped + underlagResult.skipped

    ctx.log.info('push notification cron summary', {
      totalSent,
      totalSkipped,
      taxSent: taxResult.sent,
      invoiceSent: invoiceResult.sent,
      underlagSent: underlagResult.sent,
    })

    return NextResponse.json({
      success: true,
      totalSent,
      totalSkipped,
      details: {
        taxDeadlines: taxResult,
        invoices: invoiceResult,
        missingUnderlag: underlagResult,
      },
    })
  } catch (err) {
    ctx.log.error('push notification cron failed', err as Error)
    return errorResponse(err, ctx.log, { requestId: ctx.requestId })
  }
})
