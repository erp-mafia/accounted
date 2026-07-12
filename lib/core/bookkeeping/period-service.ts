import type { SupabaseClient } from '@supabase/supabase-js'
import { eventBus } from '@/lib/events'
import { validatePeriodDuration } from '@/lib/bookkeeping/validate-period-duration'
import type { FiscalPeriod, PeriodStatus } from '@/types'

/**
 * Lock a fiscal period: prevents new journal entries from being posted.
 * Requires: period exists, belongs to company, not already locked/closed.
 */
export async function lockPeriod(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  fiscalPeriodId: string
): Promise<FiscalPeriod> {

  // Fetch period
  const { data: period, error: fetchError } = await supabase
    .from('fiscal_periods')
    .select('*')
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .single()

  if (fetchError || !period) {
    throw new Error('Fiscal period not found')
  }

  if (period.is_closed) {
    throw new Error('Period is already closed')
  }

  if (period.locked_at) {
    throw new Error('Period is already locked')
  }

  // Check for uncategorized business transactions in this period
  const { count: unbookedCount } = await supabase
    .from('transactions')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .is('journal_entry_id', null)
    .eq('is_business', true)
    .gte('date', period.period_start)
    .lte('date', period.period_end)

  if (unbookedCount && unbookedCount > 0) {
    throw new Error(
      `Kan inte låsa period: ${unbookedCount} affärstransaktion(er) saknar bokföring. Bokför alla transaktioner innan perioden låses.`
    )
  }

  const { data: updated, error: updateError } = await supabase
    .from('fiscal_periods')
    .update({ locked_at: new Date().toISOString() })
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .select()
    .single()

  if (updateError || !updated) {
    throw new Error(`Failed to lock period: ${updateError?.message}`)
  }

  const result = updated as FiscalPeriod

  await eventBus.emit({
    type: 'period.locked',
    payload: { period: result, companyId, userId },
  })

  return result
}

/**
 * Unlock a fiscal period: clears `locked_at` so new entries can be posted.
 * Requires: period exists, belongs to company, is currently locked, not closed.
 */
export async function unlockPeriod(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  fiscalPeriodId: string
): Promise<FiscalPeriod> {
  const { data: period, error: fetchError } = await supabase
    .from('fiscal_periods')
    .select('*')
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .single()

  if (fetchError || !period) {
    throw new Error('Fiscal period not found')
  }

  if (period.is_closed) {
    throw new Error('Cannot unlock a closed period')
  }

  if (!period.locked_at) {
    throw new Error('Period is not locked')
  }

  const priorLockedAt = period.locked_at

  const { data: updated, error: updateError } = await supabase
    .from('fiscal_periods')
    .update({ locked_at: null })
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .select()
    .single()

  if (updateError || !updated) {
    throw new Error(`Failed to unlock period: ${updateError?.message}`)
  }

  const result = updated as FiscalPeriod

  // BFNAR 2013:2 kap. 8 (behandlingshistorik): unlocking a locked period is a
  // sensitive control change. Persist it to the immutable audit_log (not just
  // event_log, which has 30-day TTL) so an auditor can reconstruct who
  // unlocked which period and when, even years later.
  await supabase.from('audit_log').insert({
    user_id: userId,
    company_id: companyId,
    action: 'UPDATE',
    table_name: 'fiscal_periods',
    record_id: fiscalPeriodId,
    description: `Period unlocked: ${result.name} (${result.period_start} to ${result.period_end})`,
    old_state: { locked_at: priorLockedAt },
    new_state: { locked_at: null },
  })

  await eventBus.emit({
    type: 'period.unlocked',
    payload: { period: result, companyId, userId },
  })

  return result
}

/**
 * Close a fiscal period: marks it as permanently closed.
 * Requires: period is locked AND closing_entry_id is set (year-end must run first).
 */
