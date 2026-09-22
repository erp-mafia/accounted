import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createServiceClient } from '@/lib/supabase/server'

// Purge abandoned OAuth states and handoffs even when their consent is retained.
export const GET = withCronContext('cron.provider_oauth_cleanup', async (_request, ctx) => {
  const supabase = createServiceClient()
  const { count, error } = await supabase
    .from('provider_otc')
    .delete({ count: 'exact' })
    .lte('expires_at', new Date().toISOString())

  if (error) throw error

  const deleted = count ?? 0
  ctx.log.info('provider OAuth cleanup summary', { deleted })
  return NextResponse.json({ data: { deleted } })
})
