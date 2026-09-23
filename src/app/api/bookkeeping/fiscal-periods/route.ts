import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validatePeriodDuration } from '@/lib/bookkeeping/validate-period-duration'
import { validateBody } from '@/lib/api/validate'
import { CreateFiscalPeriodSchema } from '@/lib/api/schemas'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

// Response shapes are legacy `{ error: string }`, kept for the räkenskapsår UI.
// Success may carry a non-blocking `warnings` array (same shape as the invoice
// booking routes: `{ code, message }`).

/** A prior räkenskapsår that is still fully open when the next one is created. */
interface OpenPriorPeriod {
  id: string
  name: string
  period_start: string
  period_end: string
}

export const GET = withRouteContext('period.list', async (_request, ctx) => {
  const { supabase, companyId } = ctx

  const { data, error } = await supabase
    .from('fiscal_periods')
    .select('*')
    .eq('company_id', companyId)
    .order('period_start', { ascending: false })

  if (error) {
    return NextResponse.json({ error: getUserErrorMessage(error) }, { status: 500 })
  }

  return NextResponse.json({ data })
})

export const POST = withRouteContext(
  'period.create',
  async (request, ctx) => {
  const { supabase, companyId, user, log } = ctx

  const validation = await validateBody(request, CreateFiscalPeriodSchema)
  if (!validation.success) return validation.response
  const body = validation.data

  // Fetch all existing periods to determine direction
  const { data: allPeriods } = await supabase
    .from('fiscal_periods')
    .select('id, period_start, period_end, is_closed')
    .eq('company_id', companyId)
    .order('period_start', { ascending: true })

  // "First" räkenskapsår = no existing period starts earlier, NOT "no period
  // exists at all". Mirrors the enforce_first_of_month_for_subsequent_periods
  // trigger: a mid-month start is legal for the company's first year (BFL 3
  // kap. 3 §, it begins the day bokföringsskyldigheten inträder) and only
  // subsequent years must start on the 1st (BFL 3 kap. 1 §). A company that
  // imported 2024+ from Fortnox and now backfills its first year from
  // 2022-07-22 is creating exactly that first year; the old
  // `allPeriods.length === 0` test refused it with the 1st-of-month error
  // while the trigger would have accepted the row (issue #2237).
  const isFirstPeriod = !(allPeriods ?? []).some((p) => p.period_start < body.period_start)

  // Validate period duration (max 18 months per BFL 3 kap.)
  const durationError = validatePeriodDuration(body.period_start, body.period_end, { isFirstPeriod })
  if (durationError) {
    return NextResponse.json({ error: durationError }, { status: 400 })
  }

  // Identify the new period's immediate neighbours. Fiscal periods never overlap
  // (the no_overlapping_fiscal_periods DB exclusion constraint), so ordering by
  // period_start is also ordering by period_end.
  //   predecessor = closest existing period ending before the new one starts
  //   successor   = closest existing period starting after the new one ends
  const sortedPeriods = allPeriods ?? []
  const predecessor = [...sortedPeriods].reverse().find((p) => p.period_end < body.period_start) ?? null
  const successor = sortedPeriods.find((p) => p.period_start > body.period_end) ?? null

  // Prior räkenskapsår that are still fully open at the moment the next one is
  // appended. Advisory only (see the isAppend block below), attached to the
  // success response so the UI can nudge without gating.
  let openPriorPeriods: OpenPriorPeriod[] = []

  if (sortedPeriods.length > 0) {
    const earliest = sortedPeriods[0]
    const latest = sortedPeriods[sortedPeriods.length - 1]

    const isPrepend = body.period_end < earliest.period_start
    const isAppend = body.period_start > latest.period_end

    if (isPrepend) {
      // Prepend before the earliest period: new period_end must be the day before
      // the earliest period starts. Skip the "no open prior period" constraint:
      // backfilling an earlier year needs that year to stay open.
      const expectedEnd = new Date(earliest.period_start + 'T12:00:00Z')
      expectedEnd.setUTCDate(expectedEnd.getUTCDate() - 1)
      const expectedEndStr = expectedEnd.toISOString().split('T')[0]
      if (body.period_end !== expectedEndStr) {
        return NextResponse.json(
          { error: `Period must end on ${expectedEndStr} (day before earliest period starts)` },
          { status: 400 }
        )
      }
    } else {
      // Forward-like: either append a new latest year OR fill an interior gap
      // between two existing years. Both must chain onto their immediate
      // predecessor, i.e. start the day after it ends. When appending, the
      // predecessor IS the latest period (original forward-chaining behaviour);
      // when filling a gap, it's the year just before the hole.
      if (predecessor) {
        const next = new Date(predecessor.period_end + 'T12:00:00Z')
        next.setUTCDate(next.getUTCDate() + 1)
        const expectedStart = next.toISOString().split('T')[0]
        if (body.period_start !== expectedStart) {
          return NextResponse.json(
            { error: `Period must start on ${expectedStart} (day after the preceding period ends)` },
            { status: 400 }
          )
        }
      }
      // No predecessor here means the new period reaches back over the earliest
      // existing period (an overlap): the overlap check below returns 409.

      // Gap fill: the new period must also butt up against its SUCCESSOR (end
      // exactly the day before the successor starts) so it fills the hole
      // completely. The predecessor check above only constrains the start side.
      // Without this end check a too-short period would leave a fresh sub-gap
      // yet still get the successor's previous_period_id relinked onto it
      // (below), silently breaking the BFNAR 2013:2 continuity chain; a too-long
      // period that bleeds past the successor is separately caught as an overlap
      // (409). Appends have no successor, so this is skipped.
      if (successor) {
        const prevDay = new Date(successor.period_start + 'T12:00:00Z')
        prevDay.setUTCDate(prevDay.getUTCDate() - 1)
        const expectedEnd = prevDay.toISOString().split('T')[0]
        if (body.period_end !== expectedEnd) {
          return NextResponse.json(
            { error: `Period must end on ${expectedEnd} (day before the following period starts)` },
            { status: 400 }
          )
        }
      }

      // An open prior räkenskapsår is INFORMATION, never a gate.
      //
      // This used to hard-refuse (409) a new latest räkenskapsår while any
      // prior period was still fully open, on the theory that the prior year
      // "must at least be locked so nothing is back-posted into a year you've
      // moved on from". That theory has no support in BFL and inverts two rules
      // that bind simultaneously:
      //   - BFL 5 kap 2 §: kontanta in-/utbetalningar bokförs senast påföljande
      //     arbetsdag, övriga affärshändelser "så snart det kan ske" (per BFNAR
      //     2013:2 senast månaden efter). Booking January REQUIRES a
      //     räkenskapsår covering January, within weeks.
      //   - BFL 6 kap: årsbokslut/årsredovisning ska upprättas inom 6 månader
      //     efter räkenskapsårets utgång (AB filing 7 månader). The prior year
      //     is therefore legitimately unfinished, and must stay unlocked so
      //     bokslutsposter (periodiseringar, avskrivningar, skatt) can be
      //     posted into it, for months into the new year.
      // Running the two years in parallel is not a tolerated edge case, it is
      // the normal and legally required state during that window. The old guard
      // made one unbooked December bank transaction (which blocks lockPeriod,
      // correctly, per BFL 5 kap 2 §) freeze ALL bookkeeping in the new year.
      //
      // What genuinely protects the prior year is unchanged and lives
      // elsewhere: period locked_at (enforce_period_lock) and
      // company_settings.bookkeeping_locked_through (enforce_company_lock_date),
      // both set deliberately by the user. Creating the next räkenskapsår does
      // not write a single row into the prior one.
      //
      // What IS kept from the old check is its detection, downgraded to an
      // advisory on the success response: an open prior year means its UB is
      // not final, so the new year's ingående balanser are not posted yet.
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

        const lockThrough = settings?.bookkeeping_locked_through ?? null
        const trulyOpen = (openPeriods ?? []).filter(
          (p) => !(lockThrough && p.period_end <= lockThrough)
        )

        openPriorPeriods = trulyOpen.map((p) => ({
          id: p.id,
          name: p.name,
          period_start: p.period_start,
          period_end: p.period_end,
        }))
      }
    }
  }

  // Defense-in-depth: check for overlapping periods
  const { data: overlapping } = await supabase
    .from('fiscal_periods')
    .select('id, name')
    .eq('company_id', companyId)
    .lte('period_start', body.period_end)
    .gte('period_end', body.period_start)
    .limit(1)

  if (overlapping && overlapping.length > 0) {
    return NextResponse.json(
      { error: `Overlaps with existing period: ${overlapping[0].name}` },
      { status: 409 }
    )
  }

  // Chain the new period onto its predecessor (append or gap fill) so reports
  // can walk the BFNAR 2013:2 continuity chain instead of scanning every prior
  // journal line. Prepend leaves this null and instead relinks the old earliest
  // period to follow the new one (below).
  const previousPeriodId = predecessor ? predecessor.id : null

  const { data, error } = await supabase
    .from('fiscal_periods')
    .insert({
      user_id: user.id,
      company_id: companyId,
      name: body.name,
      period_start: body.period_start,
      period_end: body.period_end,
      previous_period_id: previousPeriodId,
    })
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: getUserErrorMessage(error) }, { status: 500 })
  }

  // Keep the continuity chain intact for the period that now follows the new one:
  // - Prepend: the old earliest period follows the new (earlier) period.
  // - Gap fill: the successor period follows the new period.
  // (Append has no successor, so nothing to relink.)
  if (sortedPeriods.length > 0) {
    const earliest = sortedPeriods[0]
    const isPrepend = body.period_end < earliest.period_start
    const periodToRelink = isPrepend ? earliest : successor
    if (periodToRelink) {
      const { error: relinkError } = await supabase
        .from('fiscal_periods')
        .update({ previous_period_id: data.id })
        .eq('id', periodToRelink.id)
        .eq('company_id', companyId)
      if (relinkError) {
        // The period WAS created — don't fail the request, but a broken
        // continuity chain (BFNAR 2013:2) must never be silent.
        log.error('failed to relink continuity chain after period create', relinkError, {
          createdPeriodId: data.id,
          relinkPeriodId: periodToRelink.id,
        })
      }
    }
  }

  // Non-blocking advisory: the new year exists and is bookable right now, but
  // its ingående balanser are still pending because the prior year's bokslut
  // has not run. Every action named here is reachable, so this never dead-ends:
  // the user can book in the new year immediately and the IB lands by itself
  // when the bokslut for the prior year is executed (executeYearEndClosing
  // reuses an already-created next period and posts the IB verifikat into it).
  const warnings: Array<{ code: string; message: string }> = []
  if (openPriorPeriods.length > 0) {
    const names = openPriorPeriods.map((p) => p.name).join(', ')
    warnings.push({
      code: 'PRIOR_FISCAL_YEAR_STILL_OPEN',
      message:
        `Räkenskapsåret är skapat och du kan bokföra i det direkt. ${names} är fortfarande öppet, ` +
        'vilket är normalt medan bokslutet pågår: du får bokföra i båda åren samtidigt. ' +
        'Ingående balanser bokförs automatiskt när bokslutet för föregående år körs.',
    })
  }

  return NextResponse.json(warnings.length > 0 ? { data, warnings } : { data })
  },
  { requireWrite: true },
)
