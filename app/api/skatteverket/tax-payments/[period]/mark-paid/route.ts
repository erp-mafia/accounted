import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'

ensureInitialized()

/**
 * Mark the AGI period's tax payment (skatt + avgifter) as paid.
 *
 * This is a manual confirmation by the user. The Skattekonto sync also flips
 * the flag automatically when the period's AGI debit row is booked with the
 * exact declared amount and the account is not in deficit (see
 * extensions/general/skatteverket/lib/agi-tax-settlement.ts).
 */
export const POST = withRouteContext<{ params: Promise<{ period: string }> }>(
  'tax_payment.mark_paid',
  async (request, { supabase, companyId }, { params }) => {
  const { period } = await params
  const periodMatch = /^(\d{4})-(\d{2})$/.exec(period)
  if (!periodMatch) {
    return NextResponse.json(
      { error: 'Ogiltig period. Använd YYYY-MM (t.ex. 2026-04).' },
      { status: 400 }
    )
  }
  const periodYear = parseInt(periodMatch[1], 10)
  const periodMonth = parseInt(periodMatch[2], 10)

  const { data: agi } = await supabase
    .from('agi_declarations')
    .select('id')
    .eq('company_id', companyId)
    .eq('period_year', periodYear)
    .eq('period_month', periodMonth)
    .single()

  if (!agi) {
    return NextResponse.json(
      { error: `Ingen AGI för perioden ${period}.` },
      { status: 404 }
    )
  }

  const { error } = await supabase
    .from('agi_declarations')
    .update({ tax_paid_at: new Date().toISOString() })
    .eq('id', agi.id)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data: { ok: true } })
  },
  { requireWrite: true },
)
