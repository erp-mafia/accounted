import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'

const log = createLogger('sandbox:ensure-agent')

/**
 * Backfill a verified agent_profile for sandbox companies. Single source of
 * truth for the sandbox assistant's persona (name, avatar, atoms, summary):
 * the seed route, dashboard layout, dashboard page, and chat layout all call
 * through here so the profile data lives in exactly one place.
 *
 * `verified_by_user_id` is intentionally NULL: the row is synthetic seed
 * data, not a real user-driven verification. Attributing it to the calling
 * user would pollute the audit trail (and conflate consent on the GDPR
 * Art. 25(2) privacy-by-default surface).
 *
 * Best-effort: any error is logged and swallowed so the caller continues.
 * Worst case the user sees the pre-seed UI on this request; the next
 * request retries.
 *
 * Idempotent: the UNIQUE constraint on company_id makes the insert a no-op
 * once a profile exists.
 */
export async function ensureSandboxAgentProfile(
  supabase: SupabaseClient,
  companyId: string,
): Promise<void> {
  try {
    const { data: existing } = await supabase
      .from('agent_profiles')
      .select('id')
      .eq('company_id', companyId)
      .maybeSingle()
    if (existing) return

    const { error } = await supabase.from('agent_profiles').insert({
      company_id: companyId,
      display_name: 'Anna',
      avatar_id: 'notionists-3',
      horizontal_atoms: [
        'horizontal/swedish-vat',
        'horizontal/swedish-accounting-compliance',
      ],
      vertical_atoms: ['vertical/consulting'],
      modifier_atoms: [],
      profile_summary:
        'Du är Anna, en revisorsassistent för en svensk enskild firma som tillhandahåller IT-konsulttjänster i Stockholm. Företaget är momsregistrerat (kvartalsvis), använder kontantmetoden och fakturerar både svenska och utländska kunder.',
      source_signals: { is_sandbox: true },
      field_overrides: {},
      composer_model: 'sandbox-demo',
      composer_version: 1,
      composed_at: new Date().toISOString(),
      verified_at: new Date().toISOString(),
      verified_by_user_id: null,
      intake_completed_at: new Date().toISOString(),
    })
    if (error) {
      log.warn('failed to backfill sandbox agent_profile', { error, companyId })
    }
  } catch (err) {
    log.warn('unexpected error backfilling sandbox agent_profile', { error: err, companyId })
  }
}