export async function closePeriod(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  fiscalPeriodId: string
): Promise<FiscalPeriod> {

  const { data: period, error: fetchError } = await supabase
    .from('fiscal_periods')
    .select('*')
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .single()

  if (fetchError || !period) {
    throw new Error('Fiscal period not found')
  }

  if (period.is_closed) {
    throw new Error('Period is already closed')
  }

  if (!period.locked_at) {
    throw new Error('Period must be locked before closing')
  }

  if (!period.closing_entry_id) {
    throw new Error('Year-end closing must be executed before closing the period')
  }

  const { data: updated, error: updateError } = await supabase
    .from('fiscal_periods')
    .update({
      is_closed: true,
      closed_at: new Date().toISOString(),
    })
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .select()
    .single()

  if (updateError || !updated) {
    throw new Error(`Failed to close period: ${updateError?.message}`)
  }

  return updated as FiscalPeriod
}

/**
 * Create the next fiscal period following the current one.
 * Computes dates based on the current period's length (handles brutet räkenskapsår).
 * Sets previous_period_id for chain validation.
 */
export async function createNextPeriod(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  currentPeriodId: string
): Promise<FiscalPeriod> {

  const { data: current, error: fetchError } = await supabase
    .from('fiscal_periods')
    .select('*')
    .eq('id', currentPeriodId)
    .eq('company_id', companyId)
    .single()

  if (fetchError || !current) {
    throw new Error('Current fiscal period not found')
  }

  // Compute next period start (day after current end) in pure UTC, see
  // findNextPeriod for the DST off-by-one rationale.
  const nextStart = new Date(current.period_end + 'T00:00:00Z')
  nextStart.setUTCDate(nextStart.getUTCDate() + 1)

  // After a broken first fiscal year, subsequent years should always be
  // 12 months (standard fiscal year). The first year is the only one that
  // can be longer/shorter than 12 months per BFL 3 kap.
  const nextEnd = new Date(nextStart)
  nextEnd.setUTCMonth(nextEnd.getUTCMonth() + 12)
  // Go to last day of the previous month: setUTCDate(0) rolls back into
  // the prior month's last day.
  nextEnd.setUTCDate(0)

  const nextStartStr = nextStart.toISOString().slice(0, 10)
  const nextEndStr = nextEnd.toISOString().slice(0, 10)

  // Validate period duration: subsequent periods always start on 1st of month
  const durationError = validatePeriodDuration(nextStartStr, nextEndStr, { isFirstPeriod: false })
  if (durationError) {
    throw new Error(durationError)
  }

  // Check for overlapping periods
  const { data: overlapping } = await supabase
    .from('fiscal_periods')
    .select('id')
    .eq('company_id', companyId)
    .lte('period_start', nextEndStr)
    .gte('period_end', nextStartStr)
    .limit(1)

  if (overlapping && overlapping.length > 0) {
    throw new Error('Next fiscal period already exists or overlaps with an existing period')
  }

  // Generate name: e.g. "FY 2025" or "FY 2025/2026"
  const startYear = nextStart.getUTCFullYear()
  const endYear = nextEnd.getUTCFullYear()
  const name = startYear === endYear ? `FY ${startYear}` : `FY ${startYear}/${endYear}`

  const { data: newPeriod, error: insertError } = await supabase
    .from('fiscal_periods')
    .insert({
      company_id: companyId,
      user_id: userId,
      name,
      period_start: nextStartStr,
      period_end: nextEndStr,
      previous_period_id: currentPeriodId,
    })
    .select()
    .single()

  if (insertError || !newPeriod) {
    throw new Error(`Failed to create next period: ${insertError?.message}`)
  }

  return newPeriod as FiscalPeriod
}

/**
 * Look up the next fiscal period after the given one without creating it.
 *
 * Used by year-end closing to handle the common case where the next period
 * was already created (e.g. by SIE import, manual creation, or a previous
 * partial year-end run). Returns null when no such period exists.
 *
 * Matches first on previous_period_id chain, then falls back to a
 * period_start = (current.period_end + 1 day) lookup so periods created
 * before the chain was wired up are still recognised.
 */
