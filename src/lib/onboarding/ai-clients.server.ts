import type { SupabaseClient } from '@supabase/supabase-js'
import { OAUTH_MCP_KEY_NAME } from '@/lib/auth/api-keys'
import { createLogger } from '@/lib/logger'
import { aiConnection, NO_AI_CONNECTION, type AiClient, type AiConnection } from '@/lib/onboarding/ai-clients'

const log = createLogger('onboarding-ai-clients')

/**
 * Whether this user has an agent connected over MCP OAuth, and which of
 * Claude / ChatGPT / Grok it is when known (see AiConnection). Server-only
 * (lib/auth/api-keys reaches node:crypto); the pure readout and the client
 * list live in ai-clients.ts.
 *
 * The connection follows the person, not the company: the key's company_id
 * is whatever was active at sign-in (or null for a companyless signup), so
 * the lookup is by user. Revoked keys do not count. Throws when the read
 * fails, for the caller that must tell "none connected" from "unknown".
 */
export async function readAiConnection(supabase: SupabaseClient, userId: string): Promise<AiConnection> {
  const { data, error } = await supabase
    .from('api_keys')
    .select('client')
    .eq('user_id', userId)
    .eq('name', OAUTH_MCP_KEY_NAME)
    .is('revoked_at', null)
  if (error) throw new Error(`Connected AI clients read failed: ${error.message}`)
  return aiConnection((data ?? []) as { client: string | null }[])
}

/** The verified clients only, for surfaces that hand work to a named client. Throws like readAiConnection. */
export async function readConnectedAiClients(supabase: SupabaseClient, userId: string): Promise<AiClient[]> {
  return (await readAiConnection(supabase, userId)).clients
}

/**
 * The connection where the readout only decorates a page or a button: a
 * failed read answers no connection rather than throwing, and is logged so a
 * degraded api_keys read stays visible to monitoring.
 */
export async function loadAiConnection(supabase: SupabaseClient, userId: string): Promise<AiConnection> {
  try {
    return await readAiConnection(supabase, userId)
  } catch (error) {
    log.warn('connected AI clients read failed, answering none', { userId, error })
    return NO_AI_CONNECTION
  }
}

/** The verified clients from loadAiConnection, for handoff buttons. Never throws. */
export async function loadConnectedAiClients(supabase: SupabaseClient, userId: string): Promise<AiClient[]> {
  return (await loadAiConnection(supabase, userId)).clients
}
