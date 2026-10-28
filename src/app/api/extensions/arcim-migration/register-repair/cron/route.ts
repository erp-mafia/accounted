import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { runRegisterRepair } from '@/extensions/general/arcim-migration/lib/repair-imported-registers'

// crm#1436, one-off: brings the customer and supplier cards older imports
// wrote up to what the import writes today (repair-imported-registers).
// Remove this route, its vercel.json entry and the progress table once every
// company has an outcome.
export const maxDuration = 300
// The cutoff stops new reads, not the ones in flight, a company's listing or
// its card writes, which can take more than a minute after it; a run the
// platform ends at maxDuration saves no company it was still working on.
const RUN_BUDGET_MS = 150_000

export const GET = withCronContext('cron.arcim_migration_register_repair', async (_request, ctx) => {
  const summary = await runRegisterRepair(createServiceClientNoCookies(), ctx.startedAt + RUN_BUDGET_MS)
  ctx.log.info('register repair run finished', summary)
  return NextResponse.json({ data: summary })
}, { requireExtension: 'arcim-migration' })
