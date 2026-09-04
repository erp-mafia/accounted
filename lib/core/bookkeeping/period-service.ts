import type { SupabaseClient } from '@supabase/supabase-js'
import { eventBus } from '@/lib/events'
import { createLogger } from '@/lib/logger'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { validatePeriodDuration } from '@/lib/bookkeeping/validate-period-duration'
import { addDaysIso } from '@/lib/dates/iso'
import type { FiscalPeriod } from '@/types'

const log = createLogger('period-service')

/**
 * The two ways a bank transaction can still owe the period a verifikation.
 *
 * Triage is the act of answering "is this an affärshändelse for the company?".
 * The three answers, and what each means for a period lock:
 *
 *   is_business IS NULL, is_ignored = false -> NOT TRIAGED. Nobody has looked
 *       at it. Counted as `untriaged`; blocks.
 *   is_business = true                      -> TRIAGED AS A BUSINESS EVENT. It
 *       owes a verifikation. Blocks unless it already has one (see below);
 *       counted as `businessUnbooked` when it does not.
 *   is_business = false                     -> TRIAGED AND EXCLUDED (privat
 *       uttag / not the company's affär). Never blocks: there is nothing to
 *       bokföra, and holding a lock hostage to a private coffee is over-
 *       blocking, not compliance.
 *   is_ignored = true                       -> TRIAGED AND EXCLUDED, the user's
 *       explicit "hide this, never going to book it" (migration
 *       20260529190000). Never blocks. The column is NOT NULL DEFAULT false,
 *       so `.eq('is_ignored', false)` cannot silently drop rows.
 *
 * "Already has a verifikation" is deliberately NOT `journal_entry_id IS NOT
 * NULL`. That column only covers the 1:1 case; bulk-booked (N tx -> 1 JE, via
 * transaction_voucher_links) and multi-allocated (invoice_payments /
 * supplier_invoice_payments) transactions stay NULL while being anchored to a
 * real verifikat. See lib/transactions/is-booked.ts and its Postgres mirror
 * public.is_transaction_booked(uuid); this helper reproduces all three
 * locations so the guard does not block on already-booked rows.
 */
export interface UnbookedInPeriod {
  /** Never triaged: is_business IS NULL AND is_ignored = false. */
  untriaged: number
  /** Triaged as a business event but anchored to no verifikat at all. */
  businessUnbooked: number
}

/** PostgREST rejects very long URLs, so `.in()` lists are chunked. */
const ANCHOR_LOOKUP_CHUNK = 200

/**
 * Count the bank transactions in [periodStart, periodEnd] that a period lock
 * would strand. Throws on any query failure so the caller can fail closed:
 * never return 0 for a check that did not actually run.
 */
