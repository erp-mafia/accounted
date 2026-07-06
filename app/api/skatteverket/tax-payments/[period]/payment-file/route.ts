import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { requireCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'
import { generateBankgiroPaymentBgLb } from '@/lib/salary/payment/bg-lb-generator'
import { generateSkattekontoOcr, SKATTEKONTO_BANKGIRO } from '@/lib/skatteverket/skattekonto-ocr'
import { validateBankgiroNumber } from '@/lib/bankgiro/luhn'

ensureInitialized()

/**
 * Generate Bankgirot LB-fil for paying skatt + arbetsgivaravgifter for a
 * given AGI period to Skatteverket's Bankgiro 5050-1055 with the company's
 * Skattekontot OCR.
 *
 * Period format: "YYYY-MM" (e.g. "2026-04").
 *
 * Per BFL: Generated payment file is räkenskapsinformation linked to the
 * salary journal entry. Subject to 7-year retention.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ period: string }> }
) {
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

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const companyId = await requireCompanyId(supabase, user.id)

  const { data: agi } = await supabase
    .from('agi_declarations')
    .select('id, total_tax, total_avgifter')
    .eq('company_id', companyId)
    .eq('period_year', periodYear)
    .eq('period_month', periodMonth)
    .single()

  if (!agi) {
    return NextResponse.json(
      { error: `Ingen AGI för perioden ${period}. Generera AGI först.` },
      { status: 404 }
    )
  }

  const totalAmount = Math.round((agi.total_tax + agi.total_avgifter) * 100) / 100
  if (totalAmount <= 0) {
    return NextResponse.json(
      { error: `Inget belopp att betala för perioden ${period}.` },
      { status: 400 }
    )
  }

  const { data: company } = await supabase
    .from('companies')
    .select('name, org_number')
    .eq('id', companyId)
    .single()

  if (!company || !company.org_number) {
    return NextResponse.json(
      { error: 'Organisationsnummer saknas för företaget.' },
      { status: 400 }
    )
  }

  const { data: settings } = await supabase
    .from('company_settings')
    .select('bankgiro')
    .eq('company_id', companyId)
    .single()

  if (!settings?.bankgiro) {
    return NextResponse.json(
      { error: 'Bankgironummer saknas i företagsinställningar.' },
      { status: 400 }
    )
  }

  if (!validateBankgiroNumber(settings.bankgiro)) {
    return NextResponse.json(
      { error: 'Bankgironumret är ogiltigt (felaktig kontrollsiffra).' },
      { status: 400 }
    )
  }

  let ocr: string
  try {
    ocr = generateSkattekontoOcr(company.org_number)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Kunde inte generera OCR-nummer'
    return NextResponse.json({ error: msg }, { status: 400 })
  }

  // Payment date = AGI deadline, which is the 12th of the following month
  // (17th in Jan/Aug for ≤40 MSEK turnover, but we play safe with 12th here).
  const paymentDate = computeTaxPaymentDate(periodYear, periodMonth)

  let result
  try {
    result = generateBankgiroPaymentBgLb(
      { name: company.name, senderBankgiro: settings.bankgiro },
      {
        receiverBankgiro: SKATTEKONTO_BANKGIRO,
        ocr,
        amount: totalAmount,
        receiverName: 'Skatteverket',
      },
      { paymentDate, periodLabel: period }
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Kunde inte generera betalfil'
    return NextResponse.json({ error: msg }, { status: 400 })
  }

  await supabase
    .from('agi_declarations')
    .update({
      tax_payment_file_generated_at: new Date().toISOString(),
      tax_payment_file_format: 'bg_lb',
    })
    .eq('id', agi.id)
    .eq('company_id', companyId)

  const buffer = Buffer.from(result.content, 'latin1')

  return new Response(buffer, {
    headers: {
      'Content-Type': 'text/plain; charset=iso-8859-1',
      'Content-Disposition': `attachment; filename="${result.filename}"`,
    },
  })
}

/**
 * Tax payment deadline = the 12th of the month *following* the AGI period.
 * (Skatteverket also accepts the 17th in Jan/Aug for turnover ≤40 MSEK, but
 * the conservative date is the 12th: money must be on the Skattekonto by
 * then to avoid kostnadsränta.)
 */
function computeTaxPaymentDate(periodYear: number, periodMonth: number): string {
  const deadlineMonth = periodMonth === 12 ? 1 : periodMonth + 1
  const deadlineYear = periodMonth === 12 ? periodYear + 1 : periodYear
  return `${deadlineYear}-${String(deadlineMonth).padStart(2, '0')}-12`
}
