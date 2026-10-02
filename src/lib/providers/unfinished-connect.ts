import type { SupabaseClient } from '@supabase/supabase-js'
import type { ProviderName } from './types'

/**
 * A connect attempt younger than this may still be in progress: the customer
 * can be in the provider's login window, or reading the requirements there.
 */
export const UNFINISHED_CONNECT_MIN_AGE_MS = 30 * 60 * 1000

/** Display names for the provider in the recovery line. Client-safe. */
export const PROVIDER_DISPLAY_NAMES: Record<ProviderName, string> = {
  fortnox: 'Fortnox',
  visma: 'Visma',
  bokio: 'Bokio',
  bjornlunden: 'Björn Lundén',
  briox: 'Briox',
  wint: 'WINT',
}

export interface UnfinishedConnect {
  provider: ProviderName
  /** When the connect step opened (the consent row's created_at). */
  startedAt: string
}

/**
 * The company's latest provider connect that never got a token, or null.
 *
 * No table of its own: the consent row is the record of the attempt. POST
 * /connect writes a status-0 provider_consents row when the connect step
 * opens and deletes the provider's older token-less status-0 rows first, so
 * the newest status-0 row is the latest attempt. It counts as unfinished when
 * it is older than UNFINISHED_CONNECT_MIN_AGE_MS, has no token row, and the
 * customer has not moved on since: no accepted connection to the same
 * provider, no accepted connection started after it, and no completed SIE
 * import created after it.
 *
 * `service` must be a service-role client: provider_consent_tokens has no
 * user-facing RLS policy. Every query filters on `companyId`. A failed query
 * answers null: a recovery prompt is a nudge, and a wrong one tells a
 * connected customer their connection failed.
 */
export async function findUnfinishedConnect(
  service: SupabaseClient,
  companyId: string,
  now: Date = new Date(),
): Promise<UnfinishedConnect | null> {
  const { data: attempt, error } = await service
    .from('provider_consents')
    .select('id, provider, created_at')
    .eq('company_id', companyId)
    .eq('status', 0)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error || !attempt) return null

  const startedAt = Date.parse(attempt.created_at)
  if (!Number.isFinite(startedAt) || now.getTime() - startedAt < UNFINISHED_CONNECT_MIN_AGE_MS) {
    return null
  }

  const [tokens, accepted, laterImport] = await Promise.all([
    service
      .from('provider_consent_tokens')
      .select('consent_id')
      .eq('consent_id', attempt.id)
      .limit(1),
    service
      .from('provider_consents')
      .select('provider, created_at')
      .eq('company_id', companyId)
      .eq('status', 1),
    service
      .from('sie_imports')
      .select('id')
      .eq('company_id', companyId)
      .eq('status', 'completed')
      .gt('created_at', attempt.created_at)
      .limit(1),
  ])
  if (tokens.error || accepted.error || laterImport.error) return null
  if ((tokens.data ?? []).length > 0) return null
  if ((laterImport.data ?? []).length > 0) return null

  const movedOn = ((accepted.data ?? []) as { provider: string; created_at: string }[]).some(
    (c) => c.provider === attempt.provider || Date.parse(c.created_at) > startedAt,
  )
  if (movedOn) return null

  return { provider: attempt.provider as ProviderName, startedAt: attempt.created_at }
}