export async function countUnbookedInPeriod(
  supabase: SupabaseClient,
  companyId: string,
  periodStart: string,
  periodEnd: string,
): Promise<UnbookedInPeriod> {
  // Leg 1: never triaged. This is the canonical "att bokföra" predicate from
  // lib/worklist/categories.ts, so the number here reconciles with the
  // "N st att bokföra" badge instead of being a second, unexplainable count.
  // Served by the partial index idx_transactions_company_unbooked.
  const { count: untriaged, error: untriagedError } = await supabase
    .from('transactions')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .is('is_business', null)
    .eq('is_ignored', false)
    .gte('date', periodStart)
    .lte('date', periodEnd)
  if (untriagedError) {
    throw new Error(`untriaged transaction count failed: ${untriagedError.message}`)
  }

  // Leg 2: triaged as a business event, but no verifikat anywhere. The user has
  // already confirmed this is the company's affärshändelse, so a lock strands
  // it just as hard as an untriaged one, only with less excuse. Fetch the ids
  // and subtract the ones anchored via the non-denormalized locations.
  //
  // Paginated via fetchAllRows with a stable id order: PostgREST silently caps
  // a bare select at 1000 rows, and this candidate set is NOT bounded in
  // practice, because bulk-booked transactions keep journal_entry_id NULL
  // (anchored only via transaction_voucher_links). An unpaginated read would
  // drop every candidate past row 1000, under-counting businessUnbooked and
  // letting a period lock while genuinely unbooked affärshändelser are
  // stranded in it (BFL 5 kap 2 §).
  let candidates: Array<{ id?: string }>
  try {
    candidates = await fetchAllRows<{ id?: string }>(({ from, to }) =>
      supabase
        .from('transactions')
        .select('id')
        .eq('company_id', companyId)
        .eq('is_business', true)
        .eq('is_ignored', false)
        .is('journal_entry_id', null)
        .gte('date', periodStart)
        .lte('date', periodEnd)
        .order('id', { ascending: true })
        .range(from, to)
    )
  } catch (err) {
    throw new Error(
      `business transaction lookup failed: ${err instanceof Error ? err.message : String(err)}`
    )
  }

  const candidateIds = candidates
    .map((row) => row.id)
    .filter((id): id is string => typeof id === 'string')
  if (candidateIds.length === 0) {
    return { untriaged: untriaged ?? 0, businessUnbooked: 0 }
  }

  const anchored = new Set<string>()
  for (const table of ['transaction_voucher_links', 'invoice_payments', 'supplier_invoice_payments'] as const) {
    for (let i = 0; i < candidateIds.length; i += ANCHOR_LOOKUP_CHUNK) {
      const chunk = candidateIds.slice(i, i + ANCHOR_LOOKUP_CHUNK)
      const { data, error } = await supabase
        .from(table)
        .select('transaction_id')
        .in('transaction_id', chunk)
      if (error) {
        throw new Error(`${table} anchor lookup failed: ${error.message}`)
      }
      for (const row of data ?? []) {
        const id = (row as { transaction_id?: string | null }).transaction_id
        if (id) anchored.add(id)
      }
    }
  }

  return {
    untriaged: untriaged ?? 0,
    businessUnbooked: candidateIds.filter((id) => !anchored.has(id)).length,
  }
}

/**
 * The company's earliest fiscal_periods.period_start (ISO date), or null when
 * no fiscal period exists yet (brand-new company before onboarding created
 * one). This is the company's "bookkeeping starts here" boundary: external
 * mirrors (e.g. the skattekonto sync) use it as a lower fetch bound, and
 * booking flows use it to tell "row predates the first rakenskapsar" apart
 * from an ordinary locked period.
 */
