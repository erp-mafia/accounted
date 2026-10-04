import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { ensureInitialized } from '@/lib/init'
import { syncPaymentOrderStatuses } from '@/lib/payments/orders/sync'

ensureInitialized()

export const maxDuration = 300

/**
 * GET /api/payments/orders/status/cron: every 15 minutes.
 *
 * Reads the status of every bank payment the bank has not finished with and
 * moves it forward (accepted -> executed, a second signer done, rejected).
 * Open Payments has no payment webhooks, so this poll is the source of truth.
 * A truthful no-op when no payment provider is registered.
 */
export const GET = withCronContext('cron.payment_order_status', async (_request, ctx) => {
  const result = await syncPaymentOrderStatuses(createServiceClientNoCookies(), ctx.log)
  ctx.log.info('payment order status sync done', { ...result })
  return NextResponse.json({ data: result })
})

export const POST = GET
