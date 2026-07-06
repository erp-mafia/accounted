import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validatePeriodDuration } from '@/lib/bookkeeping/validate-period-duration'
import { validateBody } from '@/lib/api/validate'
import { CreateFiscalPeriodSchema } from '@/lib/api/schemas'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'

// Response shapes are legacy `{ error: string }` (plus one envelope code for
// the blocked-by-open-periods dialog) — kept for the räkenskapsår UI.

export const GET = withRouteContext('period.list', async (_request, ctx) => {
  const { supabase, companyId } = ctx

  const { data, error } = await supabase
    .from('fiscal_periods')
    .select('*')
    .eq('company_id', companyId)
    .order('period_start', { ascending: false })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
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

  const isFirstPeriod = !allPeriods || allPeriods.length === 0

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

      // The "prior year must be locked" guard applies only when appending a new
      // latest räkenskapsår, not when backfilling a gap between existing years.
      // A gap fill is a backfill (like prepend) and must not be blocked by an
      // open neighbouring year.
      //
      // A period counts as "effectively locked" if its own locked_at is set, OR
      // company_settings.bookkeeping_locked_through covers its end date (the
      // enforce_company_lock_date trigger blocks any entry on/before that date).
      // BFL 6 kap allows löpande bokföring of the new year in parallel with
      // bokslut work on the prior year, so locked-but-not-closed prior periods
      // must not block creating the next räkenskapsår.
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

        if (trulyOpen.length > 0) {
          // Hand the blocking periods (id + name + dates) to the client so the
          // "Skapa räkenskapsår" dialog can offer to lock them inline and retry,
          // instead of dead-ending the user on a message they can't act on.
          const blockingPeriods = trulyOpen.map((p) => ({
            id: p.id,
            name: p.name,
            period_start: p.period_start,
            period_end: p.period_end,
          }))
          return errorResponseFromCode('PERIOD_CREATE_BLOCKED_BY_OPEN_PERIODS', log, {
            details: { blockingPeriods },
          })
        }
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
    return NextResponse.json({ error: error.message }, { status: 500 })
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

  return NextResponse.json({ data })
  },
  { requireWrite: true },
)
