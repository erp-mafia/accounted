import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createServiceClient } from '@/lib/supabase/server'
import { sealLegacyConsentTokens } from '@/lib/providers/consent-tokens'

// Purge abandoned OAuth states and handoffs even when their consent is retained.
// Then seal a batch of provider tokens still stored in plaintext from before
// accounted#58; once none remain that step is two empty reads.
export const GET = withCronContext('cron.provider_oauth_cleanup', async (_request, ctx) => {
  const supabase = createServiceClient()
  const { count, error } = await supabase
    .from('provider_otc')
    .delete({ count: 'exact' })
    .lte('expires_at', new Date().toISOString())

  if (error) throw error

  const deleted = count ?? 0
  const tokens = await sealLegacyConsentTokens(supabase)
  ctx.log.info('provider OAuth cleanup summary', {
    deleted,
    legacyTokensFound: tokens.found,
    legacyTokensSealed: tokens.sealed,
  })
  return NextResponse.json({ data: { deleted, legacyTokensSealed: tokens.sealed } })
})
