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
 *     the day after it ends) and, when it fills a gap one legal year can
 *     close, ends the day before its successor; a gap longer than one legal
 *     year is filled one year at a time from its oldest end (crm#1982); a
 *     year prepended before the earliest ends the day before it; years never
 *     overlap (409, also the DB exclusion constraint);
 *   - a closed or locked year is never edited (the name may change on an
 *     open one at any time), except that the earliest year's start may be
 *     corrected within its month after the bokslut (crm#1140); dates move
 *     only through the guarded redate_fiscal_period RPC, which refuses
 *     whenever a verifikat, an opening balance, a lock, year-end work, a
 *     filing or an SIE hold would be affected (crm#1010: a year that already
 *     holds verifikat may still move a boundary over days that hold nothing);
 *   - an enskild firma uses the calendar year: every year ends on 31
 *     December and only the first may start after 1 January (BFL 3 kap.);
 *   - an open prior year is information, never a gate: the create succeeds
 *     with the PRIOR_FISCAL_YEAR_STILL_OPEN warning (BFL 5 kap. 2 § and
 *     6 kap. bind at once, see the comment at the check).
 *
 * A dry run reads and writes nothing: it is the MCP staging preview.
 */
import { addDaysIso } from '@/lib/dates/iso'
import {
  checkPeriodDuration,
  exceedsFiscalYearCap,
  isFirstFiscalPeriod,
  parseDateParts,
  type PeriodDurationIssue,
} from '@/lib/bookkeeping/validate-period-duration'
import { fiscalYearLockedToCalendar, resolveCompanyEntityType } from '@/lib/company/entity-type'
import {
  assertPeriodExternallyClosable,
  markPeriodClosedExternally,
  reopenExternallyClosedPeriod,
  unlockPeriod,
} from '@/lib/core/bookkeeping/period-service'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { userFacingCode } from '@/lib/errors/user-facing'
import type { OperationContext, OperationOutcome, OperationWarning } from '@/lib/operations/types'
import type { FiscalPeriod } from '@/types'
import type { z } from 'zod'
import type { CreateFiscalPeriodSchema } from '@/lib/api/schemas'

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
    case 'not_calendar_year_end':
      return {
        ok: false,
        code: 'FISCAL_PERIOD_ENSKILD_FIRMA_CALENDAR_YEAR',
        details: { rule: 'end_31_december', period_end: end },
        messageSv: 'Enskild firma måste ha slutdatum 31 december enligt BFL 3 kap.',
      }
    case 'not_calendar_year_start':
      return {
        ok: false,
        code: 'FISCAL_PERIOD_ENSKILD_FIRMA_CALENDAR_YEAR',
        details: { rule: 'start_1_january', period_start: start },
        messageSv: 'Enskild firma måste använda kalenderår (1 januari till 31 december) enligt BFL 3 kap.',
      }
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

/** A hole between two recorded years that is longer than a räkenskapsår may be. */
interface WideGap {
  /** Its first day: where the next fill year starts. */
  start: string
  /** Its last day: the day before the following year starts. */
  end: string
  followingPeriodId: string
}

/**
 * The hole after `predecessor` when no single legal year can close it (BFL
 * 3 kap., exceedsFiscalYearCap), else null. Such a hole arises when an SIE
 * import adds an old year to a company that already has a later one (it
 * leaves the gap unlinked on purpose), and is filled one year at a time from
 * its oldest end, as the bank door fills it (missingFiscalYears).
 */
function wideGapAfter(
  sortedPeriods: ReadonlyArray<{ id: string; period_start: string; period_end: string }>,
  predecessor: { period_end: string } | null,
): WideGap | null {
  if (!predecessor) return null
  const following = sortedPeriods.find((p) => p.period_start > predecessor.period_end)
  if (!following) return null
  const start = addDaysIso(predecessor.period_end, 1)
  const end = addDaysIso(following.period_start, -1)
  return exceedsFiscalYearCap(start, end) ? { start, end, followingPeriodId: following.id } : null
}

/**
 * A refusal inside a wide gap, with the way forward: the date the next fill
 * year starts on, and that the gap takes one legal year at a time.
 */
function withStepwiseFill(failure: Failure, gap: WideGap): Failure {
  const wayForward =
    'Luckan fram till nästa räkenskapsår är längre än 18 månader och fylls ett räkenskapsår i taget: ' +
    `skapa först ett år som börjar ${gap.start} (normalt 12 månader), sedan nästa, tills det sista slutar ${gap.end}.`
  return {
    ...failure,
    details: {
      ...failure.details,
      expected_start: gap.start,
      gap_end: gap.end,
      following_period_id: gap.followingPeriodId,
    },
    messageSv: [failure.messageSv, wayForward].filter(Boolean).join(' '),
  }
}

/** The request every door validates (CreateFiscalPeriodSchema). */
export type CreateFiscalPeriodInput = z.output<typeof CreateFiscalPeriodSchema>

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

  // A mid-month start is legal for the company's first year (BFL 3 kap. 3 §, it
  // begins the day bokföringsskyldigheten inträder) and only subsequent years
  // must start on the 1st (BFL 3 kap. 1 §). A company that imported 2024+ from
  // Fortnox and now backfills its first year from 2022-07-22 is creating
  // exactly that first year (issue #2237).
  const isFirstPeriod = isFirstFiscalPeriod(input.period_start, sortedPeriods.map((p) => p.period_start))
  const entityType = await resolveCompanyEntityType(supabase, companyId)

  // The new period's immediate neighbours. Fiscal periods never overlap (the
  // no_overlapping_fiscal_periods DB exclusion constraint), so ordering by
  // period_start is also ordering by period_end.
  //   predecessor = closest existing period ending before the new one starts
  //   successor   = closest existing period starting after the new one ends
  const predecessor = [...sortedPeriods].reverse().find((p) => p.period_end < input.period_start) ?? null
  const successor = sortedPeriods.find((p) => p.period_start > input.period_end) ?? null
  // The hole after the predecessor, when it is longer than one year may be.
  const wideGap = wideGapAfter(sortedPeriods, predecessor)
  // Whether the new period ends the day before its successor starts, so the
  // successor follows it directly.
  const successorExpectedEnd = successor ? addDaysIso(successor.period_start, -1) : null
  const reachesSuccessor = successorExpectedEnd !== null && input.period_end === successorExpectedEnd

  const durationIssue = checkPeriodDuration(input.period_start, input.period_end, {
    isFirstPeriod,
    calendarYearOnly: fiscalYearLockedToCalendar(entityType),
  })
  if (durationIssue) {
    const failure = durationFailure(durationIssue, input.period_start, input.period_end)
    // One year asked to close a gap longer than a year may be: the cap holds,
    // and the refusal says how the gap is filled instead.
    return durationIssue.rule === 'exceeds_18_months' && wideGap ? withStepwiseFill(failure, wideGap) : failure
  }

  // Prior räkenskapsår still fully open at the moment the next one is
  // appended. Advisory only (see the isAppend block below).
  let openPriorPeriods: OpenPriorPeriod[] = []

  if (sortedPeriods.length > 0) {
    const earliest = sortedPeriods[0]
    const latest = sortedPeriods[sortedPeriods.length - 1]

    const isPrepend = input.period_end < earliest.period_start
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
          const failure: Failure = {
            ok: false,
            code: 'FISCAL_PERIOD_NOT_CONTIGUOUS',
            details: { expected_start: expectedStart, preceding_period_id: predecessor.id },
            messageSv: `Räkenskapsåret måste börja ${expectedStart}, dagen efter att föregående räkenskapsår slutar.`,
          }
          return wideGap ? withStepwiseFill(failure, wideGap) : failure
        }
      }
      // No predecessor here means the new period reaches back over the earliest
      // existing period (an overlap): the overlap check below answers 409.

      // Gap fill: the new period must also end the day before its SUCCESSOR,
      // so it fills the hole completely: a too-short period would leave a
      // fresh sub-gap where one year was enough. A too-long one is caught as
      // an overlap (409).
      //
      // Not so in a hole longer than a year may be (crm#1982): there "reach
      // the successor" and "at most 18 months" exclude each other, so no
      // create could ever succeed. The cap is the law and stays; the year
      // chains onto its predecessor and the rest of the hole waits for the
      // next create, as on the bank door (missingFiscalYears). The successor
      // is relinked only by the year that reaches it (periodToRelink below).
      if (successor && successorExpectedEnd && !reachesSuccessor && !wideGap) {
        return {
          ok: false,
          code: 'FISCAL_PERIOD_NOT_CONTIGUOUS',
          details: { expected_end: successorExpectedEnd, following_period_id: successor.id },
          messageSv: `Räkenskapsåret måste sluta ${successorExpectedEnd}, dagen innan nästa räkenskapsår börjar.`,
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
  // The period that follows the new one directly: the old earliest (prepend)
  // or the successor a gap fill reaches. Append has none, and neither has a
  // fill year that leaves the rest of a wide gap open: previous_period_id
  // means the year ending the day before (resolvePreviousFiscalPeriod), so
  // the successor keeps its link until the year that reaches it is created.
  const periodToRelink = reachesSuccessor ? successor : null

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

/** One reason redate_fiscal_period refused, in the RPC's own words. */
interface FiscalPeriodRedateBlocker {
  code: string
  message_sv: string
  [fact: string]: unknown
}

/** What redate_fiscal_period answers (migration 20261005211012). */
interface RedateRpcResult {
  ok: boolean
  code?: string
  blockers?: FiscalPeriodRedateBlocker[]
  period?: FiscalPeriod
}

/**
 * The refusal for editing a closed or locked räkenskapsår, or null when the
 * request is the first-year start correction (crm#1140): only the start of
 * the company's earliest year moves, inside the month it already starts in,
 * and the name stays. That is how a first year recorded from the 1st of the
 * registration month is moved to the registration day (an aktiebolag is
 * bokföringsskyldigt from its registration, and only the first year may
 * start mid-month, BFL 2 and 3 kap.) after its bokslut has run. Nothing
 * booked moves and every figure the bokslut computed in whole months stays
 * the same, so redate_fiscal_period lets it through and still refuses on
 * whatever depends on the exact start (verifikat outside, opening balances,
 * depreciation, a finalized annual report, filings).
 */
function closedYearRefusal(
  period: FiscalPeriod,
  input: UpdateFiscalPeriodInput,
  newStart: string,
  newEnd: string,
  isFirstPeriod: boolean,
): Failure | null {
  const code = period.is_closed ? 'FISCAL_PERIOD_UPDATE_CLOSED' : 'FISCAL_PERIOD_UPDATE_LOCKED'
  const startOnly =
    newStart !== period.period_start &&
    newEnd === period.period_end &&
    (!input.name || input.name === period.name)
  if (!startOnly || !isFirstPeriod) return { ok: false, code }

  const month = period.period_start.slice(0, 7)
  if (newStart.slice(0, 7) === month) return null

  const { year, month: monthNumber } = parseDateParts(period.period_start)
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate()
  const monthStart = `${month}-01`
  const monthEnd = `${month}-${String(lastDay).padStart(2, '0')}`
  return {
    ok: false,
    code,
    details: { rule: 'start_correction_same_month', allowed_from: monthStart, allowed_to: monthEnd },
    messageSv: period.is_closed
      ? `Startdatumet för ett stängt räkenskapsår kan bara rättas inom samma månad (${monthStart} till ${monthEnd}): ` +
        'bokslutet är gjort på årets nuvarande antal månader.'
      : `Startdatumet för ett låst räkenskapsår kan bara rättas inom samma månad (${monthStart} till ${monthEnd}). ` +
        'Lås upp året först om startdatumet ska flyttas till en annan månad.',
  }
}

/**
 * Rename or re-date an open, unlocked räkenskapsår. The name may change at
 * any time on an open year. New dates must keep the BFL 3 kap. shape and the
 * chain to the neighbouring years (checked here first, with the codes every
 * door already knows), and are then written by redate_fiscal_period, which
 * re-checks all of that under a row lock together with everything the year
 * holds: no verifikat or draft may fall outside the new dates, posted
 * opening balances pin the start, and a lock, year-end work, a filing or an
 * SIE hold refuses the move. Its refusal names every blocker in Swedish. A
 * request that changes nothing answers the period as is.
 *
 * A closed or locked year is never edited, with one exception: the
 * first-year start correction (closedYearRefusal), which the RPC checks
 * again under the row lock.
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

  const newStart = input.period_start || (period.period_start as string)
  const newEnd = input.period_end || (period.period_end as string)
  const datesMove = newStart !== period.period_start || newEnd !== period.period_end

  // The first period may start on any day (BFL 3 kap. 3 §); an enskild
  // firma's first year may also run to 31 dec next year (förlängt
  // räkenskapsår, max 18 months).
  let isFirstPeriod = false
  if (datesMove) {
    const { data: others } = await supabase
      .from('fiscal_periods')
      .select('period_start')
      .eq('company_id', companyId)
      .neq('id', fiscalPeriodId)
    isFirstPeriod = isFirstFiscalPeriod(newStart, ((others ?? []) as { period_start: string }[]).map((p) => p.period_start))
  }

  if (period.is_closed || period.locked_at) {
    const refusal = closedYearRefusal(period as FiscalPeriod, input, newStart, newEnd, isFirstPeriod)
    if (refusal) return refusal
  }

  if (datesMove) {
    const entityType = await resolveCompanyEntityType(supabase, companyId)
    const durationIssue = checkPeriodDuration(newStart, newEnd, {
      isFirstPeriod,
      calendarYearOnly: fiscalYearLockedToCalendar(entityType),
    })
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

    // Re-dating keeps the year contiguous with the years around its new
    // dates (BFNAR 2013:2 continuity): it must start the day after its
    // predecessor ends and end the day before its successor starts. The
    // links are made to say the same once the dates have moved
    // (relinkAroundRedatedYear).
    const { data: neighbours } = await supabase
      .from('fiscal_periods')
      .select('id, period_start, period_end, previous_period_id')
      .eq('company_id', companyId)
      .neq('id', fiscalPeriodId)
      .order('period_start', { ascending: true })
    const others = (neighbours ?? []) as ChainNeighbour[]
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

    // What the year holds (verifikat, drafts, opening balances, year-end
    // work, filings, holds, the lock date) is checked by the RPC in the same
    // transaction that moves the dates, so nothing can land in between.
    const { data, error: rpcError } = await supabase.rpc('redate_fiscal_period', {
      p_company_id: companyId,
      p_period_id: fiscalPeriodId,
      p_period_start: newStart,
      p_period_end: newEnd,
      p_name: input.name ?? null,
      p_dry_run: options.dryRun === true,
      p_user_id: ctx.userId,
    })
    if (rpcError || !data) return writeFailure(rpcError, log)

    const result = data as RedateRpcResult
    if (!result.ok) return redateFailure(result)

    if (options.dryRun) {
      const changes: UpdateFiscalPeriodInput = {}
      if (input.name) changes.name = input.name
      if (input.period_start) changes.period_start = input.period_start
      if (input.period_end) changes.period_end = input.period_end
      return { ok: true, dryRun: true, preview: { fiscal_period_id: fiscalPeriodId, changes } }
    }
    const link = await relinkAroundRedatedYear(
      ctx,
      { id: fiscalPeriodId, previous_period_id: (period.previous_period_id as string | null | undefined) ?? null },
      others,
      predecessor,
      successor,
    )
    return { ok: true, data: { ...(result.period as FiscalPeriod), previous_period_id: link } }
  }

  // Name only (dates sent unchanged are not a change).
  if (!input.name) return { ok: true, data: period as FiscalPeriod }

  if (options.dryRun) {
    return { ok: true, dryRun: true, preview: { fiscal_period_id: fiscalPeriodId, changes: { name: input.name } } }
  }

  const { data: updated, error: updateError } = await supabase
    .from('fiscal_periods')
    .update({ name: input.name })
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .select('*')
    .single()

  if (updateError || !updated) return writeFailure(updateError, log)

  return { ok: true, data: updated as FiscalPeriod }
}

/** Another year of the company, as the re-date reads it. */
interface ChainNeighbour {
  id: string
  period_start: string
  period_end: string
  previous_period_id: string | null
}

/**
 * Make the continuity links say what the dates say around a year that was
 * just re-dated. redate_fiscal_period moves the dates only, and the checks
 * before it leave the year starting the day after `predecessor` ends and
 * ending the day before `successor` starts, so:
 *   - the year's own link is its predecessor, none for the earliest year: a
 *     year that had no link because a hole lay before it kept none after it
 *     was moved down next to the older year (crm#1982);
 *   - the successor's link is the moved year;
 *   - any other year still pointing at the moved year no longer starts the
 *     day after it ends (an empty year moved out from between two others):
 *     a link only ever names the year ending the day before
 *     (resolvePreviousFiscalPeriod), so that one is cleared.
 * Only links that are wrong are written. Best effort, like the relink after
 * a create: the dates have moved, a failed link is logged, and every reader
 * falls back to the dates when a link is missing. Answers the link the moved
 * year ended up with.
 */
async function relinkAroundRedatedYear(
  ctx: OperationContext,
  moved: { id: string; previous_period_id: string | null },
  others: readonly ChainNeighbour[],
  predecessor: ChainNeighbour | null,
  successor: ChainNeighbour | null,
): Promise<string | null> {
  const { supabase, companyId, log } = ctx
  const setLink = async (periodId: string, previousPeriodId: string | null): Promise<boolean> => {
    const { error } = await supabase
      .from('fiscal_periods')
      .update({ previous_period_id: previousPeriodId })
      .eq('id', periodId)
      .eq('company_id', companyId)
    if (error) {
      log.error('failed to relink continuity chain after a re-date', error, {
        movedPeriodId: moved.id,
        relinkPeriodId: periodId,
      })
    }
    return !error
  }

  let link = moved.previous_period_id
  const ownLink = predecessor?.id ?? null
  if (link !== ownLink && (await setLink(moved.id, ownLink))) link = ownLink
  for (const other of others) {
    const followsMoved = other.id === successor?.id
    if (followsMoved && other.previous_period_id !== moved.id) await setLink(other.id, moved.id)
    if (!followsMoved && other.previous_period_id === moved.id) await setLink(other.id, null)
  }
  return link
}

/** A failed fiscal_periods write as a code, for the update and the re-date. */
function writeFailure(error: { message?: string } | null, log: OperationContext['log']): Failure {
  const msg = error?.message ?? ''
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
  log.error('fiscal period update failed', error ?? new Error('no row returned'))
  return { ok: false, code: 'FISCAL_PERIOD_UPDATE_FAILED', details: { reason: msg || undefined } }
}

/** redate_fiscal_period's refusal as a code, every blocker named in Swedish. */
function redateFailure(result: RedateRpcResult): Failure {
  if (result.code === 'PERIOD_NOT_FOUND') return { ok: false, code: 'PERIOD_NOT_FOUND' }
  if (result.code === 'FORBIDDEN') return { ok: false, code: 'FORBIDDEN' }
  const blockers = result.blockers ?? []
  return {
    ok: false,
    code: 'FISCAL_PERIOD_DATES_BLOCKED',
    details: { blockers },
    messageSv: ['Datumen kan inte ändras.', ...blockers.map((b) => b.message_sv)].join(' '),
  }
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

/**
 * A period-service refusal as a Failure: the code it threw, and its sentence
 * when it wrote one for the reader. An uncoded throw is a failure nobody
 * planned for (a database error), kept as UNKNOWN_ERROR with the error.
 */
function periodFailure(err: unknown): Failure {
  const spoken = userFacingCode(err)
  if (spoken) return { ok: false, code: spoken, messageSv: messageOf(err) }
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code === 'string' && getErrorEntry(code)) return { ok: false, code }
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
      preview: {
        fiscal_period_id: period.id,
        name: period.name,
        period_start: period.period_start,
        period_end: period.period_end,
        locked_at: period.locked_at,
        will_set_locked_at: null,
      },
    }
  }
  try {
    const period = await unlockPeriod(ctx.supabase, ctx.companyId, ctx.userId, fiscalPeriodId)
    return { ok: true, data: period }
  } catch (err) {
    const failure = periodFailure(err)
    if (failure.code === 'UNKNOWN_ERROR') ctx.log.error('failed to unlock period', err as Error)
    return failure
  }
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
      return periodFailure(err)
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
    const failure = periodFailure(err)
    if (failure.code === 'UNKNOWN_ERROR') ctx.log.error('failed to mark period closed externally', err as Error)
    return failure
  }
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
    const failure = periodFailure(err)
    if (failure.code === 'UNKNOWN_ERROR') ctx.log.error('failed to reopen externally closed period', err as Error)
    return failure
  }
}

