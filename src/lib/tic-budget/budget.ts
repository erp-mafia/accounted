import type { SupabaseClient } from '@supabase/supabase-js'
import { addMonthsIso, todayIsoStockholm } from '@/lib/dates/iso'
import { createLogger } from '@/lib/logger'
import { ticBudgetServiceClient } from './service-client'

const log = createLogger('tic-budget')

/**
 * The central TIC Lens call budget.
 *
 * The contract is a fixed number of Lens calls per quota cycle (3,000; the
 * cycle resets on the 22nd). Every Lens call reserves one unit first through
 * the `reserve_external_call` RPC, which checks a per-purpose cap and the
 * total cap and increments in the same transaction, so concurrent serverless
 * instances can never pass the last unit twice.
 *
 * Onboarding's org-number lookup has priority: every other purpose stops at
 * the total minus a reserve, so a busy month of profile fetches can never
 * leave a new customer without the prefill. A refused reservation surfaces as
 * TIC's own rate-limit error, so every caller takes the degrade path it
 * already has (onboarding asks questions instead of prefilling, the snapshot
 * keeps its cache, the MCP lookup answers "unavailable").
 *
 * The RPC missing (the migration lands in a separate job after the deploy) or
 * any other database error fails OPEN with a warning: the budget is a guard on
 * spend, not an auth boundary, and TIC's own quota is still the backstop. A
 * definite deny fails CLOSED.
 */

export const TIC_PROVIDER = 'tic'

/** Why a Lens call is made. Threaded from the caller; 'other' when unknown. */
export const TIC_CALL_PURPOSES = [
  'onboarding_lookup',
  'composer',
  'refresh',
  'mcp_lookup',
  'profile',
  'other',
] as const

export type TicCallPurpose = (typeof TIC_CALL_PURPOSES)[number]

/** What a caller passes down to the Lens client. */
export interface TicCallContext {
  purpose?: TicCallPurpose
  /** Who spends (an API key id) for a per-subject daily cap; only mcp_lookup has one. */
  subject?: string | null
}

export function toTicCallPurpose(value: unknown): TicCallPurpose {
  return typeof value === 'string' && (TIC_CALL_PURPOSES as readonly string[]).includes(value)
    ? (value as TicCallPurpose)
    : 'other'
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const v = Number(raw)
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback
}

/** Purposes with priority: they may spend the reserve the others leave free. */
const PRIORITY_PURPOSES: ReadonlySet<TicCallPurpose> = new Set(['onboarding_lookup'])

/**
 * Default caps per purpose for a 3,000-call cycle. Onboarding lookup has no
 * purpose cap (it is bounded by the total). The rest add up to the total
 * minus the onboarding reserve (2,500), so the reserve is never eaten.
 */
const DEFAULT_PURPOSE_CAPS: Record<Exclude<TicCallPurpose, 'onboarding_lookup'>, number> = {
  composer: 1200,
  refresh: 600,
  mcp_lookup: 300,
  profile: 200,
  other: 200,
}

export interface TicBudgetCaps {
  total: number
  onboardingReserve: number
  /** null = no purpose cap (bounded by the total only). */
  purpose: Record<TicCallPurpose, number | null>
  mcpLookupPerKeyDaily: number
  cycleResetDay: number
}

export function ticBudgetCaps(): TicBudgetCaps {
  const total = intFromEnv('TIC_MONTHLY_CALL_BUDGET', 3000)
  const purpose = {
    onboarding_lookup: null,
  } as Record<TicCallPurpose, number | null>
  for (const [name, fallback] of Object.entries(DEFAULT_PURPOSE_CAPS)) {
    purpose[name as TicCallPurpose] = intFromEnv(`TIC_BUDGET_CAP_${name.toUpperCase()}`, fallback)
  }
  const resetDay = intFromEnv('TIC_BUDGET_CYCLE_DAY', 22)
  return {
    total,
    onboardingReserve: Math.min(intFromEnv('TIC_BUDGET_ONBOARDING_RESERVE', 500), total),
    purpose,
    mcpLookupPerKeyDaily: intFromEnv('TIC_MCP_LOOKUP_DAILY_PER_KEY', 20),
    // Day 29-31 does not exist in every month; clamp so every month has a reset.
    cycleResetDay: Math.min(Math.max(resetDay, 1), 28),
  }
}

/**
 * First day (YYYY-MM-DD, Stockholm calendar) of the quota cycle `now` falls
 * in: this month's reset day once it has come, otherwise last month's.
 */
export function ticCycleStart(now: Date = new Date(), resetDay = ticBudgetCaps().cycleResetDay): string {
  const today = todayIsoStockholm(now)
  const day = Number(today.slice(8, 10))
  const thisMonthReset = `${today.slice(0, 8)}${String(resetDay).padStart(2, '0')}`
  return day >= resetDay ? thisMonthReset : addMonthsIso(thisMonthReset, -1)
}

/** The total a purpose may spend up to: the whole cycle for a priority purpose, the rest stop short of the reserve. */
export function ticTotalCapFor(purpose: TicCallPurpose, caps: TicBudgetCaps = ticBudgetCaps()): number {
  return PRIORITY_PURPOSES.has(purpose) ? caps.total : caps.total - caps.onboardingReserve
}

export type TicReservation =
  | { ok: true; failedOpen?: boolean }
  | { ok: false; scope: 'total' | 'purpose' | 'subject' }

/** PostgREST / Postgres codes for "the RPC or its table is not there yet". */
const MISSING_CODES = new Set(['PGRST202', '42883', '42P01', 'PGRST205'])

/**
 * Reserve one Lens call for `ctx.purpose`. ok:false only on a definite deny
 * from the budget RPC; no database, a missing RPC or any other error answers
 * ok:true (failedOpen) after a warning.
 */
export async function reserveTicCall(
  ctx: TicCallContext = {},
  client: SupabaseClient | null = ticBudgetServiceClient(),
  now: Date = new Date(),
): Promise<TicReservation> {
  if (!client) return { ok: true, failedOpen: true }

  const purpose = toTicCallPurpose(ctx.purpose)
  const caps = ticBudgetCaps()
  const totalCap = ticTotalCapFor(purpose, caps)
  const subjectCap = purpose === 'mcp_lookup' && ctx.subject ? caps.mcpLookupPerKeyDaily : null

  try {
    const { data, error } = await client.rpc('reserve_external_call', {
      p_provider: TIC_PROVIDER,
      p_cycle_start: ticCycleStart(now, caps.cycleResetDay),
      p_purpose: purpose,
      p_purpose_cap: caps.purpose[purpose],
      p_total_cap: totalCap,
      p_subject: subjectCap === null ? null : ctx.subject,
      p_subject_day_cap: subjectCap,
    })
    if (error) {
      log.warn(
        MISSING_CODES.has(error.code ?? '')
          ? 'tic budget rpc missing, call allowed (fail open)'
          : 'tic budget rpc failed, call allowed (fail open)',
        { code: error.code, message: error.message, purpose },
      )
      return { ok: true, failedOpen: true }
    }
    const row = (data ?? {}) as { ok?: boolean; scope?: string }
    if (row.ok === false) {
      const scope = row.scope === 'purpose' || row.scope === 'subject' ? row.scope : 'total'
      log.warn('tic budget exhausted, call refused', { purpose, scope })
      return { ok: false, scope }
    }
    return { ok: true }
  } catch (err) {
    log.warn('tic budget rpc threw, call allowed (fail open)', {
      message: err instanceof Error ? err.message : String(err),
      purpose,
    })
    return { ok: true, failedOpen: true }
  }
}
