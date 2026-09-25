/**
 * Räkenskapsår (fiscal years) as operations: create, edit, unlock, and the
 * klarmarkera pair (mark a migrated year closed in the previous system, and
 * undo that). One implementation behind the dashboard routes
 * (/api/bookkeeping/fiscal-periods), the v1 operations
 * (lib/operations/fiscal-periods.ts) and their MCP tools, answering
 * OperationOutcome with registry codes so every door says the same thing.
 *
 * Lives beside period-service.ts rather than inside it: that module is the
 * throwing API the year-end, lock and commit paths call, and this one is the
 * outcome-shaped layer over it. unlock / close-external / reopen-external run
 * period-service's own transitions (so their audit_log rows and events stay
 * exactly as they are) and only translate the refusals into codes.
 *
 * The rules (BFL 3 kap. for the shape of a year, BFNAR 2013:2 for the
 * continuity chain):
 *   - a year is at most 18 months, ends on a month end, and starts on the 1st
 *     unless it is the company's earliest year (BFL 3 kap. 1 and 3 §§);
 *   - years are contiguous: a new year chains onto its predecessor (starts
 *     the day after it ends) and, when it fills a gap, ends the day before
 *     its successor; a year prepended before the earliest ends the day before
 *     it; years never overlap (409, also the DB exclusion constraint);
 *   - a closed or locked year is never edited, and its dates never move
 *     while posted or reversed verifikat exist in it (the name may);
 *   - an enskild firma uses the calendar year (BFL 3 kap.);
 *   - an open prior year is information, never a gate: the create succeeds
 *     with the PRIOR_FISCAL_YEAR_STILL_OPEN warning (BFL 5 kap. 2 § and
 *     6 kap. bind at once, see the comment at the check).
 *
 * A dry run reads and writes nothing: it is the MCP staging preview.
 */
import { addDaysIso } from '@/lib/dates/iso'
import { checkPeriodDuration, parseDateParts, type PeriodDurationIssue } from '@/lib/bookkeeping/validate-period-duration'
import {
  assertPeriodExternallyClosable,
  markPeriodClosedExternally,
  reopenExternallyClosedPeriod,
  unlockPeriod,
} from '@/lib/core/bookkeeping/period-service'
import type { OperationContext, OperationOutcome, OperationWarning } from '@/lib/operations/types'
import type { FiscalPeriod } from '@/types'

type Failure = Extract<OperationOutcome<never>, { ok: false }>

/** A prior räkenskapsår that is still fully open when the next one is created. */
interface OpenPriorPeriod {
  id: string
  name: string
  period_start: string
  period_end: string
}

/** The code, details and Swedish sentence for a broken BFL 3 kap. shape rule. */
function durationFailure(issue: PeriodDurationIssue, start: string, end: string): Failure {
  switch (issue.rule) {
    case 'end_not_after_start':
      return {
        ok: false,
        code: 'FISCAL_PERIOD_INVALID_DATES',
        details: { rule: issue.rule, period_start: start, period_end: end },
      }
    case 'start_not_first_of_month':
      return { ok: false, code: 'FISCAL_PERIOD_START_NOT_FIRST_OF_MONTH', details: { period_start: start } }
    case 'end_not_month_end':
      return { ok: false, code: 'FISCAL_PERIOD_END_NOT_MONTH_END', details: { period_end: end } }
    case 'exceeds_18_months':
      return {
        ok: false,
        code: 'FISCAL_PERIOD_TOO_LONG',
        details: { months: issue.months, max_months: 18 },
        messageSv: `Räkenskapsåret är ${issue.months} månader. Ett räkenskapsår får vara högst 18 månader (BFL 3 kap.).`,
      }
  }
}

function overlapFailure(overlapping: { id: string; name: string }): Failure {
  return {
    ok: false,
    code: 'FISCAL_PERIOD_OVERLAP',
    details: { overlapping_period_id: overlapping.id, overlapping_period_name: overlapping.name },
    messageSv: `Räkenskapsåret överlappar ${overlapping.name}.`,
  }
}

export interface CreateFiscalPeriodInput {
  name: string
  period_start: string
  period_end: string
}

