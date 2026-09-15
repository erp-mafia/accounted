import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createServiceRoleClient } from '@/lib/supabase/service-client'
import { readUnreadDocuments } from '@/lib/documents/read/store'

/**
 * GET /api/documents/read/cron
 * Arkiv phase 1 backfill: reads the newest documents that have no page text
 * yet, a bounded batch per run. Every outcome stamps pages_read_at, so the
 * batch never revisits a row. Authenticated by CRON_SECRET (withCronContext).
 */
export const maxDuration = 300

const BATCH = 12

export const GET = withCronContext('documents.read', async (_request, ctx) => {
  const supabase = createServiceRoleClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  const counts = await readUnreadDocuments(supabase, BATCH)
  ctx.log.info('document read backfill', counts)
  return NextResponse.json({ ok: true, ...counts })
})
