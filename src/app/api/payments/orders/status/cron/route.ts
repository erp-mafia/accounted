import { NextResponse } from 'next/server'
import { runBudget } from '@/lib/api/run-budget'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { notifyFailedPayments, type FailedPaymentMailResult } from '@/lib/payments/orders/outcome-notify'
import { syncPaymentOrderStatuses } from '@/lib/payments/orders/sync'
import { sweepPaymentVerifications } from '@/lib/payments/orders/verification-sweep'

export const maxDuration = 300

/**
 * Until when each pass may start work, counted from the start of the run. A
 * call to the bank may take the provider's 30 s timeout and a read may be
 * followed by a cancel, so the status sync stops starting reads 120 s before
 * maxDuration. The debit sweeps after it call no bank and may start a row
 * until 75 s before; the verification sweep, one call per record, until 60 s
 * before. What a pass leaves is first in the next run (15 minutes). Before
 * this the run asked every bank about every payment however long it took,
 * and on 2026-11-10 twelve reads a bank left unanswered took the whole 300 s:
 * the platform killed the run before the rest were read, the mails sent or
 * the sweep run, and nothing recorded that.
 */
const STATUS_SYNC_BUDGET_MS = 180_000
const DEBIT_SWEEP_BUDGET_MS = 225_000
const VERIFICATION_SWEEP_BUDGET_MS = 240_000

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
 *
 * Safe to run twice: every status is written compare-and-set on the status
 * read, a cancel for a closed invoice is asked once per payment, a mail is
 * claimed in notification_log before it is sent.
 */
export const GET = withCronContext('cron.payment_order_status', async (_request, ctx) => {
  const writer = createServiceClientNoCookies()
  const result = await syncPaymentOrderStatuses(writer, ctx.log, runBudget(ctx.startedAt, STATUS_SYNC_BUDGET_MS), runBudget(ctx.startedAt, DEBIT_SWEEP_BUDGET_MS))
  ctx.log.info('payment order status sync done', { ...result })
  let failedPaymentMails: FailedPaymentMailResult | { error: true }
  try {
    failedPaymentMails = await notifyFailedPayments(writer, ctx.log)
    ctx.log.info('payment failed mails done', { ...failedPaymentMails })
  } catch (err) {
    failedPaymentMails = { error: true }
    ctx.log.error('payment failed mails could not run', err as Error)
  }
  const verifications = await sweepPaymentVerifications(writer, ctx.log, new Date(), runBudget(ctx.startedAt, VERIFICATION_SWEEP_BUDGET_MS))
  ctx.log.info('payments verification sweep done', { ...verifications })
  return NextResponse.json({ data: { ...result, failedPaymentMails, verifications } })
})

export const POST = GET