export async function createFiscalPeriod(
  ctx: OperationContext,
  input: CreateFiscalPeriodInput,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<{ fiscal_period: FiscalPeriod }>> {
  const { supabase, companyId, userId, log } = ctx

  // Every existing period, oldest first, to place the new one.
  const { data: allPeriods, error: listError } = await supabase
    .from('fiscal_periods')
    .select('id, period_start, period_end, is_closed')
    .eq('company_id', companyId)
    .order('period_start', { ascending: true })
  if (listError) {
    log.error('fiscal period list failed', listError)
    return { ok: false, code: 'UNKNOWN_ERROR', error: listError }
  }
  const sortedPeriods = (allPeriods ?? []) as Array<{
    id: string
    period_start: string
    period_end: string
    is_closed: boolean
  }>

  // "First" räkenskapsår = no existing period starts earlier, NOT "no period
  // exists at all". Mirrors the enforce_first_of_month_for_subsequent_periods
  // trigger: a mid-month start is legal for the company's first year (BFL 3
  // kap. 3 §, it begins the day bokföringsskyldigheten inträder) and only
  // subsequent years must start on the 1st (BFL 3 kap. 1 §). A company that
  // imported 2024+ from Fortnox and now backfills its first year from
  // 2022-07-22 is creating exactly that first year (issue #2237).
  const isFirstPeriod = !sortedPeriods.some((p) => p.period_start < input.period_start)

  const durationIssue = checkPeriodDuration(input.period_start, input.period_end, { isFirstPeriod })
  if (durationIssue) return durationFailure(durationIssue, input.period_start, input.period_end)

  // The new period's immediate neighbours. Fiscal periods never overlap (the
  // no_overlapping_fiscal_periods DB exclusion constraint), so ordering by
  // period_start is also ordering by period_end.
  //   predecessor = closest existing period ending before the new one starts
  //   successor   = closest existing period starting after the new one ends
  const predecessor = [...sortedPeriods].reverse().find((p) => p.period_end < input.period_start) ?? null
  const successor = sortedPeriods.find((p) => p.period_start > input.period_end) ?? null

  // Prior räkenskapsår still fully open at the moment the next one is
  // appended. Advisory only (see the isAppend block below).
  let openPriorPeriods: OpenPriorPeriod[] = []
  let isPrepend = false

  if (sortedPeriods.length > 0) {
    const earliest = sortedPeriods[0]
    const latest = sortedPeriods[sortedPeriods.length - 1]

    isPrepend = input.period_end < earliest.period_start
    const isAppend = input.period_start > latest.period_end

    if (isPrepend) {
      // Prepend before the earliest period: the new period ends the day before
      // the earliest one starts. The "no open prior period" advisory is
      // skipped: backfilling an earlier year needs that year to stay open.
      const expectedEnd = addDaysIso(earliest.period_start, -1)
      if (input.period_end !== expectedEnd) {
        return {
          ok: false,
          code: 'FISCAL_PERIOD_NOT_CONTIGUOUS',
          details: { expected_end: expectedEnd, following_period_id: earliest.id },
          messageSv: `Räkenskapsåret måste sluta ${expectedEnd}, dagen innan det tidigaste räkenskapsåret börjar.`,
        }
      }
    } else {
      // Forward-like: append a new latest year OR fill an interior gap. Both
      // chain onto their immediate predecessor (start the day after it ends).
      if (predecessor) {
        const expectedStart = addDaysIso(predecessor.period_end, 1)
        if (input.period_start !== expectedStart) {
          return {
            ok: false,
            code: 'FISCAL_PERIOD_NOT_CONTIGUOUS',
            details: { expected_start: expectedStart, preceding_period_id: predecessor.id },
            messageSv: `Räkenskapsåret måste börja ${expectedStart}, dagen efter att föregående räkenskapsår slutar.`,
          }
        }
      }
      // No predecessor here means the new period reaches back over the earliest
      // existing period (an overlap): the overlap check below answers 409.

      // Gap fill: the new period must also end the day before its SUCCESSOR,
      // so it fills the hole completely. Without this a too-short period would
      // leave a fresh sub-gap yet still get the successor's previous_period_id
      // relinked onto it (below), silently breaking the BFNAR 2013:2
      // continuity chain. A too-long one is caught as an overlap (409).
      if (successor) {
        const expectedEnd = addDaysIso(successor.period_start, -1)
        if (input.period_end !== expectedEnd) {
          return {
            ok: false,
            code: 'FISCAL_PERIOD_NOT_CONTIGUOUS',
            details: { expected_end: expectedEnd, following_period_id: successor.id },
            messageSv: `Räkenskapsåret måste sluta ${expectedEnd}, dagen innan nästa räkenskapsår börjar.`,
          }
        }
      }

      // An open prior räkenskapsår is INFORMATION, never a gate.
      //
      // This used to hard-refuse (409) a new latest räkenskapsår while any
      // prior period was still fully open. That has no support in BFL and
      // inverts two rules that bind simultaneously:
      //   - BFL 5 kap 2 §: kontanta in-/utbetalningar bokförs senast påföljande
      //     arbetsdag, övriga affärshändelser "så snart det kan ske" (per BFNAR
      //     2013:2 senast månaden efter). Booking January REQUIRES a
      //     räkenskapsår covering January, within weeks.
      //   - BFL 6 kap: årsbokslut/årsredovisning ska upprättas inom 6 månader
      //     efter räkenskapsårets utgång. The prior year is legitimately
      //     unfinished and must stay unlocked so bokslutsposter can be posted
      //     into it, for months into the new year.
      // What protects the prior year lives elsewhere: period locked_at
      // (enforce_period_lock) and company_settings.bookkeeping_locked_through
      // (enforce_company_lock_date). Creating the next räkenskapsår does not
      // write a single row into the prior one.
      //
      // The detection survives as an advisory: an open prior year means its UB
      // is not final, so the new year's ingående balanser are not posted yet.
      // A period counts as "effectively locked" if its own locked_at is set, OR
      // company_settings.bookkeeping_locked_through covers its end date.
      if (isAppend) {
        const { data: openPeriods } = await supabase
          .from('fiscal_periods')
          .select('id, name, period_start, period_end')
          .eq('company_id', companyId)
          .eq('is_closed', false)
          .is('locked_at', null)
          .order('period_start', { ascending: true })

        const { data: settings } = await supabase
          .from('company_settings')
          .select('bookkeeping_locked_through')
          .eq('company_id', companyId)
          .maybeSingle()

        const lockThrough = (settings?.bookkeeping_locked_through as string | null | undefined) ?? null
        openPriorPeriods = ((openPeriods ?? []) as OpenPriorPeriod[])
          .filter((p) => !(lockThrough && p.period_end <= lockThrough))
          .map((p) => ({ id: p.id, name: p.name, period_start: p.period_start, period_end: p.period_end }))
      }
    }
  }

  // Defense in depth beside the DB exclusion constraint.
  const { data: overlapping } = await supabase
    .from('fiscal_periods')
    .select('id, name')
    .eq('company_id', companyId)
    .lte('period_start', input.period_end)
    .gte('period_end', input.period_start)
    .limit(1)
  if (overlapping && overlapping.length > 0) {
    return overlapFailure(overlapping[0] as { id: string; name: string })
  }

  // Chain the new period onto its predecessor (append or gap fill) so reports
  // can walk the BFNAR 2013:2 continuity chain. Prepend leaves this null and
  // instead relinks the old earliest period to follow the new one (below).
  const previousPeriodId = predecessor ? predecessor.id : null
  // The period that follows the new one: the old earliest (prepend) or the
  // successor (gap fill). Append has none.
  const periodToRelink = sortedPeriods.length === 0 ? null : isPrepend ? sortedPeriods[0] : successor

  // Non-blocking advisory: the new year exists and is bookable right now, but
  // its ingående balanser are pending because the prior year's bokslut has
  // not run. Every action named here is reachable, so this never dead-ends:
  // the IB lands by itself when the bokslut for the prior year is executed
  // (executeYearEndClosing reuses an already-created next period).
  const warnings: OperationWarning[] = []
  if (openPriorPeriods.length > 0) {
    const names = openPriorPeriods.map((p) => p.name).join(', ')
    warnings.push({
      code: 'PRIOR_FISCAL_YEAR_STILL_OPEN',
      message_sv:
        `Räkenskapsåret är skapat och du kan bokföra i det direkt. ${names} är fortfarande öppet, ` +
        'vilket är normalt medan bokslutet pågår: du får bokföra i båda åren samtidigt. ' +
        'Ingående balanser bokförs automatiskt när bokslutet för föregående år körs.',
      message_en:
        `The fiscal year was created and is bookable now. ${names} is still open, which is normal while its ` +
        'year-end is in progress: both years can be booked at once. Opening balances are posted automatically ' +
        'when the prior year-end runs.',
    })
  }

  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      preview: {
        name: input.name,
        period_start: input.period_start,
        period_end: input.period_end,
        previous_period_id: previousPeriodId,
        relinks_period_id: periodToRelink?.id ?? null,
        is_first_period: isFirstPeriod,
        ...(warnings.length > 0 ? { warnings } : {}),
      },
    }
  }

  const { data: created, error: insertError } = await supabase
    .from('fiscal_periods')
    .insert({
      user_id: userId,
      company_id: companyId,
      name: input.name,
      period_start: input.period_start,
      period_end: input.period_end,
      previous_period_id: previousPeriodId,
    })
    .select('*')
    .single()

  if (insertError || !created) {
    // 23P01 = exclusion_violation: a concurrent create won the race past the
    // overlap read above; the constraint is the arbiter.
    if (insertError?.code === '23P01') {
      return {
        ok: false,
        code: 'FISCAL_PERIOD_OVERLAP',
        details: { period_start: input.period_start, period_end: input.period_end },
      }
    }
    log.error('fiscal period create failed', insertError ?? new Error('no row returned'))
    return { ok: false, code: 'FISCAL_PERIOD_CREATE_FAILED', details: { reason: insertError?.message } }
  }

  if (periodToRelink) {
    const { error: relinkError } = await supabase
      .from('fiscal_periods')
      .update({ previous_period_id: created.id })
      .eq('id', periodToRelink.id)
      .eq('company_id', companyId)
    if (relinkError) {
      // The period WAS created, so the request does not fail, but a broken
      // continuity chain (BFNAR 2013:2) must never be silent.
      log.error('failed to relink continuity chain after period create', relinkError, {
        createdPeriodId: created.id,
        relinkPeriodId: periodToRelink.id,
      })
    }
  }

  return {
    ok: true,
    data: { fiscal_period: created as FiscalPeriod },
    created: true,
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}

