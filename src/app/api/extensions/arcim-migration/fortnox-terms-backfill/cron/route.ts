import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { runFortnoxTermsBackfill } from '@/extensions/general/arcim-migration/lib/backfill-fortnox-terms'

// crm#1245, one-off: gives Fortnox-imported customers and suppliers the
// payment terms Fortnox holds for them (backfill-fortnox-terms). Remove this
// route, its vercel.json entry and the progress table once every company has
// an outcome.
export const maxDuration = 300
const RUN_BUDGET_MS = 240_000

export const GET = withCronContext('cron.arcim_migration_fortnox_terms_backfill', async (_request, ctx) => {
  const summary = await runFortnoxTermsBackfill(createServiceClientNoCookies(), ctx.startedAt + RUN_BUDGET_MS)
  ctx.log.info('fortnox terms backfill run finished', summary)
  return NextResponse.json({ data: summary })
}, { requireExtension: 'arcim-migration' })
