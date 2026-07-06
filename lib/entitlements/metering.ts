import type { SupabaseClient } from '@supabase/supabase-js'
import type { CapabilityKey } from './keys'

/**
 * Append a usage event to metered_events. Best-effort and non-blocking:
 * metering must never break the feature it measures, so failures are swallowed.
 *
 * Usage cannot be backfilled, so we capture it from day one even though no
 * usage-based pricing exists yet: it is the raw material for future firm-level
 * "active company" / consumption billing.
 */
export async function recordMeteredEvent(
  supabase: SupabaseClient,
  params: {
    companyId: string
    teamId?: string | null
    key: CapabilityKey
    eventType: string
    attribution?: Record<string, unknown>
  },
): Promise<void> {
  try {
    await supabase.from('metered_events').insert({
      company_id: params.companyId,
      team_id: params.teamId ?? null,
      capability_key: params.key,
      event_type: params.eventType,
      attribution: params.attribution ?? {},
    })
  } catch {
    // best-effort; never block the metered operation
  }
}
