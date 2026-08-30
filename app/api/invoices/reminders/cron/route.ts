import { NextResponse } from 'next/server'
import { processOverdueReminders } from '@/lib/invoices/reminder-processor'
import { REMINDERS_SENDING_ENABLED } from '@/lib/invoices/reminders-enabled'
import { getEmailService } from '@/lib/email/service'
import { withCronContext } from '@/lib/api/with-cron-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'

/**
 * GET/POST /api/invoices/reminders/cron: daily 08:00 UTC.
 * Sends overdue invoice reminders. POST exists so the dashboard can
 * trigger a run manually.
 *
 * Gated behind REMINDERS_SENDING_ENABLED (off since May 2026, PR #583):
 * while the flag is off this route answers 503 and nothing is sent. The
 * invoice settings UI reads the same flag to disclose that state, so
 * flipping the flag re-enables sending and removes the notice together.
 */
export const GET = withCronContext('cron.invoice_reminders', async (_request, ctx) => {
  if (!REMINDERS_SENDING_ENABLED) {
    ctx.log.info('invoice reminders feature is disabled; skipping run')
    return NextResponse.json({ disabled: true }, { status: 503 })
  }

  if (!getEmailService().isConfigured()) {
    ctx.log.error('email service not configured; skipping reminder run')
    return errorResponseFromCode('INVOICE_SEND_EMAIL_NOT_CONFIGURED', ctx.log, {
      requestId: ctx.requestId,
    })
  }

  const result = await processOverdueReminders()

  ctx.log.info('reminder cron summary', {
    processed: result.processed,
    sent: result.sent,
    failed: result.failed,
  })

  return NextResponse.json({
    success: true,
    processed: result.processed,
    sent: result.sent,
    failed: result.failed,
    results: result.results.map((r) => ({
      invoiceNumber: r.invoiceNumber,
      reminderLevel: r.reminderLevel,
      success: r.success,
      error: r.error,
    })),
  })
})

export const POST = GET
