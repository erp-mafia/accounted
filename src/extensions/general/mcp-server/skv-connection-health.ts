import type { SupabaseClient } from '@supabase/supabase-js'
import { findCompanyTokenUser, hasVerifiedGrant } from '@/extensions/general/skatteverket/lib/resolve-auth'
import { getSystemAuthMode, isSystemAuthConfigured } from '@/extensions/general/skatteverket/lib/system-auth/config'

export interface SkvConnectionHealth {
  status: 'active' | 'needs_reconsent'
  source: 'user' | 'system'
  connected_at?: string | null
  message?: string
}

export const SKV_NEEDS_RECONSENT_MESSAGE =
  'Skatteverket-sessionen har gått ut. Skatteverkets personliga inloggning gäller bara ca 1 timme, så detta är normalt. Be användaren ansluta igen med BankID under Inställningar → Skatteverket; bara en person kan göra det, så försök inte med Skatteverket-verktyg förrän användaren bekräftat.'

/**
 * Is the company's Skatteverket connection usable right now? One answer for
 * every tool that reports it: gnubok_get_agent_briefing and
 * gnubok_connect_skatteverket used to disagree, the connect tool saying
 * connected: true for a token row flagged needs_reconsent (feedback seq
 * 604946), so an agent that asked the tool built for the question got the
 * wrong answer.
 *
 * null = no connection at all (or the integration is off). Best-effort: a
 * lookup failure also answers null, never a thrown tool call.
 *
 * The system-before-user priority mirrors resolveReadAuth
 * (skatteverket/lib/resolve-auth.ts); not reused directly because callers
 * need token metadata (createdAt, reconsent status) that resolveReadAuth
 * deliberately collapses into an auth result.
 */
export async function getSkvConnectionHealth(
  supabase: SupabaseClient,
  companyId: string,
): Promise<SkvConnectionHealth | null> {
  try {
    if (process.env.SKATTEVERKET_ENABLED !== 'true') return null
    if (
      getSystemAuthMode() === 'on' &&
      isSystemAuthConfigured() &&
      (await hasVerifiedGrant(companyId, 'lasombud'))
    ) {
      return { status: 'active', source: 'system' }
    }
    const token = await findCompanyTokenUser(supabase, companyId)
    if (!token) return null
    if (token.needsReconsent) {
      return {
        status: 'needs_reconsent',
        source: 'user',
        connected_at: token.createdAt,
        message: SKV_NEEDS_RECONSENT_MESSAGE,
      }
    }
    return { status: 'active', source: 'user', connected_at: token.createdAt }
  } catch {
    return null
  }
}
