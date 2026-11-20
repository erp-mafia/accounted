import type { SupabaseClient } from '@supabase/supabase-js'
import { TIC_CALL_PURPOSES, TIC_PROVIDER, ticBudgetCaps, ticCycleStart, type TicBudgetCaps, type TicCallPurpose } from './budget'
import { ticProxyHeaders } from './proxy'
import { createLogger } from '@/lib/logger'

const log = createLogger('tic-budget.status')

/**
 * The ops read of the TIC budget: TIC's own count (the free health endpoint,
 * which costs no Lens call) next to ours. Their difference is spend this
 * application did not make: another client of the proxy, or a code path that
 * bypasses the budget. That gap is the number to watch.
 */

export interface TicUpstreamLimits {
  rateLimit: number | null
  rateLimitRemaining: number | null
  rateLimitReset: string | number | null
}

export interface TicBudgetStatus {
  configured: boolean
  cycleStart: string
  caps: TicBudgetCaps
  local: { total: number; byPurpose: Record<TicCallPurpose, number> } | null
  upstream: TicUpstreamLimits | null
  /** Calls TIC counted that we did not (upstream used minus local total), when both are known. */
  unattributed: number | null
}

const HEALTH_TIMEOUT_MS = 5_000

function numberOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}

/** Read `${TIC_API_PROXY_URL}?endpoint=/free/health`. Null when unconfigured or unreachable. */
export async function readTicUpstreamLimits(): Promise<TicUpstreamLimits | null> {
  const proxyUrl = process.env.TIC_API_PROXY_URL
  if (!proxyUrl) return null
  try {
    const res = await fetch(`${proxyUrl}?endpoint=${encodeURIComponent('/free/health')}`, {
      headers: ticProxyHeaders(),
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const body = (await res.json()) as Record<string, unknown> | null
    const limits = (body && typeof body.limits === 'object' && body.limits !== null ? body.limits : body) as
      | Record<string, unknown>
      | null
    if (!limits) return null
    const reset = limits.rateLimitReset
    return {
      rateLimit: numberOrNull(limits.rateLimit),
      rateLimitRemaining: numberOrNull(limits.rateLimitRemaining),
      rateLimitReset: typeof reset === 'string' || typeof reset === 'number' ? reset : null,
    }
  } catch (err) {
    log.warn('tic health read failed', { message: err instanceof Error ? err.message : String(err) })
    return null
  }
}

export async function readTicLocalCounters(
  client: SupabaseClient,
  cycleStart: string,
): Promise<{ total: number; byPurpose: Record<TicCallPurpose, number> } | null> {
  const { data, error } = await client
    .from('external_call_budget')
    .select('purpose, calls')
    .eq('provider', TIC_PROVIDER)
    .eq('cycle_start', cycleStart)
  if (error) return null
  const byPurpose = Object.fromEntries(TIC_CALL_PURPOSES.map((p) => [p, 0])) as Record<TicCallPurpose, number>
  let total = 0
  for (const row of (data ?? []) as { purpose: string; calls: number }[]) {
    if (row.purpose === '_total') total = row.calls
    else if (row.purpose in byPurpose) byPurpose[row.purpose as TicCallPurpose] = row.calls
  }
  return { total, byPurpose }
}

export async function readTicBudgetStatus(client: SupabaseClient, now: Date = new Date()): Promise<TicBudgetStatus> {
  const caps = ticBudgetCaps()
  const cycleStart = ticCycleStart(now, caps.cycleResetDay)
  const [local, upstream] = await Promise.all([readTicLocalCounters(client, cycleStart), readTicUpstreamLimits()])
  const upstreamUsed =
    upstream?.rateLimit != null && upstream.rateLimitRemaining != null
      ? upstream.rateLimit - upstream.rateLimitRemaining
      : null
  return {
    configured: Boolean(process.env.TIC_API_PROXY_URL),
    cycleStart,
    caps,
    local,
    upstream,
    unattributed: upstreamUsed != null && local ? upstreamUsed - local.total : null,
  }
}
