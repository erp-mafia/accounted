import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { validatePeriodDuration, parseDateParts } from '@/lib/bookkeeping/validate-period-duration'
import { z } from 'zod'

const UpdateFiscalPeriodSchema = z.object({
  name: z.string().min(1).optional(),
  period_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Startdatum måste vara i format ÅÅÅÅ-MM-DD').optional(),
  period_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Slutdatum måste vara i format ÅÅÅÅ-MM-DD').optional(),
})

// Response shapes are legacy `{ error: string }` (Swedish) — the fiscal-year
// settings UI renders them directly. Only the auth/company layer was moved
// into withRouteContext.
export const PATCH = withRouteContext(
  'period.update',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params
  const { supabase, companyId } = ctx

  const validation = await validateBody(request, UpdateFiscalPeriodSchema)
  if (!validation.success) return validation.response
  const body = validation.data

  // Fetch the period
  const { data: period, error: fetchError } = await supabase
    .from('fiscal_periods')
    .select('*')
    .eq('id', id)
    .eq('company_id', companyId)
    .single()

  if (fetchError || !period) {
    return NextResponse.json({ error: 'Räkenskapsår hittades inte' }, { status: 404 })
  }

  // Cannot edit locked or closed periods
  if (period.locked_at) {
    return NextResponse.json({ error: 'Kan inte ändra ett låst räkenskapsår' }, { status: 400 })
  }
  if (period.is_closed) {
    return NextResponse.json({ error: 'Kan inte ändra ett stängt räkenskapsår' }, { status: 400 })
  }

  // If dates are being changed, check for existing journal entries
  if (body.period_start || body.period_end) {
    const { count: entryCount } = await supabase
      .from('journal_entries')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .eq('fiscal_period_id', id)
      .in('status', ['posted', 'reversed'])

    if (entryCount && entryCount > 0) {
      return NextResponse.json(
        { error: `Kan inte ändra datum: ${entryCount} bokförda verifikationer finns i perioden. Ta bort eller flytta dem först.` },
        { status: 400 }
      )
    }

    const newStart = body.period_start || period.period_start
    const newEnd = body.period_end || period.period_end

    // First period for this company may start on any day (BFL 3 kap.).
    // EF's first period may also extend to 31 dec next year (förlängt
    // räkenskapsår, max 18 months) when the company started after 1 juli.
    const { count: earlierCount } = await supabase
      .from('fiscal_periods')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .neq('id', id)
      .lt('period_start', newStart)

    const isFirstPeriod = !earlierCount || earlierCount === 0

    // Enskild firma must end on 31 december (BFL 3 kap.). Subsequent periods
    // must also start on 1 januari. The first period may start any day.
    const { data: companyRow } = await supabase
      .from('companies')
      .select('entity_type')
      .eq('id', companyId)
      .single()

    if (companyRow?.entity_type === 'enskild_firma') {
      const e = parseDateParts(newEnd)
      if (e.month !== 12 || e.day !== 31) {
        return NextResponse.json(
          { error: 'Enskild firma måste ha slutdatum 31 december enligt BFL 3 kap.' },
          { status: 400 }
        )
      }
      if (!isFirstPeriod) {
        const s = parseDateParts(newStart)
        if (s.month !== 1 || s.day !== 1) {
          return NextResponse.json(
            { error: 'Enskild firma måste använda kalenderår (1 januari till 31 december) enligt BFL 3 kap.' },
            { status: 400 }
          )
        }
      }
    }

    // Validate period duration (max 18 months for first period, 12 for subsequent, per BFL 3 kap.)
    const durationError = validatePeriodDuration(newStart, newEnd, { isFirstPeriod })
    if (durationError) {
      return NextResponse.json({ error: durationError }, { status: 400 })
    }

    // Check for overlapping periods (excluding this one)
    const { data: overlapping } = await supabase
      .from('fiscal_periods')
      .select('id, name')
      .eq('company_id', companyId)
      .neq('id', id)
      .lte('period_start', newEnd)
      .gte('period_end', newStart)
      .limit(1)

    if (overlapping && overlapping.length > 0) {
      return NextResponse.json(
        { error: `Överlappar med befintligt räkenskapsår: ${overlapping[0].name}` },
        { status: 409 }
      )
    }
  }

  // Build update object
  const updates: Record<string, unknown> = {}
  if (body.name) updates.name = body.name
  if (body.period_start) updates.period_start = body.period_start
  if (body.period_end) updates.period_end = body.period_end

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ data: period })
  }

  const { data: updated, error: updateError } = await supabase
    .from('fiscal_periods')
    .update(updates)
    .eq('id', id)
    .eq('company_id', companyId)
    .select()
    .single()

  if (updateError) {
    // Database trigger/constraint will catch invalid month boundaries
    const msg = updateError.message
    if (msg.includes('period_start') || msg.includes('period_end') || msg.includes('first of a month') || msg.includes('1st of a month')) {
      return NextResponse.json(
        { error: 'Perioden måste sluta sista dagen i en månad. Efterföljande perioder måste börja den 1:a.' },
        { status: 400 }
      )
    }
    return NextResponse.json({ error: msg }, { status: 500 })
  }

  return NextResponse.json({ data: updated })
  },
  { requireWrite: true },
)
