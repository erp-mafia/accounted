import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'

const log = createLogger('agent.support.rate-limit')

/**
 * How many questions one user may put to the support assistant.
 *
 * Every company has the assistant, a company on trial included, and a trial
 * is open to anyone, so the limit is what bounds what one account can cost:
 * 60 questions a day is far above what support needs (the old question box
 * saw about one question per company every five days) and far below the
 * chat's 1000 a day.
 *
 * The counter is the chat's own (check_and_increment_agent_quota, one row per
 * user and window), so a question here and a turn in the chat count together
 * for as long as the chat exists. A user past the limit is told so and keeps
 * the form to a person.
 */
const MINUTE_MAX = 10
const DAY_MAX = 60

export interface SupportLimitResult {
  ok: boolean
  scope?: 'minute' | 'day'
}

export async function checkSupportRateLimit(supabase: SupabaseClient, userId: string): Promise<SupportLimitResult> {
  const { data, error } = await supabase.rpc('check_and_increment_agent_quota', {
    p_user_id: userId,
    p_minute_max: MINUTE_MAX,
    p_day_max: DAY_MAX,
  })
  if (error) {
    // Open on a failed read, as the chat's limiter is: the limit bounds
    // spend, and a counter that cannot be read must not close support.
    log.warn('support rate limit not read', { error: error.message })
    return { ok: true }
  }
  const result = (data ?? { ok: true }) as { ok: boolean; scope?: 'minute' | 'day' }
  return { ok: result.ok, scope: result.scope }
}

export const SUPPORT_DAY_LIMIT_MESSAGE = {
  sv: 'Du har nått dagens gräns för frågor till AI-assistenten. Skriv till supporten i stället, eller försök igen i morgon.',
  en: 'You have reached today\'s limit for questions to the AI assistant. Write to support instead, or try again tomorrow.',
} as const
