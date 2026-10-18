import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { getAgiPaymentDueDate } from '@/lib/tax/deadline-config'

/**
 * Get tax payment status for an AGI period.
 *
 * Returns the AGI declaration's payment-tracking fields (file generated at,
 * paid at, totals) so the UI can render the TaxPaymentPanel without
 * round-tripping to load the full declaration, plus `payment_due_date`: the
 * day the period's tax and contributions must be on the skattekonto, from the
 * deadline configuration (getAgiPaymentDueDate: the 12th of the following
 * month; the 17th when that month is January, or August up to the SEK 40M
 * VAT taxable base; moved to a banking day).
 */
export const GET = withRouteContext<{ params: Promise<{ period: string }> }>(
  'tax_payment.status',
  async (request, { supabase, companyId }, { params }) => {
  const { period } = await params
  const periodMatch = /^(\d{4})-(\d{2})$/.exec(period)
  if (!periodMatch) {
    return NextResponse.json(
      { error: 'Ogiltig period. Använd YYYY-MM.' },
      { status: 400 }
    )
  }
  const periodYear = parseInt(periodMatch[1], 10)
  const periodMonth = parseInt(periodMatch[2], 10)

  const { data: agi } = await supabase
    .from('agi_declarations')
    .select('total_tax, total_avgifter, tax_payment_file_generated_at, tax_payment_file_format, tax_paid_at')
    .eq('company_id', companyId)
    .eq('period_year', periodYear)
    .eq('period_month', periodMonth)
    .single()

  if (!agi) {
    return NextResponse.json({ data: null })
  }

  const { data: settings } = await supabase
    .from('company_settings')
    .select('vat_registered, vat_taxable_base_over_40m')
    .eq('company_id', companyId)
    .maybeSingle()
  const paymentDueDate = getAgiPaymentDueDate(periodYear, periodMonth, {
    vat_registered: settings?.vat_registered === true,
    vat_taxable_base_over_40m: settings?.vat_taxable_base_over_40m === true,
  })

  return NextResponse.json({ data: { ...agi, payment_due_date: paymentDueDate } })
  },
)
