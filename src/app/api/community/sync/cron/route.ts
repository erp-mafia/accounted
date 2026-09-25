import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { syncCommunityFromRepo } from '@/lib/agent-skills/community-sync'

export const maxDuration = 60

/** Hourly: what Accounted merged into erp-mafia/accounted-skills community/ is published in the app. */
export const GET = withCronContext('cron.community_sync', async (_request, ctx) => {
  const result = await syncCommunityFromRepo(createServiceClientNoCookies())
  if (result.skipped.length > 0) ctx.log.warn('Community items skipped', { skipped: result.skipped })
  ctx.log.info('Community synced', { published: result.published.length, updated: result.updated.length, deactivated: result.deactivated.length, linked: result.linked.length })
  return NextResponse.json({ data: result })
})
