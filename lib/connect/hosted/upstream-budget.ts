import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Global upstream rate budget for the connector proxy.
 *
 * Enable Banking's quotas (Annex 1 §5: 20 rps / 300 rpm / 10 000 per hour) are
 * shared by ALL of Arcim's traffic, hosted included. So connector traffic gets
 * a ceiling well under those, reserved atomically in the DB (RPC
 * connector_reserve_upstream) so two proxy requests can't both slip past. A
 * self-hoster that hits the ceiling gets a 429 with Retry-After; hosted bank
 * sync is never starved because the connector ceiling is a fraction of the
 * provider quota.
 *
 * Configurable per service via env; the defaults sit around 30% of the EB
 * per-minute quota.
 */

export type UpstreamService = 'bank' | 'skatteverket'

interface Budget {
  minuteMax: number
  hourMax: number
}

function intFromEnv(name: string, fallback: number): number {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback
}

export function budgetFor(service: UpstreamService): Budget {
  if (service === 'bank') {
    return {
      minuteMax: intFromEnv('CONNECT_BANK_RPM_BUDGET', 90), // ~30% of EB's 300/min
      hourMax: intFromEnv('CONNECT_BANK_RPH_BUDGET', 3000), // ~30% of EB's 10 000/h
    }
  }
  return {
    minuteMax: intFromEnv('CONNECT_SKV_RPM_BUDGET', 120),
    hourMax: intFromEnv('CONNECT_SKV_RPH_BUDGET', 4000),
  }
}

export type BudgetResult = { ok: true } | { ok: false; scope: 'minute' | 'hour'; retryAfterSec: number }

/**
 * Reserve one upstream call. Returns ok:false with a Retry-After when the
 * global budget for this service is exhausted. A DB error fails OPEN (ok:true):
 * the budget is a protective cap, not an auth boundary, and blocking every
 * connector call because the counter table hiccuped would be worse than a
 * brief overshoot the provider itself also rate-limits.
 */
export async function reserveUpstream(
  supabase: SupabaseClient,
  service: UpstreamService,
): Promise<BudgetResult> {
  const { minuteMax, hourMax } = budgetFor(service)
  const { data, error } = await supabase.rpc('connector_reserve_upstream', {
    p_service: service,
    p_minute_max: minuteMax,
    p_hour_max: hourMax,
  })
  if (error) return { ok: true }
  const row = (data ?? {}) as { ok?: boolean; scope?: 'minute' | 'hour'; retry_after_sec?: number }
  if (row.ok === false) {
    return { ok: false, scope: row.scope ?? 'minute', retryAfterSec: row.retry_after_sec ?? 60 }
  }
  return { ok: true }
}
