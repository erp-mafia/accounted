import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { loadExtensions } from '@/lib/extensions/loader'
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
 */
export const GET = withCronContext('cron.push_notifications', async (_request, ctx) => {
  // Ensure extensions are loaded so event handlers are registered.
  loadExtensions()

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !supabaseServiceKey) {
    return errorResponseFromCode('INTERNAL_ERROR', ctx.log, {
      requestId: ctx.requestId,
      details: { reason: 'Missing Supabase configuration' },
    })
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey)

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
