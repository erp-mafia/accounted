import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { notifyFailedPayments, type FailedPaymentMailResult } from '@/lib/payments/orders/outcome-notify'
import { syncPaymentOrderStatuses } from '@/lib/payments/orders/sync'
import { sweepPaymentVerifications } from '@/lib/payments/orders/verification-sweep'

export const maxDuration = 300

/**
 * GET /api/payments/orders/status/cron: every 15 minutes.
 *
 * Reads the status of every bank payment the bank has not finished with and
 * moves it forward (accepted -> executed, a second signer done, rejected).
 * Open Payments has no payment webhooks, so this poll is the source of truth.
 * A truthful no-op when no payment provider is registered.
 *
 * Then the people behind a payment the bank rejected or that failed are
 * mailed, once each (outcome-notify.ts): the ones this sync found, and those
 * found during a signing since the last run. A failure there never fails the
 * run: the statuses stand and the Att göra row says it.
 *
 * The same run refreshes the company verifications (know your customer)
 * nobody asked about for a day, so the renewal nudge in Att göra has a fresh
 * valid_until to count down from (verification-sweep.ts).
 */
export const GET = withCronContext('cron.payment_order_status', async (_request, ctx) => {
  const writer = createServiceClientNoCookies()
  const result = await syncPaymentOrderStatuses(writer, ctx.log)
  ctx.log.info('payment order status sync done', { ...result })
  let failedPaymentMails: FailedPaymentMailResult | { error: true }
  try {
    failedPaymentMails = await notifyFailedPayments(writer, ctx.log)
    ctx.log.info('payment failed mails done', { ...failedPaymentMails })
  } catch (err) {
    failedPaymentMails = { error: true }
    ctx.log.error('payment failed mails could not run', err as Error)
  }
  const verifications = await sweepPaymentVerifications(writer, ctx.log)
  ctx.log.info('payments verification sweep done', { ...verifications })
  return NextResponse.json({ data: { ...result, failedPaymentMails, verifications } })
})

export const POST = GET
