import type { SupabaseClient } from '@supabase/supabase-js'
import { OAUTH_MCP_KEY_NAME } from '@/lib/auth/api-keys'
import { createLogger } from '@/lib/logger'
import { connectedAiClients, type AiClient } from '@/lib/onboarding/ai-clients'

const log = createLogger('onboarding-ai-clients')

/**
 * Which of Claude / ChatGPT / Grok this user has connected over MCP OAuth.
 * Server-only (lib/auth/api-keys reaches node:crypto); the pure readout and
 * the client list live in ai-clients.ts.
 *
 * The connection follows the person, not the company: the key's company_id
 * is whatever was active at sign-in (or null for a companyless signup), so
 * the lookup is by user. Revoked keys do not count. Throws when the read
 * fails, for the caller that must tell "none connected" from "unknown".
 */
export async function readConnectedAiClients(supabase: SupabaseClient, userId: string): Promise<AiClient[]> {
  const { data, error } = await supabase
    .from('api_keys')
    .select('client')
    .eq('user_id', userId)
    .eq('name', OAUTH_MCP_KEY_NAME)
    .is('revoked_at', null)
  if (error) throw new Error(`Connected AI clients read failed: ${error.message}`)
  return connectedAiClients((data ?? []) as { client: string | null }[])
}

/**
 * The same read where the readout only decorates a button: a failed read
 * answers an empty list rather than throwing, and is logged so a degraded
 * api_keys read stays visible to monitoring.
 */
export async function loadConnectedAiClients(supabase: SupabaseClient, userId: string): Promise<AiClient[]> {
  try {
    return await readConnectedAiClients(supabase, userId)
  } catch (error) {
    log.warn('connected AI clients read failed, answering none', { userId, error })
    return []
  }
}
