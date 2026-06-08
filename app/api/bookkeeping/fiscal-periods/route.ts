import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { validatePeriodDuration } from '@/lib/bookkeeping/validate-period-duration'
import { validateBody } from '@/lib/api/validate'
import { CreateFiscalPeriodSchema } from '@/lib/api/schemas'
import { requireCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { createLogger } from '@/lib/logger'

const log = createLogger('api/bookkeeping/fiscal-periods')

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const companyId = await requireCompanyId(supabase, user.id)

  const { data, error } = await supabase
    .from('fiscal_periods')
    .select('*')
    .eq('company_id', companyId)
    .order('period_start', { ascending: false })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data })
}

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const companyId = await requireCompanyId(supabase, user.id)

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

  if (allPeriods && allPeriods.length > 0) {
    const earliest = allPeriods[0]
    const latest = allPeriods[allPeriods.length - 1]

    const isBackward = body.period_end < earliest.period_start
    const isForward = body.period_start > latest.period_end

    if (!isBackward && !isForward) {
      // Neither backward nor forward — must overlap or be in the middle
      return NextResponse.json(
        { error: 'New period must chain before the earliest or after the latest existing period' },
        { status: 400 }
      )
    }

    if (isBackward) {
      // Backward chaining: new period_end must be day before earliest period_start
      const expectedEnd = new Date(earliest.period_start + 'T12:00:00Z')
      expectedEnd.setUTCDate(expectedEnd.getUTCDate() - 1)
      const expectedEndStr = expectedEnd.toISOString().split('T')[0]
      if (body.period_end !== expectedEndStr) {
        return NextResponse.json(
          { error: `Period must end on ${expectedEndStr} (day before earliest period starts)` },
          { status: 400 }
        )
      }
      // Skip "no unclosed period" constraint for backward chaining (backfill needs the period open)
    } else {
      // Forward chaining: keep existing constraints (contiguity + no unclosed periods)
      const prev = new Date(latest.period_end + 'T12:00:00Z')
      prev.setUTCDate(prev.getUTCDate() + 1)
      const expectedStart = prev.toISOString().split('T')[0]
      if (body.period_start !== expectedStart) {
        return NextResponse.json(
          { error: `Period must start on ${expectedStart} (day after latest period ends)` },
          { status: 400 }
        )
      }

      // Enforce: max one editable prior period (no skipping ahead) — forward only.
      // A period is "effectively locked" if EITHER its own locked_at is set, OR
      // company_settings.bookkeeping_locked_through covers its end date (the
      // enforce_company_lock_date trigger blocks any entry on/before that date).
      // BFL 6 kap allows löpande bokföring of the new year in parallel with
      // bokslut work on the prior year, so locked-but-not-closed prior periods
      // must not block creating the next räkenskapsår.
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

  // Resolve previous_period_id for forward chaining so the new period is
  // linked to the period it follows. Without this, balance-sheet/trial-balance
  // reports fall back to scanning every prior journal line (BFNAR 2013:2
  // continuity chain is broken). Backward chaining sets previous_period_id
  // on the old earliest period instead (see below), not on the new one.
  let previousPeriodId: string | null = null
  if (allPeriods && allPeriods.length > 0) {
    const latest = allPeriods[allPeriods.length - 1]
    if (body.period_start > latest.period_end) {
      previousPeriodId = latest.id
    }
  }

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

  // For backward chaining: update the old earliest period's previous_period_id
  if (allPeriods && allPeriods.length > 0) {
    const earliest = allPeriods[0]
    if (body.period_end < earliest.period_start) {
      await supabase
        .from('fiscal_periods')
        .update({ previous_period_id: data.id })
        .eq('id', earliest.id)
        .eq('company_id', companyId)
    }
  }

  return NextResponse.json({ data })
}