export async function getEarliestFiscalPeriodStart(
  supabase: SupabaseClient,
  companyId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('fiscal_periods')
    .select('period_start')
    .eq('company_id', companyId)
    .order('period_start', { ascending: true })
    .limit(1)

  if (error || !data || data.length === 0) return null
  const start = (data[0] as { period_start?: unknown }).period_start
  return typeof start === 'string' ? start : null
}

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

  // Refuse to lock while the period still holds bank transactions that would be
  // stranded. BFL 5 kap 2 § requires every affärshändelse to be bokförd in the
  // period it belongs to; once locked_at is set the enforce_period_lock trigger
  // makes these rows unbookable in place, leaving affärshändelser that can only
  // be entered by unlocking again or via a rättelse.
  //
  // Hard block, not an advisory warning with a bypass. There is no legitimate
  // "lock anyway" case: locking is a voluntary internal control with no legal
  // deadline, while the affärshändelser it would strand do have one (BFL 5 kap
  // 2 §: kontant senast nästa arbetsdag, övrigt "så snart det kan ske").
  // Every escape hatch the user could want is already an exit from the
  // predicate and is named in the message: book it, mark it privat, or mark it
  // ignored. Locking first and unlocking later is strictly worse, because the
  // unlock lands in the immutable audit_log as a control override.
  let unbooked: UnbookedInPeriod
  try {
    unbooked = await countUnbookedInPeriod(
      supabase,
      companyId,
      period.period_start,
      period.period_end,
    )
  } catch (err) {
    // Fail closed. A guard that cannot run must not wave the lock through:
    // that is exactly how the previous dead predicate went unnoticed.
    log.error('unbooked-transaction guard failed, refusing to lock', {
      companyId,
      fiscalPeriodId,
      reason: err instanceof Error ? err.message : String(err),
    })
    throw new Error(
      'Kunde inte kontrollera obokförda banktransaktioner i perioden. Perioden lämnas olåst. Försök igen.'
    )
  }

  const blockingCount = unbooked.untriaged + unbooked.businessUnbooked
  if (blockingCount > 0) {
    // Message wording is load-bearing for two separate matchers; keep both
    // phrases when editing:
    //   - "saknar bokföring" -> both lock routes map this to the
    //     PERIOD_HAS_UNBOOKED_TRANSACTIONS envelope (400) instead of a 500
    //     (app/api/bookkeeping/fiscal-periods/[id]/lock/route.ts and
    //      app/api/v1/companies/[companyId]/fiscal-periods/[id]/lock/route.ts)
    //   - /Kan inte låsa period:.*affärstransaktion/ -> inferCode() in
    //     lib/errors/get-structured-error.ts derives the same code for the
    //     MCP/agent surfaces, which have no HTTP envelope to read. The word
    //     "affärstransaktion" therefore has to appear unconditionally, not
    //     only in the breakdown clause that the untriaged-only case omits.
    // The infra message above deliberately matches neither: an unreachable DB
    // must not send an agent off remediating transactions.
    const breakdown = [
      unbooked.untriaged > 0 ? `${unbooked.untriaged} ej hanterade` : null,
      unbooked.businessUnbooked > 0
        ? `${unbooked.businessUnbooked} markerade som affärshändelse men utan verifikat`
        : null,
    ]
      .filter(Boolean)
      .join(', ')
    throw new Error(
      `Kan inte låsa period: ${blockingCount} banktransaktion(er) i perioden saknar bokföring ` +
        `(${breakdown}). Alla affärstransaktioner måste vara bokförda innan perioden låses. ` +
        `Gå till Transaktioner, bokför dem eller markera dem som privata eller ignorerade, och lås perioden därefter.`
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

  // BFNAR 2013:2 p. 9.16 (behandlingshistorik): unlocking a locked period is a
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
 * Mark a fiscal period as closed in a previous bookkeeping system
 * ("klarmarkera"). Imported historical years (SIE) arrive with
 * is_closed = false and no closing entry, so the year-end page lists them as
 * pending bokslut even though the bokslut was already done in the old
 * software.
 *
 * Deliberately bypasses closePeriod's locked_at/closing_entry_id
 * preconditions: the closing entry lives in the previous system. Everything
 * else stays strict:
 * - the period must have ended (a running year cannot be done elsewhere)
 * - a period with its own closing entry goes through the normal close
 * - already-closed periods are refused
 * - the same unbooked-bank-transactions guard as lockPeriod applies, because
 *   closing strands them exactly the way locking would (BFL 5 kap 2 §)
 *
 * Sets locked_at too (when missing) so the period carries the full
 * closed+locked state the enforcement triggers and readers expect, and writes
 * the immutable audit_log entry (BFNAR 2013:2 p. 9.16: this is a control
 * decision made by a person, not a year-end run).
 */
export async function markPeriodClosedExternally(
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

  if (period.closing_entry_id) {
    throw new Error(
      'Period has a closing entry in Accounted: use the normal year-end close instead'
    )
  }

  const today = new Date().toISOString().slice(0, 10)
  if (period.period_end > today) {
    throw new Error('Cannot mark a period that has not ended yet as closed')
  }

  // Klarmarkera exists for MIGRATED years. A period bookkept natively in
  // Accounted must go through the real year-end: closing it without a
  // bokslutsverifikat leaves 3xxx-8xxx untransferred (BFL 5-6 kap) with no
  // clean way back once locked. "Migrated" is read from the ledger itself:
  // the period either contains SIE-imported verifikat (source_type='import')
  // or no verifikat at all (year closed elsewhere and never imported here).
  const { count: importedCount, error: importedError } = await supabase
    .from('journal_entries')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('source_type', 'import')
    .gte('entry_date', period.period_start)
    .lte('entry_date', period.period_end)
  if (importedError) {
    throw new Error('Kunde inte kontrollera periodens verifikat. Försök igen.')
  }
  if ((importedCount ?? 0) === 0) {
    const { count: totalCount, error: totalError } = await supabase
      .from('journal_entries')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .gte('entry_date', period.period_start)
      .lte('entry_date', period.period_end)
    if (totalError) {
      throw new Error('Kunde inte kontrollera periodens verifikat. Försök igen.')
    }
    if ((totalCount ?? 0) > 0) {
      throw new Error(
        'Perioden innehåller bokföring skapad i Accounted och inga importerade verifikat. Använd det vanliga årsbokslutet i stället.'
      )
    }
  }

  // Same stranding guard as lockPeriod: closing makes unbooked
  // affärshändelser in the period unbookable in place. Fail closed if the
  // guard cannot run.
  let unbooked: UnbookedInPeriod
  try {
    unbooked = await countUnbookedInPeriod(
      supabase,
      companyId,
      period.period_start,
      period.period_end,
    )
  } catch (err) {
    log.error('unbooked-transaction guard failed, refusing to close externally', {
      companyId,
      fiscalPeriodId,
      reason: err instanceof Error ? err.message : String(err),
    })
    throw new Error(
      'Kunde inte kontrollera obokförda banktransaktioner i perioden. Perioden lämnas öppen. Försök igen.'
    )
  }

  const blockingCount = unbooked.untriaged + unbooked.businessUnbooked
  if (blockingCount > 0) {
    const breakdown = [
      unbooked.untriaged > 0 ? `${unbooked.untriaged} ej hanterade` : null,
      unbooked.businessUnbooked > 0
        ? `${unbooked.businessUnbooked} markerade som affärshändelse men utan verifikat`
        : null,
    ]
      .filter(Boolean)
      .join(', ')
    throw new Error(
      `Kan inte klarmarkera period: ${blockingCount} banktransaktion(er) i perioden saknar bokföring ` +
        `(${breakdown}). Alla affärstransaktioner måste vara bokförda innan perioden stängs. ` +
        `Gå till Transaktioner, bokför dem eller markera dem som privata eller ignorerade, och klarmarkera därefter.`
    )
  }

  const now = new Date().toISOString()
  const { data: updated, error: updateError } = await supabase
    .from('fiscal_periods')
    .update({
      is_closed: true,
      closed_at: now,
      closed_externally: true,
      locked_at: period.locked_at ?? now,
    })
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    // TOCTOU guard: a concurrent normal close between the fetch above and
    // this update must not be overwritten with closed_externally=true (and a
    // clobbered closed_at). The predicate makes that race a 0-row update,
    // which .single() surfaces as an error.
    .eq('is_closed', false)
    .select()
    .single()

  if (updateError || !updated) {
    throw new Error(`Failed to mark period as externally closed: ${updateError?.message}`)
  }

  const result = updated as FiscalPeriod

  await supabase.from('audit_log').insert({
    user_id: userId,
    company_id: companyId,
    action: 'UPDATE',
    table_name: 'fiscal_periods',
    record_id: fiscalPeriodId,
    description: `Period marked as closed in previous system: ${result.name} (${result.period_start} to ${result.period_end})`,
    old_state: { is_closed: false, closed_at: null, locked_at: period.locked_at },
    new_state: {
      is_closed: true,
      closed_at: result.closed_at,
      closed_externally: true,
      locked_at: result.locked_at,
    },
  })

  return result
}

/**
 * Undo "klarmarkera": reopen a period that markPeriodClosedExternally closed.
 *
 * The close was a person's control decision, not a year-end run, so undoing
 * it is the same kind of decision. It is allowed only while the closed state
 * still comes from klarmarkera: closed_externally is set and no closing entry
 * exists in Accounted. A period closed by closePeriod keeps its
 * bokslutsverifikat and is not reopened here. Clears locked_at as well: the
 * reason to reopen is to change the period's contents (replace a wrong
 * prior-year SIE import, add missing bokslutsdispositioner), and the user can
 * klarmarkera or lock again afterwards. Written to the immutable audit_log
 * (BFNAR 2013:2 kap. 8).
 *
 * Observed need 2026-08-27: an owner klarmarkerade five imported years, then
 * found the prior-year SIE file was wrong; replace was refused on the closed
 * year and unlock refused the closed state, with no way back.
 */
export async function reopenExternallyClosedPeriod(
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

  if (!period.is_closed) {
    throw new Error('Period is not closed')
  }

  if (!period.closed_externally || period.closing_entry_id) {
    throw new Error(
      'Period was closed with a year-end run in Accounted and cannot be reopened here'
    )
  }

  const { data: updated, error: updateError } = await supabase
    .from('fiscal_periods')
    .update({
      is_closed: false,
      closed_at: null,
      closed_externally: false,
      locked_at: null,
    })
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    // TOCTOU guard, mirror of markPeriodClosedExternally: only the klarmarkera
    // state is reversible, so a concurrent normal close (closing entry set)
    // makes this a 0-row update, which .single() surfaces as an error.
    .eq('is_closed', true)
    .eq('closed_externally', true)
    .is('closing_entry_id', null)
    .select()
    .single()

  if (updateError || !updated) {
    throw new Error(`Failed to reopen period: ${updateError?.message}`)
  }

  const result = updated as FiscalPeriod

  await supabase.from('audit_log').insert({
    user_id: userId,
    company_id: companyId,
    action: 'UPDATE',
    table_name: 'fiscal_periods',
    record_id: fiscalPeriodId,
    description: `Period reopened, previous-system close undone: ${result.name} (${result.period_start} to ${result.period_end})`,
    old_state: {
      is_closed: true,
      closed_at: period.closed_at,
      closed_externally: true,
      locked_at: period.locked_at,
    },
    new_state: {
      is_closed: false,
      closed_at: null,
      closed_externally: false,
      locked_at: null,
    },
  })

  // The lock is gone too, so downstream listeners see the same transition as
  // a plain unlock.
  await eventBus.emit({
    type: 'period.unlocked',
    payload: { period: result, companyId, userId },
  })

  return result
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

  // Heal a chain wired across the gap this period fills: a later period that
  // claims the CURRENT period as predecessor but actually starts the day
  // after the new one now follows the new period (findNextPeriod explains
  // how such links arise). The new period's own row cannot match: it starts
  // the day after current, not the day after itself. Best-effort: the period
  // is created either way, and findNextPeriod no longer trusts a
  // non-adjacent link.
  const { data: mischained } = await supabase
    .from('fiscal_periods')
    .select('id')
    .eq('company_id', companyId)
    .eq('previous_period_id', currentPeriodId)
    .eq('period_start', addDaysIso(nextEndStr, 1))
  if (mischained && mischained.length > 0) {
    const successorIds = mischained.map((row: { id: string }) => row.id)
    const { error: relinkError } = await supabase
      .from('fiscal_periods')
      .update({ previous_period_id: newPeriod.id })
      .in('id', successorIds)
      .eq('company_id', companyId)
    if (relinkError) {
      log.error('failed to relink successor onto the newly created period', relinkError, {
        companyId,
        newPeriodId: newPeriod.id,
        successorIds,
      })
    }
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

  // UTC-only arithmetic: anchor the date string at UTC midnight, then
  // advance via setUTCDate. Using Date(string) + setDate/getDate causes an
  // off-by-one on servers in TZ+ when the day after period_end crosses a
  // DST spring-forward, because setDate(local) writes local-time fields
  // and toISOString() converts back through the shifted offset.
  const expectedStartStr = addDaysIso(current.period_end, 1)

  // The chain is only trusted when it is date-adjacent. SIE import used to
  // point previous_period_id at the NEAREST later period regardless of the
  // gap (40 such rows on prod as of 2026-08-24), and year-end then seeded a
  // whole missing year's opening balances into a period two years out
  // because this returned the chained row unchecked (feedback seq 249297).
  // A non-adjacent link means the true next period is missing or unlinked:
  // fall through to the date lookup and let the caller create it.
  if (chained) {
    const chainedPeriod = chained as FiscalPeriod
    if (chainedPeriod.period_start === expectedStartStr) {
      return chainedPeriod
    }
    log.warn('fiscal period chain is not date-adjacent: ignoring previous_period_id link', {
      companyId,
      currentPeriodId,
      chainedPeriodId: chainedPeriod.id,
      expectedStart: expectedStartStr,
      chainedStart: chainedPeriod.period_start,
    })
  }

  const { data: byDate } = await supabase
    .from('fiscal_periods')
    .select('*')
    .eq('company_id', companyId)
    .eq('period_start', expectedStartStr)
    .maybeSingle()

  return (byDate as FiscalPeriod | null) ?? null
}

export type PeriodStatusValue = 'open' | 'locked' | 'closed'

export interface PeriodStatusForDate {
  period_id: string | null
  status: PeriodStatusValue
  /**
   * For `locked` status: either the period's `locked_at` timestamp (ISO) or the
   * company-wide `bookkeeping_locked_through` date (ISO), whichever applies.
   * `null` for open/closed, and `null` when `lookup_failed` is true.
   */
  lock_date: string | null
  /**
   * True when the lock lookup itself failed (PostgREST error, an overlapping
   * fiscal_periods pair breaking `.maybeSingle()`, a network blip). `status`
   * is then reported as `'locked'`, because a period whose state we could not
   * read must never be presented as writable.
   *
   * Keep the three cases distinguishable, callers treat them differently:
   *   { status: 'open',   period_id: <id>  }              -> verified open
   *   { status: 'open',   period_id: null  }              -> verified: no
   *       covering period exists at all. Not an error: the engine's
   *       ensure-period helper creates one on write.
   *   { status: 'locked', period_id: null, lookup_failed } -> unverified.
   *       Nothing is known about the date. Retryable; a genuinely locked
   *       period always carries a real period_id or lock_date.
   *
   * Deliberately an additive optional field rather than a fourth
   * `PeriodStatusValue`: the union is consumed as an exhaustive
   * `Record<PeriodStatusValue, string>` in lib/agent/intents/bokslut-step.ts,
   * so widening it would break unrelated callers at compile time.
   */
  lookup_failed?: boolean
}

/**
 * Fail-closed verdict for a lock lookup that could not be completed.
 *
 * Reported as `locked` on purpose. The alternative (`open`) is the bug this
 * exists to prevent: every caller of resolvePeriodStatusForDate uses the
 * result to decide whether a write into a period is allowed, so a swallowed
 * query error used to read as "go ahead" on the storno, MCP staging, agent
 * draft and pending-operation commit paths.
 */
function periodLookupFailed(
  companyId: string,
  date: string,
  stage: 'company_settings' | 'fiscal_periods',
  error: { message?: string } | null,
): PeriodStatusForDate {
  log.error('period status lookup failed, failing closed', {
    companyId,
    date,
    stage,
    reason: error?.message,
  })
  return { period_id: null, status: 'locked', lock_date: null, lookup_failed: true }
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
 * Fails CLOSED: if either lookup errors we report `locked` with
 * `lookup_failed: true` rather than `open`. Never reintroduce a bare
 * `const { data } = await ...` here; dropping the `error` is what turned this
 * shared helper into a fail-open on every write path that consults it.
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
  const { data: settings, error: settingsError } = await supabase
    .from('company_settings')
    .select('bookkeeping_locked_through')
    .eq('company_id', companyId)
    .maybeSingle()
  if (settingsError) {
    // Unknown company lock date: the date could be behind it. Fail closed.
    return periodLookupFailed(companyId, date, 'company_settings', settingsError)
  }
  const lockThrough = settings?.bookkeeping_locked_through ?? null
  if (lockThrough && date <= lockThrough) {
    // Find the covering period if any: useful for widget greying. An error
    // here is deliberately non-fatal: the verdict is already `locked` on the
    // company lock date alone, so a failed refinement can only cost the
    // period_id, never flip the answer to open.
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
  const { data: period, error: periodError } = await supabase
    .from('fiscal_periods')
    .select('id, is_closed, locked_at')
    .eq('company_id', companyId)
    .lte('period_start', date)
    .gte('period_end', date)
    .maybeSingle()

  if (periodError) {
    // Distinct from `!period` below: that is "verified, no covering period
    // exists"; this is "we do not know what period covers this date".
    return periodLookupFailed(companyId, date, 'fiscal_periods', periodError)
  }

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
