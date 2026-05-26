import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Per-user rate limiter for the in-app AI agent's LLM endpoints
 * (/api/agent/invoke, /onboarding/stream, /composer). Backed by the
 * `check_and_increment_agent_quota` Postgres RPC (atomic check + increment) —
 * same shared store the rest of the app uses, no Upstash/env dependency.
 *
 * Limits are deliberately GENEROUS: a normal heavy user (dozens of turns a day)
 * never hits them. The cap exists only to bound runaway Bedrock spend from a
 * loop-firing session or reload-spammed onboarding. Keyed per-user.
 */
export interface AgentLimitResult {
  ok: boolean
  retryAfterSec?: number
  scope?: 'minute' | 'day'
}

const MINUTE_MAX = 30
const DAY_MAX = 1000

export async function checkAgentRateLimit(
  supabase: SupabaseClient,
  userId: string,
): Promise<AgentLimitResult> {
  const { data, error } = await supabase.rpc('check_and_increment_agent_quota', {
    p_user_id: userId,
    p_minute_max: MINUTE_MAX,
    p_day_max: DAY_MAX,
  })
  if (error) {
    // Fail open on infra error — the limiter is defense-in-depth; better to
    // serve a real user than to 429 them because the RPC blipped.
    console.error('[agent-rate-limit] RPC failed:', error)
    return { ok: true }
  }
  const result = (data ?? { ok: true }) as {
    ok: boolean
    scope?: 'minute' | 'day'
    retry_after_sec?: number
  }
  return { ok: result.ok, scope: result.scope, retryAfterSec: result.retry_after_sec }
}

/**
 * Standard 429 JSON body for a rate-limited agent request. The chat client
 * surfaces `error` verbatim, so keep it a friendly Swedish sentence.
 */
export function agentRateLimitResponseBody(result: AgentLimitResult): { error: string } {
  return {
    error:
      result.scope === 'day'
        ? 'Du har nått dagens gräns för förfrågningar till assistenten. Försök igen senare.'
        : 'För många förfrågningar till assistenten just nu. Vänta en stund och försök igen.',
  }
}