export async function findNextPeriod(
  supabase: SupabaseClient,
  companyId: string,
  currentPeriodId: string
): Promise<FiscalPeriod | null> {
  const { data: current, error: fetchError } = await supabase
    .from('fiscal_periods')
    .select('*')
    .eq('id', currentPeriodId)
    .eq('company_id', companyId)
    .single()

  if (fetchError || !current) {
    return null
  }

  const { data: chained } = await supabase
    .from('fiscal_periods')
    .select('*')
    .eq('company_id', companyId)
    .eq('previous_period_id', currentPeriodId)
    .maybeSingle()

  if (chained) {
    return chained as FiscalPeriod
  }

  // UTC-only arithmetic: anchor the date string at UTC midnight, then
  // advance via setUTCDate. Using Date(string) + setDate/getDate causes an
  // off-by-one on servers in TZ+ when the day after period_end crosses a
  // DST spring-forward, because setDate(local) writes local-time fields
  // and toISOString() converts back through the shifted offset.
  const expectedStartStr = addDaysUTC(current.period_end, 1)

  const { data: byDate } = await supabase
    .from('fiscal_periods')
    .select('*')
    .eq('company_id', companyId)
    .eq('period_start', expectedStartStr)
    .maybeSingle()

  return (byDate as FiscalPeriod | null) ?? null
}

