import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { checkPendingSenderRequests } from '@/lib/digital-mailboxes/connect'
import { DIGITAL_MAILBOX_TIMEOUT_MS } from '@/lib/digital-mailboxes/http'
import { sweepDigitalMailboxes } from '@/lib/digital-mailboxes/sweep'

export const maxDuration = 300

/** Kept free at the end of maxDuration: a sender request check that has started (a token, then a request) runs to its timeout. */
const SENDER_CHECK_MARGIN_MS = 2 * DIGITAL_MAILBOX_TIMEOUT_MS + 5_000

/**
 * GET /api/digital-mailboxes/cron: every 10 minutes.
 *
 * Reads every connected Kivra and Billo mailbox into the Inkorg
 * (lib/digital-mailboxes/sweep.ts): pending Kivra connections are looked up,
 * active ones read since their receive_since, each document filed once (the
 * arrival is the key). The provider webhooks make arrival prompt; this pass
 * makes it certain. An active Kivra mailbox the webhook is proven to carry is
 * read about once a day (the safety net Kivra advises); until then, every run.
 * Then it asks the provider about sender access requests that wait for it
 * (a company already sending through another service): an accepted one
 * switches sending on. A truthful no-op when no provider is configured.
 */
export const GET = withCronContext('cron.digital_mailboxes', async (_request, ctx) => {
  const startedAt = Date.now()
  const summary = await sweepDigitalMailboxes(createServiceClientNoCookies(), { log: ctx.log })
  if (summary.errors.length > 0) {
    ctx.log.warn('digital mailbox sweep left connections to retry', {
      errorCount: summary.errors.length,
      errors: summary.errors.map((e) => ({ companyId: e.companyId, provider: e.provider, reason: e.reason.slice(0, 200) })),
    })
  }
  ctx.log.info('digital mailbox sweep complete', { ...summary, errors: summary.errors.length })
  // What the sweep left of maxDuration: requests not reached wait for the next run.
  const senders = await checkPendingSenderRequests(createServiceClientNoCookies(), {
    log: ctx.log,
    budgetMs: startedAt + maxDuration * 1000 - SENDER_CHECK_MARGIN_MS - Date.now(),
  })
  if (senders.errors.length > 0) {
    ctx.log.warn('digital mailbox sender requests left to ask about again', {
      errorCount: senders.errors.length,
      errors: senders.errors.map((e) => ({ companyId: e.companyId, provider: e.provider, reason: e.reason.slice(0, 200) })),
    })
  }
  if (senders.checked > 0 || senders.deferred > 0) ctx.log.info('digital mailbox sender requests checked', { ...senders, errors: senders.errors.length })
  return NextResponse.json({
    data: { ...summary, errors: summary.errors.length, sender_requests: { ...senders, errors: senders.errors.length } },
  })
})

export const POST = GET
