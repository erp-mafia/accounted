import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { TIC_PROVIDER } from './budget'
import { ticBudgetServiceClient } from './service-client'

const log = createLogger('tic-budget.cache')

/**
 * Shared cache of successful Lens answers, so every serverless instance reuses
 * a call any of them already paid for (the in-process cache in the TIC client
 * only covers one instance for five minutes). Keyed by the SHA-256 of the
 * endpoint string, which carries every parameter. Only successful answers are
 * written: errors, rate-limit answers and 404s never are, so a company
 * registered today is not hidden behind yesterday's miss. Everything here is
 * best effort: a read or write failure is a cache miss, never an error.
 *
 * TTL 24 h (TIC_CACHE_TTL_HOURS): registry data changes on filing cycles
 * measured in days. Company profiles additionally live 7 days on the
 * company's own snapshot (lib/agent/composer/tic-fetch), unchanged.
 */

function ttlMs(): number {
  const hours = Number(process.env.TIC_CACHE_TTL_HOURS)
  return (Number.isFinite(hours) && hours > 0 ? hours : 24) * 60 * 60 * 1000
}

export function ticCacheKey(endpoint: string): string {
  return createHash('sha256').update(endpoint).digest('hex')
}

export type TicCacheRead<T> = { hit: true; value: T } | { hit: false }

export async function readTicResponseCache<T>(
  endpoint: string,
  client: SupabaseClient | null = ticBudgetServiceClient(),
  now: Date = new Date(),
): Promise<TicCacheRead<T>> {
  if (!client) return { hit: false }
  try {
    const { data, error } = await client
      .from('external_call_cache')
      .select('response')
      .eq('provider', TIC_PROVIDER)
      .eq('cache_key', ticCacheKey(endpoint))
      .gt('expires_at', now.toISOString())
      .maybeSingle()
    if (error || !data) return { hit: false }
    return { hit: true, value: (data as { response: T }).response }
  } catch (err) {
    log.warn('tic cache read threw, treated as a miss', { message: err instanceof Error ? err.message : String(err) })
    return { hit: false }
  }
}

export async function writeTicResponseCache(
  endpoint: string,
  value: unknown,
  client: SupabaseClient | null = ticBudgetServiceClient(),
  now: Date = new Date(),
): Promise<void> {
  if (!client || value === null || value === undefined) return
  try {
    const { error } = await client.from('external_call_cache').upsert(
      {
        provider: TIC_PROVIDER,
        cache_key: ticCacheKey(endpoint),
        response: value,
        fetched_at: now.toISOString(),
        expires_at: new Date(now.getTime() + ttlMs()).toISOString(),
      },
      { onConflict: 'provider,cache_key' },
    )
    if (error) {
      log.warn('tic cache write failed', { code: error.code, message: error.message })
      return
    }
    // Purge what has expired, so the table holds at most one TTL of answers.
    await client.from('external_call_cache').delete().eq('provider', TIC_PROVIDER).lt('expires_at', now.toISOString())
  } catch (err) {
    log.warn('tic cache write threw', { message: err instanceof Error ? err.message : String(err) })
  }
}
