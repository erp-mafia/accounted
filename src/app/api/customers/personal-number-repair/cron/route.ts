import { NextResponse } from 'next/server'
import { withServiceCronContext } from '@/lib/api/with-cron-context'
import { repairIndividualOrgNumbers } from '@/lib/customers/org-number-repair'

// One-off, on the founders' go (2026-10-28): the personnummer repair of
// scripts/repair-customer-personal-number-in-org-number.ts needs the
// production key, which only the deployed app holds. Remove this route and
// its vercel.json entry once a run finds nothing left to write.
export const maxDuration = 300
// No row is written after this; one write and its audit row finish well
// inside the rest, and the next run carries on where this one stopped.
const RUN_BUDGET_MS = 200_000

export const GET = withServiceCronContext('cron.customer_personal_number_repair', async (_request, ctx) => {
  const run = await repairIndividualOrgNumbers(ctx.supabase, {
    apply: true,
    deadline: ctx.startedAt + RUN_BUDGET_MS,
    actorLabel: 'cron customer-personal-number-repair',
  })
  ctx.log.info('customer personal number repair run finished', run)
  // The last written row has no audit row: fail the run so it is seen.
  if (run.stopped === 'audit_failed') {
    throw new Error(`audit_log insert failed (${run.auditError}) after ${run.written} written`)
  }
  return NextResponse.json({ data: run })
})
