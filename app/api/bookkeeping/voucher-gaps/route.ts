import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody, validateQuery } from '@/lib/api/validate'
import { VoucherGapQuerySchema, SaveGapExplanationSchema } from '@/lib/api/schemas'

// Voucher gap detection + explanations (BFNAR 2013:2 — gaps in voucher
// sequences must be documented). Response shapes are legacy `{ data }` /
// `{ error: string }`.

export const GET = withRouteContext('voucher_gaps.list', async (request, ctx) => {
  const { supabase, companyId, log } = ctx

  const validation = validateQuery(request, VoucherGapQuerySchema, {
    log,
    operation: 'voucher_gaps.list',
  })
  if (!validation.success) return validation.response
  const { fiscal_period_id, voucher_series } = validation.data

  // Get all series used in this period (or filter to specific series)
  let seriesQuery = supabase
    .from('voucher_sequences')
    .select('voucher_series')
    .eq('company_id', companyId)
    .eq('fiscal_period_id', fiscal_period_id)

  if (voucher_series) {
    seriesQuery = seriesQuery.eq('voucher_series', voucher_series)
  }

  const { data: seriesRows, error: seriesError } = await seriesQuery
  if (seriesError) {
    log.error('voucher series lookup failed', seriesError)
    return NextResponse.json({ error: seriesError.message }, { status: 500 })
  }

  if (!seriesRows || seriesRows.length === 0) {
    return NextResponse.json({
      data: { gaps: [], totalGaps: 0, unexplainedGaps: 0 },
    })
  }

  // Detect gaps per series
  const allGaps: Array<{
    series: string
    gap_start: number
    gap_end: number
    explanation: { id: string; explanation: string; user_id: string; created_at: string } | null
  }> = []

  for (const row of seriesRows) {
    const { data: gaps, error: gapsError } = await supabase.rpc('detect_voucher_gaps', {
      p_company_id: companyId,
      p_fiscal_period_id: fiscal_period_id,
      p_series: row.voucher_series,
    })

    // A failing detection MUST surface — silently dropping the series would
    // render "no gaps" on a compliance view when the check didn't run.
    if (gapsError) {
      log.error('detect_voucher_gaps failed', gapsError, { series: row.voucher_series })
      return NextResponse.json({ error: gapsError.message }, { status: 500 })
    }

    for (const gap of (gaps ?? []) as Array<{ gap_start: number; gap_end: number }>) {
      allGaps.push({
        series: row.voucher_series,
        gap_start: gap.gap_start,
        gap_end: gap.gap_end,
        explanation: null,
      })
    }
  }

  // Fetch existing explanations and match them
  if (allGaps.length > 0) {
    const { data: explanations } = await supabase
      .from('voucher_gap_explanations')
      .select('id, voucher_series, gap_start, gap_end, explanation, user_id, created_at')
      .eq('company_id', companyId)
      .eq('fiscal_period_id', fiscal_period_id)

    if (explanations) {
      const explanationMap = new Map(
        explanations.map((e) => [`${e.voucher_series}:${e.gap_start}:${e.gap_end}`, e])
      )

      for (const gap of allGaps) {
        const key = `${gap.series}:${gap.gap_start}:${gap.gap_end}`
        const match = explanationMap.get(key)
        if (match) {
          gap.explanation = {
            id: match.id,
            explanation: match.explanation,
            user_id: match.user_id,
            created_at: match.created_at,
          }
        }
      }
    }
  }

  const unexplained = allGaps.filter((g) => !g.explanation).length

  return NextResponse.json({
    data: {
      gaps: allGaps,
      totalGaps: allGaps.length,
      unexplainedGaps: unexplained,
    },
  })
})

export const POST = withRouteContext(
  'voucher_gaps.explain',
  async (request, ctx) => {
    const { supabase, companyId, user, log } = ctx

    const validation = await validateBody(request, SaveGapExplanationSchema, {
      log,
      operation: 'voucher_gaps.explain',
    })
    if (!validation.success) return validation.response
    const { fiscal_period_id, voucher_series, gap_start, gap_end, explanation } = validation.data

    // Upsert explanation (RLS enforces owner/admin role)
    const { data, error } = await supabase
      .from('voucher_gap_explanations')
      .upsert(
        {
          company_id: companyId,
          user_id: user.id,
          fiscal_period_id,
          voucher_series,
          gap_start,
          gap_end,
          explanation,
        },
        { onConflict: 'company_id,fiscal_period_id,voucher_series,gap_start,gap_end' }
      )
      .select()
      .single()

    if (error) {
      if (error.code === '42501') {
        return NextResponse.json(
          { error: 'Only company owners and admins can document gap explanations' },
          { status: 403 }
        )
      }
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ data })
  },
  { requireWrite: true },
)