export interface UpdateFiscalPeriodInput {
  name?: string
  period_start?: string
  period_end?: string
}

/**
 * Rename or re-date an open, unlocked räkenskapsår. The name may change at
 * any time on an open year; the dates only while no posted or reversed
 * verifikat exist in it (moving the year under a verifikat would reassign
 * booked history). A request that changes nothing answers the period as is.
 */
export async function updateFiscalPeriod(
  ctx: OperationContext,
  fiscalPeriodId: string,
  input: UpdateFiscalPeriodInput,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<FiscalPeriod>> {
  const { supabase, companyId, log } = ctx

  const { data: period, error: fetchError } = await supabase
    .from('fiscal_periods')
    .select('*')
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .single()
  if (fetchError || !period) return { ok: false, code: 'PERIOD_NOT_FOUND' }

  if (period.is_closed) return { ok: false, code: 'FISCAL_PERIOD_UPDATE_CLOSED' }
  if (period.locked_at) return { ok: false, code: 'FISCAL_PERIOD_UPDATE_LOCKED' }

  if (input.period_start || input.period_end) {
    const { count: entryCount } = await supabase
      .from('journal_entries')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .eq('fiscal_period_id', fiscalPeriodId)
      .in('status', ['posted', 'reversed'])
    if (entryCount && entryCount > 0) {
      return {
        ok: false,
        code: 'FISCAL_PERIOD_HAS_POSTED_ENTRIES',
        details: { entry_count: entryCount },
        messageSv: `Datumen kan inte ändras: ${entryCount} bokförda verifikationer finns i räkenskapsåret. Namnet kan fortfarande ändras.`,
      }
    }

    const newStart = input.period_start || (period.period_start as string)
    const newEnd = input.period_end || (period.period_end as string)

    // The first period may start on any day (BFL 3 kap. 3 §); an enskild
    // firma's first year may also run to 31 dec next year (förlängt
    // räkenskapsår, max 18 months).
    const { count: earlierCount } = await supabase
      .from('fiscal_periods')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .neq('id', fiscalPeriodId)
      .lt('period_start', newStart)
    const isFirstPeriod = !earlierCount || earlierCount === 0

    // An enskild firma must end on 31 december (BFL 3 kap.); subsequent
    // years also start on 1 januari. The first year may start any day.
    const { data: companyRow } = await supabase
      .from('companies')
      .select('entity_type')
      .eq('id', companyId)
      .single()
    if (companyRow?.entity_type === 'enskild_firma') {
      const e = parseDateParts(newEnd)
      if (e.month !== 12 || e.day !== 31) {
        return {
          ok: false,
          code: 'FISCAL_PERIOD_ENSKILD_FIRMA_CALENDAR_YEAR',
          details: { rule: 'end_31_december', period_end: newEnd },
          messageSv: 'Enskild firma måste ha slutdatum 31 december enligt BFL 3 kap.',
        }
      }
      if (!isFirstPeriod) {
        const s = parseDateParts(newStart)
        if (s.month !== 1 || s.day !== 1) {
          return {
            ok: false,
            code: 'FISCAL_PERIOD_ENSKILD_FIRMA_CALENDAR_YEAR',
            details: { rule: 'start_1_january', period_start: newStart },
            messageSv: 'Enskild firma måste använda kalenderår (1 januari till 31 december) enligt BFL 3 kap.',
          }
        }
      }
    }

    const durationIssue = checkPeriodDuration(newStart, newEnd, { isFirstPeriod })
    if (durationIssue) return durationFailure(durationIssue, newStart, newEnd)

    const { data: overlapping } = await supabase
      .from('fiscal_periods')
      .select('id, name')
      .eq('company_id', companyId)
      .neq('id', fiscalPeriodId)
      .lte('period_start', newEnd)
      .gte('period_end', newStart)
      .limit(1)
    if (overlapping && overlapping.length > 0) {
      return overlapFailure(overlapping[0] as { id: string; name: string })
    }

    // Re-dating keeps the years contiguous (BFNAR 2013:2 continuity): the
    // year must still start the day after its predecessor ends and end the
    // day before its successor starts, so previous_period_id stays true
    // without a relink. In practice only the first and the latest year can
    // move, and a gap can never open behind an API caller's back.
    const { data: neighbours } = await supabase
      .from('fiscal_periods')
      .select('id, period_start, period_end')
      .eq('company_id', companyId)
      .neq('id', fiscalPeriodId)
      .order('period_start', { ascending: true })
    const others = (neighbours ?? []) as Array<{ id: string; period_start: string; period_end: string }>
    const predecessor = [...others].reverse().find((p) => p.period_end < newStart) ?? null
    const successor = others.find((p) => p.period_start > newEnd) ?? null
    if (predecessor && newStart !== addDaysIso(predecessor.period_end, 1)) {
      const expectedStart = addDaysIso(predecessor.period_end, 1)
      return {
        ok: false,
        code: 'FISCAL_PERIOD_NOT_CONTIGUOUS',
        details: { expected_start: expectedStart, preceding_period_id: predecessor.id },
        messageSv: `Räkenskapsåret måste börja ${expectedStart}, dagen efter att föregående räkenskapsår slutar.`,
      }
    }
    if (successor && newEnd !== addDaysIso(successor.period_start, -1)) {
      const expectedEnd = addDaysIso(successor.period_start, -1)
      return {
        ok: false,
        code: 'FISCAL_PERIOD_NOT_CONTIGUOUS',
        details: { expected_end: expectedEnd, following_period_id: successor.id },
        messageSv: `Räkenskapsåret måste sluta ${expectedEnd}, dagen innan nästa räkenskapsår börjar.`,
      }
    }
  }

  const updates: { name?: string; period_start?: string; period_end?: string } = {}
  if (input.name) updates.name = input.name
  if (input.period_start) updates.period_start = input.period_start
  if (input.period_end) updates.period_end = input.period_end

  if (Object.keys(updates).length === 0) return { ok: true, data: period as FiscalPeriod }

  if (options.dryRun) {
    return { ok: true, dryRun: true, preview: { fiscal_period_id: fiscalPeriodId, changes: updates } }
  }

  const { data: updated, error: updateError } = await supabase
    .from('fiscal_periods')
    .update(updates)
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .select('*')
    .single()

  if (updateError || !updated) {
    const msg = updateError?.message ?? ''
    // The enforce_period_start_day trigger (and the month-end CHECK) refuse
    // boundaries the checks above let through only on a race.
    if (/period_start|period_end|first of a month|1st of a month/.test(msg)) {
      return {
        ok: false,
        code: 'FISCAL_PERIOD_INVALID_DATES',
        details: { rule: 'database_boundary' },
        messageSv: 'Perioden måste sluta sista dagen i en månad. Efterföljande perioder måste börja den 1:a.',
      }
    }
    log.error('fiscal period update failed', updateError ?? new Error('no row returned'))
    return { ok: false, code: 'FISCAL_PERIOD_UPDATE_FAILED', details: { reason: msg || undefined } }
  }

  return { ok: true, data: updated as FiscalPeriod }
}

/** Load one period of the company, or the PERIOD_NOT_FOUND failure. */
async function loadPeriod(
  ctx: OperationContext,
  fiscalPeriodId: string,
): Promise<{ period: FiscalPeriod } | { failure: Failure }> {
  const { data, error } = await ctx.supabase
    .from('fiscal_periods')
    .select('*')
    .eq('id', fiscalPeriodId)
    .eq('company_id', ctx.companyId)
    .maybeSingle()
  if (error) {
    ctx.log.error('fiscal period fetch failed', error)
    return { failure: { ok: false, code: 'UNKNOWN_ERROR', error } }
  }
  if (!data) return { failure: { ok: false, code: 'PERIOD_NOT_FOUND' } }
  return { period: data as FiscalPeriod }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : ''
}

/** unlockPeriod's refusals as codes (its messages are stable, see its tests). */
function unlockFailure(err: unknown): Failure {
  const message = messageOf(err)
  if (/not found/i.test(message)) return { ok: false, code: 'PERIOD_NOT_FOUND' }
  if (/closed/i.test(message)) return { ok: false, code: 'PERIOD_UNLOCK_CLOSED' }
  if (/not locked/i.test(message)) return { ok: false, code: 'PERIOD_UNLOCK_NOT_LOCKED' }
  return { ok: false, code: 'UNKNOWN_ERROR', error: err }
}

/**
 * Unlock a locked, not closed, räkenskapsår (clears locked_at). The audit_log
 * row and the period.unlocked event are unlockPeriod's own.
 */
export async function unlockFiscalPeriod(
  ctx: OperationContext,
  fiscalPeriodId: string,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<FiscalPeriod>> {
  if (options.dryRun) {
    const loaded = await loadPeriod(ctx, fiscalPeriodId)
    if ('failure' in loaded) return loaded.failure
    const { period } = loaded
    if (period.is_closed) return { ok: false, code: 'PERIOD_UNLOCK_CLOSED' }
    if (!period.locked_at) return { ok: false, code: 'PERIOD_UNLOCK_NOT_LOCKED' }
    return {
      ok: true,
      dryRun: true,
      preview: { fiscal_period_id: period.id, name: period.name, locked_at: period.locked_at, will_set_locked_at: null },
    }
  }
  try {
    const period = await unlockPeriod(ctx.supabase, ctx.companyId, ctx.userId, fiscalPeriodId)
    return { ok: true, data: period }
  } catch (err) {
    const failure = unlockFailure(err)
    if (failure.code === 'UNKNOWN_ERROR') ctx.log.error('failed to unlock period', err as Error)
    return failure
  }
}

/** markPeriodClosedExternally's refusals as codes. */
function closeExternalFailure(err: unknown): Failure {
  const message = messageOf(err)
  if (/not found/i.test(message)) return { ok: false, code: 'PERIOD_NOT_FOUND' }
  if (/already closed/i.test(message)) return { ok: false, code: 'FISCAL_PERIOD_CLOSE_EXTERNAL_ALREADY_CLOSED' }
  if (/closing entry in Accounted/i.test(message)) {
    return { ok: false, code: 'FISCAL_PERIOD_CLOSE_EXTERNAL_HAS_CLOSING_ENTRY' }
  }
  if (/not ended yet/i.test(message)) return { ok: false, code: 'FISCAL_PERIOD_CLOSE_EXTERNAL_NOT_ENDED' }
  if (/resultatkonton|saknar ingående balanser/i.test(message)) {
    return { ok: false, code: 'FISCAL_PERIOD_CLOSE_EXTERNAL_NATIVE_BOOKKEEPING', messageSv: message }
  }
  if (/saknar bokföring/i.test(message)) {
    return { ok: false, code: 'PERIOD_HAS_UNBOOKED_TRANSACTIONS', messageSv: message }
  }
  if (/Kunde inte kontrollera/i.test(message)) {
    return { ok: false, code: 'FISCAL_PERIOD_CLOSE_EXTERNAL_CHECK_FAILED', messageSv: message }
  }
  return { ok: false, code: 'UNKNOWN_ERROR', error: err }
}

/**
 * Klarmarkera: mark a migrated räkenskapsår as closed in the previous
 * bookkeeping system (closes and locks it without a closing entry here). The
 * rules and the audit_log row are markPeriodClosedExternally's; the dry run
 * runs the same read-only checks (assertPeriodExternallyClosable).
 */
export async function closeFiscalPeriodExternally(
  ctx: OperationContext,
  fiscalPeriodId: string,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<FiscalPeriod>> {
  if (options.dryRun) {
    const loaded = await loadPeriod(ctx, fiscalPeriodId)
    if ('failure' in loaded) return loaded.failure
    const { period } = loaded
    try {
      await assertPeriodExternallyClosable(ctx.supabase, ctx.companyId, period)
    } catch (err) {
      return closeExternalFailure(err)
    }
    return {
      ok: true,
      dryRun: true,
      preview: {
        fiscal_period_id: period.id,
        name: period.name,
        period_start: period.period_start,
        period_end: period.period_end,
        will_close: true,
        will_lock: !period.locked_at,
      },
    }
  }
  try {
    const period = await markPeriodClosedExternally(ctx.supabase, ctx.companyId, ctx.userId, fiscalPeriodId)
    return { ok: true, data: period }
  } catch (err) {
    const failure = closeExternalFailure(err)
    if (failure.code === 'UNKNOWN_ERROR') ctx.log.error('failed to mark period closed externally', err as Error)
    return failure
  }
}

/** reopenExternallyClosedPeriod's refusals as codes. */
function reopenExternalFailure(err: unknown): Failure {
  const message = messageOf(err)
  if (/not found/i.test(message)) return { ok: false, code: 'PERIOD_NOT_FOUND' }
  if (/not closed/i.test(message)) return { ok: false, code: 'PERIOD_REOPEN_NOT_CLOSED' }
  if (/year-end run/i.test(message)) return { ok: false, code: 'PERIOD_REOPEN_NOT_EXTERNAL' }
  return { ok: false, code: 'UNKNOWN_ERROR', error: err }
}

/**
 * Undo klarmarkera: reopen (and unlock) a räkenskapsår that was marked closed
 * in a previous system. Only while that close is still the klarmarkera one:
 * a year closed by a year-end run here is never reopened.
 */
export async function reopenExternallyClosedFiscalPeriod(
  ctx: OperationContext,
  fiscalPeriodId: string,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<FiscalPeriod>> {
  if (options.dryRun) {
    const loaded = await loadPeriod(ctx, fiscalPeriodId)
    if ('failure' in loaded) return loaded.failure
    const { period } = loaded
    if (!period.is_closed) return { ok: false, code: 'PERIOD_REOPEN_NOT_CLOSED' }
    if (!period.closed_externally || period.closing_entry_id) {
      return { ok: false, code: 'PERIOD_REOPEN_NOT_EXTERNAL' }
    }
    return {
      ok: true,
      dryRun: true,
      preview: { fiscal_period_id: period.id, name: period.name, will_reopen: true, will_unlock: true },
    }
  }
  try {
    const period = await reopenExternallyClosedPeriod(ctx.supabase, ctx.companyId, ctx.userId, fiscalPeriodId)
    return { ok: true, data: period }
  } catch (err) {
    const failure = reopenExternalFailure(err)
    if (failure.code === 'UNKNOWN_ERROR') ctx.log.error('failed to reopen externally closed period', err as Error)
    return failure
  }
}
