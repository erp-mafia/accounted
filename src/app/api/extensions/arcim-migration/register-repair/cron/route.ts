import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { runRegisterRepair } from '@/extensions/general/arcim-migration/lib/repair-imported-registers'

// crm#1436, one-off: brings the customer and supplier cards older imports
// wrote up to what the import writes today (repair-imported-registers).
// Remove this route, its vercel.json entry and the progress table once every
// company has an outcome.
export const maxDuration = 300
// The cutoff ends the reading: no company is started and no register page or
// detail batch is read after it. Card writes go on for a minute more
// (WRITE_GRACE_MS in the lib) and then stop where they are, so every company
// saves its cursor well inside maxDuration. Before the listing and the writes
// had a deadline, 27 runs in 30 days were ended at the limit (2026-11) and
// saved nothing for the companies they were working on.
const RUN_BUDGET_MS = 150_000

export const GET = withCronContext('cron.arcim_migration_register_repair', async (_request, ctx) => {
  const summary = await runRegisterRepair(createServiceClientNoCookies(), ctx.startedAt + RUN_BUDGET_MS)
  ctx.log.info('register repair run finished', summary)
  // No company's progress could be saved: the run did no lasting work, so it
  // answers as failed. One company's error is logged by the lib and the
  // others' work stands.
  if (summary.worked > 0 && summary.errors === summary.worked) {
    throw new Error(`register repair saved no progress: ${summary.errors} of ${summary.worked} companies failed`)
  }
  return NextResponse.json({ data: summary })
}, { requireExtension: 'arcim-migration' })