/**
 * Remove the company's first räkenskapsår when it holds nothing (crm#1450):
 * the empty year an older onboarding could seed before the company existed
 * (crm#1140), which otherwise keeps the real first year from starting on the
 * registration day. Every rule (first year only, never the only year, no
 * verifikat or draft of any status, no issued voucher number, nothing that
 * points at the year, not closed, locked, held or filed) is checked by the
 * delete_empty_fiscal_period RPC in the same transaction that deletes, and
 * the RPC writes the audit_log row naming who removed it.
 */
export async function deleteEmptyFiscalPeriod(
  ctx: OperationContext,
  fiscalPeriodId: string,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<FiscalPeriod>> {
  // The dry run (the MCP staging preview) reads the STABLE preview; the
  // writer runs the same check again under the row lock before it deletes.
  const { data, error } = await ctx.supabase.rpc(
    options.dryRun ? 'delete_empty_fiscal_period_preview' : 'delete_empty_fiscal_period',
    { p_company_id: ctx.companyId, p_period_id: fiscalPeriodId, p_user_id: ctx.userId },
  )
  // A jsonb answer, read like merge-customers' rpcAnswer (a client may wrap it).
  const result = (Array.isArray(data) ? data[0] : data) as RedateRpcResult | null
  if (error || !result || typeof result.ok !== 'boolean') {
    ctx.log.error('fiscal period delete failed', error ?? new Error('no result'))
    return { ok: false, code: 'UNKNOWN_ERROR', error: error ?? undefined }
  }
  if (!result.ok) {
    if (result.code === 'PERIOD_NOT_FOUND') return { ok: false, code: 'PERIOD_NOT_FOUND' }
    if (result.code === 'FORBIDDEN') return { ok: false, code: 'FORBIDDEN' }
    const blockers = result.blockers ?? []
    return {
      ok: false,
      code: 'FISCAL_PERIOD_DELETE_BLOCKED',
      details: { blockers },
      messageSv: ['Räkenskapsåret kan inte tas bort.', ...blockers.map((b) => b.message_sv)].join(' '),
    }
  }
  const period = result.period as FiscalPeriod
  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      preview: {
        fiscal_period_id: period.id,
        name: period.name,
        period_start: period.period_start,
        period_end: period.period_end,
        will: 'remove this empty first fiscal year; the next year becomes the first',
      },
    }
  }
  return { ok: true, data: period }
}
