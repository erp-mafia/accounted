import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'

const log = createLogger('sandbox:ensure-agent')

/**
 * The sandbox assistant is called "Assistenten", not a first name.
 *
 * A named persona is right once someone has been through onboarding and chosen
 * it: it is their assistant, and they named it. In the sandbox nobody chose
 * anything, so a first name reads as a character the product invented and
 * implies a relationship the visitor has not opted into. "Assistenten" says
 * what it is.
 *
 * The summary is the agent's own self-description in the system prompt, so it
 * has to agree with the display name: otherwise the header says one thing and
 * the assistant introduces itself as another in its first sentence.
 */
export const SANDBOX_AGENT_NAME = 'Assistenten'

export const SANDBOX_PROFILE_SUMMARY =
  'Du är Assistenten, en revisorsassistent för en svensk enskild firma som tillhandahåller IT-konsulttjänster i Stockholm. Företaget är momsregistrerat (kvartalsvis), använder kontantmetoden och fakturerar både svenska och utländska kunder.'

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
      display_name: SANDBOX_AGENT_NAME,
      avatar_id: 'notionists-3',
      horizontal_atoms: [
        'horizontal/swedish-vat',
        'horizontal/swedish-accounting-compliance',
      ],
      vertical_atoms: ['vertical/consulting'],
      modifier_atoms: [],
      profile_summary: SANDBOX_PROFILE_SUMMARY,
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
