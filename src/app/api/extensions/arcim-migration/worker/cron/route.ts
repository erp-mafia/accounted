import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { loadExtensions } from '@/lib/extensions/loader'
import { extensionRegistry } from '@/lib/extensions/registry'
import { runProviderMigrationWorker } from '@/extensions/general/arcim-migration/lib/migration-job-worker'

export const maxDuration = 300

export const GET = withCronContext('cron.provider_migration_worker', async (_request, ctx) => {
  loadExtensions()
  if (!extensionRegistry.get('arcim-migration')) {
    return NextResponse.json({ data: { skipped: 'extension_disabled' } })
  }
  const result = await runProviderMigrationWorker()
  ctx.log.info('provider migration worker finished', result)
  return NextResponse.json({ data: result })
})
