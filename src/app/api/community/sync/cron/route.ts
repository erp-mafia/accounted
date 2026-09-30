import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { syncCommunityFromRepo } from '@/lib/agent-skills/community-sync'
import { notifyPublishedAuthors } from '@/lib/agent-skills/community-notify'
import { ensureInitialized } from '@/lib/init'

// The email service is registered by the email extension.
ensureInitialized()

export const maxDuration = 60

/**
 * Hourly: what Accounted merged into erp-mafia/accounted-skills community/ is
 * published in the app, then each author whose item's page is now live on
 * accounted.se is told so ("Din instruktion är publicerad").
 */
export const GET = withCronContext('cron.community_sync', async (_request, ctx) => {
  const service = createServiceClientNoCookies()
  const result = await syncCommunityFromRepo(service)
  if (result.skipped.length > 0) ctx.log.warn('Community items skipped', { skipped: result.skipped })
  ctx.log.info('Community synced', { published: result.published.length, updated: result.updated.length, deactivated: result.deactivated.length, linked: result.linked.length, withdrawn: result.withdrawn.length })
  const notified = await notifyPublishedAuthors(service)
  if (notified.notified.length + notified.failed.length > 0) ctx.log.info('Authors told their item is published', { notified: notified.notified.length, waiting: notified.waiting.length, failed: notified.failed.length })
  return NextResponse.json({ data: { ...result, notified } })
})
