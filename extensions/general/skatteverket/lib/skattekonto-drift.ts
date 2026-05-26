import type { SupabaseClient } from '@supabase/supabase-js'
import type { ExtensionContext } from '@/lib/extensions/types'
import type { SkattekontoBalanceSnapshot } from '../types'
import { SKATTEKONTO_BALANCE_SNAPSHOT_KEY } from './skattekonto-sync'
import { createLogger } from '@/lib/logger'

const log = createLogger('skattekonto-drift')

const SKATTEKONTO_BAS_ACCOUNT = '1630'
const DRIFT_TOLERANCE_KEY = 'skattekonto_drift_tolerance'
const DRIFT_LAST_ALERT_KEY = 'skattekonto_drift_last_alert_at'
const DEFAULT_TOLERANCE_SEK = 1
const ALERT_THROTTLE_MS = 24 * 60 * 60 * 1000

export interface SkattekontoDrift {
  saldoSkatteverket: number
  glSum1630: number
  /** SKV saldo - GL 1630 sum. Positive: SKV thinks we owe more than GL says. */
  drift: number
  fetchedAt: number
  /** Tolerance used when this drift was computed, in SEK. */
  tolerance: number
  /** Skattekonto rows without journal_entry_id, dated <= fetchedAt. */
  unbookedRows: Array<{
    id: string
    transaktionsdatum: string
    belopp_skatteverket: number
    transaktionstext: string
  }>
}

export interface DriftAlertState {
  /** ms epoch of the last alert sent for this company. */
  lastAlertAt: number
  /** Sign of the drift at the last alert (-1, 0, +1). */
  lastSign: number
}

/**
 * Compute the difference between Skatteverket's cached saldo and the GL sum on
 * BAS 1630. Returns null when no snapshot exists yet (fresh company, never
 * synced).
 *
 * The comparison uses the snapshot's `fetchedAt` date as the GL cutoff: a
 * skattekonto sync at 04:00 today should only count GL entries posted with
 * entry_date <= today, otherwise a manual journal entry created in the same
 * day after the SKV pull would inflate the GL side and produce a false drift.
 */
export async function computeSkattekontoDrift(
  ctx: ExtensionContext,
): Promise<SkattekontoDrift | null> {
  const snapshot = await ctx.settings.get<SkattekontoBalanceSnapshot>(
    SKATTEKONTO_BALANCE_SNAPSHOT_KEY,
  )
  if (!snapshot) return null

  const fetchedDate = new Date(snapshot.fetchedAt).toISOString().slice(0, 10)
  const saldoSkatteverket = Number(snapshot.saldo.saldoSkatteverket) || 0

  const glSum1630 = await sumGl1630(ctx.supabase, ctx.companyId, fetchedDate)
  // SKV side and GL side use opposite sign conventions in this codebase:
  //   - SKV saldoSkatteverket > 0 means the taxpayer has a credit balance
  //     with SKV (money sitting at Skatteverket).
  //   - GL 1630 stores the SAME asset, so debit > credit means same direction
  //     as SKV credit balance.
  //   - sumGl1630 returns (sum(debit) - sum(credit)) which matches saldoSkatteverket.
  const drift = Math.round((saldoSkatteverket - glSum1630) * 100) / 100

  const toleranceSetting = await ctx.settings.get<number>(DRIFT_TOLERANCE_KEY)
  const tolerance = typeof toleranceSetting === 'number' && toleranceSetting > 0
    ? toleranceSetting
    : DEFAULT_TOLERANCE_SEK

  const unbookedRows = await listUnbookedRows(ctx.supabase, ctx.companyId, fetchedDate)

  return {
    saldoSkatteverket: Math.round(saldoSkatteverket * 100) / 100,
    glSum1630: Math.round(glSum1630 * 100) / 100,
    drift,
    fetchedAt: snapshot.fetchedAt,
    tolerance,
    unbookedRows,
  }
}

/**
 * Decide whether to emit `skattekonto.drift_detected` for this run, then update
 * the throttle state. Returns true when the event was emitted. Suppression
 * window is 24h unless the sign of the drift flips — a sign change means
 * something materially different is happening and the user should know.
 */
export async function maybeAlertDrift(
  ctx: ExtensionContext,
  drift: SkattekontoDrift,
): Promise<boolean> {
  if (Math.abs(drift.drift) <= drift.tolerance) return false

  const currentSign = Math.sign(drift.drift)
  const lastState = await ctx.settings.get<DriftAlertState>(DRIFT_LAST_ALERT_KEY)
  const now = Date.now()

  const withinThrottle =
    !!lastState &&
    now - lastState.lastAlertAt < ALERT_THROTTLE_MS &&
    lastState.lastSign === currentSign

  if (withinThrottle) {
    log.info('drift detected but within throttle window — skipping alert', {
      companyId: ctx.companyId,
      drift: drift.drift,
      lastAlertAt: lastState!.lastAlertAt,
    })
    return false
  }

  await ctx.emit({
    type: 'skattekonto.drift_detected',
    payload: {
      drift: drift.drift,
      saldoSkatteverket: drift.saldoSkatteverket,
      glSum1630: drift.glSum1630,
      fetchedAt: drift.fetchedAt,
      unbookedCount: drift.unbookedRows.length,
      userId: ctx.userId,
      companyId: ctx.companyId,
    },
  })

  await ctx.settings.set<DriftAlertState>(DRIFT_LAST_ALERT_KEY, {
    lastAlertAt: now,
    lastSign: currentSign,
  })

  return true
}

async function sumGl1630(
  supabase: SupabaseClient,
  companyId: string,
  cutoffDate: string,
): Promise<number> {
  const { data, error } = await supabase
    .from('journal_entry_lines')
    .select('debit_amount, credit_amount, journal_entries!inner(company_id, entry_date, status)')
    .eq('account_number', SKATTEKONTO_BAS_ACCOUNT)
    .eq('journal_entries.company_id', companyId)
    .eq('journal_entries.status', 'posted')
    .lte('journal_entries.entry_date', cutoffDate)

  if (error || !data) {
    log.warn('sumGl1630 failed', { companyId, cutoffDate, error: error?.message })
    return 0
  }

  let sum = 0
  for (const row of data as Array<{ debit_amount: number | string; credit_amount: number | string }>) {
    sum += Number(row.debit_amount || 0) - Number(row.credit_amount || 0)
  }
  return Math.round(sum * 100) / 100
}

async function listUnbookedRows(
  supabase: SupabaseClient,
  companyId: string,
  cutoffDate: string,
): Promise<SkattekontoDrift['unbookedRows']> {
  const { data, error } = await supabase
    .from('skattekonto_transactions')
    .select('id, transaktionsdatum, belopp_skatteverket, transaktionstext')
    .eq('company_id', companyId)
    .is('journal_entry_id', null)
    .lte('transaktionsdatum', cutoffDate)
    .order('transaktionsdatum', { ascending: false })
    .limit(50)

  if (error || !data) {
    log.warn('listUnbookedRows failed', { companyId, cutoffDate, error: error?.message })
    return []
  }
  return data as SkattekontoDrift['unbookedRows']
}
