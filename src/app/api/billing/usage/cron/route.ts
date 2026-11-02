import { NextResponse } from 'next/server'
import { withServiceCronContext } from '@/lib/api/with-cron-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { currentUsagePeriod, isUsagePeriod } from '@/lib/payments/usage'
import { getStripe, isStripeConfigured } from '@/lib/stripe/client'
import { closeUsagePeriod, previousUsagePeriod } from '@/lib/usage/close-period'
import { billedUsageKinds } from '@/lib/usage/kinds'

/**
 * GET /api/billing/usage/cron: the 1st of every month, 06:00 UTC. Closes
 * the month that just ended (or ?period=YYYY-MM, a closed month, for a rerun):
 * every company's usage statements, and lines on the company's subscription
 * for the kinds in USAGE_BILLING_KINDS that an admin accepted. With none
 * listed, or without Stripe, every statement is a preview and nobody is
 * charged (lib/usage/close-period.ts).
 */
export const GET = withServiceCronContext('cron.usage_statements', async (request, ctx) => {
  const asked = new URL(request.url).searchParams.get('period')
  if (asked !== null && (!isUsagePeriod(asked) || asked >= currentUsagePeriod())) {
    return errorResponseFromCode('VALIDATION_ERROR', ctx.log, {
      requestId: ctx.requestId,
      details: { reason: 'period must be a closed month, YYYY-MM' },
    })
  }
  const period = asked ?? previousUsagePeriod()
  const billed = billedUsageKinds()
  const result = await closeUsagePeriod(ctx.supabase, period, {
    stripe: isStripeConfigured() ? getStripe() : null,
    billed,
    log: ctx.log,
  })
  ctx.log.info('usage statements closed', {
    period,
    kinds: [...billed],
    companies: result.companies,
    statements: result.statements,
    billed: result.billed.length,
    failed: result.failed.length,
    needsAttention: result.needsAttention.length,
  })
  return NextResponse.json({ data: { ...result, kinds: [...billed] } })
})
