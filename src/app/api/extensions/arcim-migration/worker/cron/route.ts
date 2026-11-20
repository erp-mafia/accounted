import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { runProviderMigrationWorker } from '@/extensions/general/arcim-migration/lib/migration-job-worker'

export const maxDuration = 300

export const GET = withCronContext('cron.provider_migration_worker', async (_request, ctx) => {
  const result = await runProviderMigrationWorker()
  ctx.log.info('provider migration worker finished', result)
  return NextResponse.json({ data: result })
}, { requireExtension: 'arcim-migration' })