/** Add `days` to a YYYY-MM-DD string in pure UTC and return YYYY-MM-DD. */
function addDaysUTC(isoDate: string, days: number): string {
  const d = new Date(isoDate + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/**
 * Create a previous fiscal period before the given one.
 * Computes a 12-month period ending the day before the given period starts.
 * Updates previous_period_id chain so the given period points to the new one.
 */
export async function createPreviousPeriod(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  currentPeriodId: string
): Promise<FiscalPeriod> {

  const { data: current, error: fetchError } = await supabase
    .from('fiscal_periods')
    .select('*')
    .eq('id', currentPeriodId)
    .eq('company_id', companyId)
    .single()

  if (fetchError || !current) {
    throw new Error('Current fiscal period not found')
  }

  // Compute previous period end (day before current start)
  const prevEnd = new Date(current.period_start + 'T12:00:00Z')
  prevEnd.setUTCDate(prevEnd.getUTCDate() - 1)

  // Compute previous period start (1st of month, 12 months before prevEnd)
  const prevStart = new Date(prevEnd)
  prevStart.setUTCMonth(prevStart.getUTCMonth() - 11)
  prevStart.setUTCDate(1)

  const prevStartStr = prevStart.toISOString().split('T')[0]
  const prevEndStr = prevEnd.toISOString().split('T')[0]

  // Validate period duration
  const durationError = validatePeriodDuration(prevStartStr, prevEndStr, { isFirstPeriod: false })
  if (durationError) {
    throw new Error(durationError)
  }

  // Check for overlapping periods
  const { data: overlapping } = await supabase
    .from('fiscal_periods')
    .select('id')
    .eq('company_id', companyId)
    .lte('period_start', prevEndStr)
    .gte('period_end', prevStartStr)
    .limit(1)

  if (overlapping && overlapping.length > 0) {
    throw new Error('Previous fiscal period already exists or overlaps with an existing period')
  }

  // Generate name
  const startYear = prevStart.getFullYear()
  const endYear = prevEnd.getFullYear()
  const name = startYear === endYear ? `FY ${startYear}` : `FY ${startYear}/${endYear}`

  const { data: newPeriod, error: insertError } = await supabase
    .from('fiscal_periods')
    .insert({
      company_id: companyId,
      user_id: userId,
      name,
      period_start: prevStartStr,
      period_end: prevEndStr,
    })
    .select()
    .single()

  if (insertError || !newPeriod) {
    throw new Error(`Failed to create previous period: ${insertError?.message}`)
  }

  // Update the current period to point to the new one
  const { error: updateError } = await supabase
    .from('fiscal_periods')
    .update({ previous_period_id: newPeriod.id })
    .eq('id', currentPeriodId)
    .eq('company_id', companyId)

  if (updateError) {
    throw new Error(`Failed to update period chain: ${updateError.message}`)
  }

  return newPeriod as FiscalPeriod
}

export type PeriodStatusValue = 'open' | 'locked' | 'closed'

export interface PeriodStatusForDate {
  period_id: string | null
  status: PeriodStatusValue
  /**
   * For `locked` status: either the period's `locked_at` timestamp (ISO) or the
   * company-wide `bookkeeping_locked_through` date (ISO), whichever applies.
   * `null` for open/closed.
   */
  lock_date: string | null
}

/**
 * Resolve the period status for a given affärshändelse date: answers
 * "can a verifikation with this entry_date be posted right now?" using the
 * same two-layer logic the DB triggers enforce:
 *
 *   1. company-wide bookkeeping_locked_through (covers everything on/before)
 *   2. the fiscal_period covering the date (is_closed or locked_at)
 *
 * Returned shape is the canonical `period_status` envelope threaded into MCP
 * tool responses so agents and widgets can disable writes without round-trips.
 *
 * Mirrors lib/api/v1/check-period-lock.ts (used by the v1 REST surface). The
 * two helpers share the same query pattern; if either changes, update both.
 */
export async function resolvePeriodStatusForDate(
  supabase: SupabaseClient,
  companyId: string,
  date: string,
): Promise<PeriodStatusForDate> {
  // Layer 1: company-wide lock date.
  const { data: settings } = await supabase
    .from('company_settings')
    .select('bookkeeping_locked_through')
    .eq('company_id', companyId)
    .maybeSingle()
  const lockThrough = settings?.bookkeeping_locked_through ?? null
  if (lockThrough && date <= lockThrough) {
    // Find the covering period if any: useful for widget greying.
    const { data: period } = await supabase
      .from('fiscal_periods')
      .select('id')
      .eq('company_id', companyId)
      .lte('period_start', date)
      .gte('period_end', date)
      .maybeSingle()
    return { period_id: period?.id ?? null, status: 'locked', lock_date: lockThrough }
  }

  // Layer 2: fiscal period status.
  const { data: period } = await supabase
    .from('fiscal_periods')
    .select('id, is_closed, locked_at')
    .eq('company_id', companyId)
    .lte('period_start', date)
    .gte('period_end', date)
    .maybeSingle()

  if (!period) {
    // No covering period: treated as open at this layer; the engine's own
    // ensure-period helper will create one. Agents should still warn the user.
    return { period_id: null, status: 'open', lock_date: null }
  }
  if (period.is_closed) {
    return { period_id: period.id, status: 'closed', lock_date: null }
  }
  if (period.locked_at) {
    return { period_id: period.id, status: 'locked', lock_date: period.locked_at }
  }
  return { period_id: period.id, status: 'open', lock_date: null }
}

/**
 * Get status summary for a fiscal period.
 */
export async function getPeriodStatus(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  fiscalPeriodId: string
): Promise<PeriodStatus> {

  const { data: period, error: fetchError } = await supabase
    .from('fiscal_periods')
    .select('*')
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .single()

  if (fetchError || !period) {
    throw new Error('Fiscal period not found')
  }

  // Count draft entries in this period
  const { count: draftCount } = await supabase
    .from('journal_entries')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('fiscal_period_id', fiscalPeriodId)
    .eq('status', 'draft')

  // Check if next period exists via the chain pointer
  const { data: nextPeriod } = await supabase
    .from('fiscal_periods')
    .select('id')
    .eq('company_id', companyId)
    .eq('previous_period_id', fiscalPeriodId)
    .maybeSingle()

  return {
    is_locked: !!period.locked_at,
    is_closed: period.is_closed,
    has_closing_entry: !!period.closing_entry_id,
    has_opening_balances: period.opening_balances_set,
    draft_count: draftCount ?? 0,
    next_period_exists: !!nextPeriod,
  }
}
