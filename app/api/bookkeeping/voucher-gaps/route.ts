import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { validateBody, validateQuery } from '@/lib/api/validate'
import { VoucherGapQuerySchema, SaveGapExplanationSchema } from '@/lib/api/schemas'
import { requireCompanyId } from '@/lib/company/context'

export async function GET(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const companyId = await requireCompanyId(supabase, user.id)

  const validation = validateQuery(request, VoucherGapQuerySchema)
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

  const { data: seriesRows } = await seriesQuery

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

    if (!gapsError && gaps && gaps.length > 0) {
      for (const gap of gaps as Array<{ gap_start: number; gap_end: number }>) {
        allGaps.push({
          series: row.voucher_series,
          gap_start: gap.gap_start,
          gap_end: gap.gap_end,
          explanation: null,
        })
      }
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
}

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const companyId = await requireCompanyId(supabase, user.id)

  const validation = await validateBody(request, SaveGapExplanationSchema)
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
}
