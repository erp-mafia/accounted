import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { runDocumentImportContinuation } from '@/extensions/general/arcim-migration/lib/document-import-continuation'

// crm#1581: carries on an underlag run its tab left silent, from the cursor
// the run stopped at (document-import-continuation.ts).
export const maxDuration = 800
// The sweep starts no file after 11.5 minutes; the file in flight then, the
// fold and the release fit in the 100 s after it. A slice that still
// overruns is cut at the hard stop, before the platform ends the function.
const SWEEP_UNTIL_MS = 690_000
const HARD_STOP_MS = 770_000

export const GET = withCronContext('cron.arcim_migration_document_import', async (_request, ctx) => {
  const result = await runDocumentImportContinuation({
    supabase: createServiceClientNoCookies(),
    deadline: ctx.startedAt + SWEEP_UNTIL_MS,
    hardDeadline: ctx.startedAt + HARD_STOP_MS,
  })
  ctx.log.info('underlag continuation run finished', result)
  return NextResponse.json({ data: result })
}, { requireExtension: 'arcim-migration' })
