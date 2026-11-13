import { NextResponse } from 'next/server'
import { withServiceCronContext } from '@/lib/api/with-cron-context'
import { recoverStuckCommittingOperations } from '@/lib/pending-operations/recover-stuck-committing'
import { runAttestRequestRound } from '@/lib/supplier-invoices/attest-mail-run'

export const maxDuration = 300

/**
 * The stuck-operation sweep is not started this late into a run. The attest
 * round takes at most about 280 s (ATTEST_RUN_SEND_BUDGET_MS plus one send);
 * it is normally done in seconds, and the sweep is one read when nothing is
 * stuck. Skipped, it runs with the next round five minutes later.
 */
const STUCK_SWEEP_START_BUDGET_MS = 240_000

/**
 * GET /api/supplier-invoices/attest-mail/cron, every 5 minutes (vercel.json,
 * the Docker crontab). The batched attest request (crm#1569): for every
 * company that has registered nothing new for 15 minutes, each attester gets
 * one mail listing every queued invoice waiting on them; an invoice nobody
 * can attest is told to its registrant (lib/supplier-invoices/attest-mail-run.ts).
 * Answers skipped until the migration has reached the database.
 *
 * It also hosts the sweep of approvals stuck in 'committing'
 * (lib/pending-operations/recover-stuck-committing.ts): such a row is in
 * neither the Godkänn nor the Avvisa tab, its threshold is 15 minutes, and
 * the only job that resolved it ran once a night, so it stayed invisible for
 * up to a day. This is the core job that already runs every few minutes with
 * the service role and time to spare. After the attest round, so it never
 * moves the round's own budgets, and isolated: a failed sweep never fails
 * the round. What keeps failing here is logged at warn: the nightly expire
 * cron runs the same sweep and logs it at error, once a day instead of every
 * 5 minutes. An outcome nobody could verify (unknown) is an error at once.
 */
export const GET = withServiceCronContext('cron.attest_mail_requests', async (_request, ctx) => {
  const result = await runAttestRequestRound(ctx.supabase, ctx.log)
  ctx.log.info('attest request round summary', { ...result })

  let stuckOperations: Record<string, unknown>
  if (Date.now() - ctx.startedAt >= STUCK_SWEEP_START_BUDGET_MS) {
    stuckOperations = { skipped: 'out_of_time' }
  } else {
    try {
      stuckOperations = { ...(await recoverStuckCommittingOperations(ctx.supabase, { log: ctx.log, failureLevel: 'warn' })) }
    } catch (err) {
      ctx.log.warn('pending_op_recovery sweep failed; the nightly expire cron sweeps too', { error: err instanceof Error ? err.message : String(err) })
      stuckOperations = { error: 'recovery_sweep_failed' }
    }
  }

  return NextResponse.json({ ...result, stuck_operations: stuckOperations })
})
