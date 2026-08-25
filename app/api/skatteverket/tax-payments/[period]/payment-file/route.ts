import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { generateBankgiroPaymentBgLb } from '@/lib/salary/payment/bg-lb-generator'
import { generateSupplierPain001 } from '@/lib/payments/pain001-supplier'
import { resolveBatchDebtor } from '@/lib/payments/batch-service'
import { resolveSkattekontoOcr, SKATTEKONTO_BANKGIRO } from '@/lib/skatteverket/skattekonto-ocr'
import { validateBankgiroNumber } from '@/lib/bankgiro/luhn'
import { getBranding } from '@/lib/branding/service'
import { roundOre } from '@/lib/money'

ensureInitialized()

/**
 * Generate the payment file for paying skatt + arbetsgivaravgifter for a
 * given AGI period to Skatteverket's Bankgiro 5050-1055 with the company's
 * Skattekontot OCR.
 *
 * Period format: "YYYY-MM" (e.g. "2026-04").
 * `?format=bg_lb` (default) yields a Bankgirot LB-fil; `?format=pain001`
 * yields ISO 20022 pain.001 XML through the supplier-payment generator,
 * whose Swedish giro dialect (BG payee + SCOR OCR) is exactly this payment.
 *
 * Per BFL: Generated payment file is räkenskapsinformation linked to the
 * salary journal entry. Subject to 7-year retention.
 *
 * requireWrite: this GET mutates state (stamps tax_payment_file_generated_at
 * on the AGI declaration), so it retains the non-viewer role gate the
 * hand-rolled version enforced.
 */
export const GET = withRouteContext<{ params: Promise<{ period: string }> }>(
  'tax_payment.payment_file',
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

  const format = new URL(request.url).searchParams.get('format') ?? 'bg_lb'
  if (format !== 'bg_lb' && format !== 'pain001') {
    return NextResponse.json(
      { error: 'Ogiltigt filformat. Använd bg_lb eller pain001.' },
      { status: 400 }
    )
  }

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

  // Declarations generated since the whole-krona change store the declared
  // amounts (what Skatteverket computes from the underlag and draws): pay
  // exactly those. Legacy öre-bearing rows predate that storage; their
  // salary bookings credited 2731 with the öre, so keep paying öre-exact as
  // before: the öre lands as a small skattekonto överskott (the pre-existing
  // equilibrium) instead of stranding on 2731 with no counterpart.
  const declaredWholeKronor =
    Number.isInteger(agi.total_tax) && Number.isInteger(agi.total_avgifter)
  const totalAmount = declaredWholeKronor
    ? agi.total_tax + agi.total_avgifter
    : roundOre(agi.total_tax + agi.total_avgifter)
  if (totalAmount <= 0) {
    return NextResponse.json(
      { error: `Inget belopp att betala för perioden ${period}.` },
      { status: 400 }
    )
  }

  const { data: company } = await supabase
    .from('companies')
    .select('name, org_number, entity_type')
    .eq('id', companyId)
    .single()

  if (!company || !company.org_number) {
    return NextResponse.json(
      { error: 'Organisationsnummer saknas för företaget.' },
      { status: 400 }
    )
  }

  // The reference is the company's twelve-digit identity plus a Luhn check
  // digit (13 digits), not the ten-digit form: Skatteverket rejects the short
  // one. Skatteverket's own reported OCR wins when the skattekonto has been
  // synced; the derived value is the fallback.
  //
  // The entity_type collapse below is total, not a guess at a default:
  // companies.entity_type is NOT NULL with CHECK IN ('enskild_firma',
  // 'aktiebolag'), so there is no third value and no null to mis-tag. It
  // matters because it picks the prefix: a personnummer must keep its century
  // where an organisationsnummer takes "16", and getting that wrong yields a
  // Luhn-valid OCR for the wrong taxpayer.
  let ocr: string
  try {
    ocr = await resolveSkattekontoOcr(
      supabase,
      companyId,
      company.org_number,
      company.entity_type === 'enskild_firma' ? 'enskild_firma' : 'aktiebolag',
    )
  } catch (err) {
    return NextResponse.json({ error: getErrorMessage(err) }, { status: 400 })
  }

  // Payment date = AGI deadline, which is the 12th of the following month
  // (17th in Jan/Aug for ≤40 MSEK turnover, but we play safe with 12th here).
  const paymentDate = computeTaxPaymentDate(periodYear, periodMonth)

  let fileContent: Buffer
  let filename: string
  let contentType: string

  if (format === 'pain001') {
    // The paying company resolves exactly like a supplier payment batch:
    // IBAN + BIC (derived when possible) + org number, with the company
    // bankgiro riding along so the BG payee is debited BGNR-to-BGNR where
    // the bank's MIG demands it (Swedbank Validex rule 219).
    const debtorResolution = await resolveBatchDebtor(supabase, companyId)
    if (!debtorResolution.ok) {
      const message = {
        iban: 'Företagets IBAN saknas i företagsinställningar. Fyll i det under Inställningar → Fakturering för att skapa betalfil (ISO 20022).',
        bic: 'Företagsbankens BIC saknas och kunde inte härledas. Fyll i BIC under Inställningar → Fakturering för att skapa betalfilen.',
        org_number: 'Organisationsnummer saknas för företaget.',
      }[debtorResolution.missing]
      return NextResponse.json({ error: message }, { status: 400 })
    }
    const { debtor } = debtorResolution

    // Deterministic per period, like the salary pain.001 MsgId: re-downloads
    // reuse the id, so bank-side duplicate detection (keyed on MsgId) still
    // catches the same period being uploaded twice.
    const orgDigits = company.org_number.replace(/\D/g, '')
    const messageId = `${getBranding().appName.toUpperCase()}-SKATT-${orgDigits}-${period}`

    let xml: string
    try {
      xml = generateSupplierPain001(
        {
          name: debtor.name,
          orgNumber: debtor.org_number,
          iban: debtor.iban,
          bic: debtor.bic,
          bankgiro: debtor.bankgiro,
          city: debtor.city,
        },
        [
          {
            payee: { type: 'bankgiro', bankgiro: SKATTEKONTO_BANKGIRO.replace(/\D/g, '') },
            payeeName: 'Skatteverket',
            // Skatteverket's seat; the MIG demands a creditor town (rule 222).
            payeeCity: 'Solna',
            amount: totalAmount,
            paymentDate,
            reference: { type: 'ocr', value: ocr },
          },
        ],
        { messageId, createdAt: new Date().toISOString() }
      )
    } catch (err) {
      return NextResponse.json({ error: getErrorMessage(err) }, { status: 400 })
    }

    fileContent = Buffer.from(xml, 'utf-8')
    filename = `pain001_skatt_${period}.xml`
    contentType = 'application/xml; charset=utf-8'
  } else {
    const { data: settings } = await supabase
      .from('company_settings')
      .select('bankgiro')
      .eq('company_id', companyId)
      .single()

    if (!settings?.bankgiro) {
      return NextResponse.json(
        // Same wording as the salary LB route: the settings overview shows a
        // registry bankgiro that this route does not read.
        { error: 'Företagets bankgironummer är inte ifyllt. Fyll i det under Inställningar → Fakturering för att skapa betalfilen.' },
        { status: 400 }
      )
    }

    if (!validateBankgiroNumber(settings.bankgiro)) {
      return NextResponse.json(
        { error: 'Bankgironumret är ogiltigt (felaktig kontrollsiffra).' },
        { status: 400 }
      )
    }

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
      return NextResponse.json({ error: getErrorMessage(err) }, { status: 400 })
    }

    fileContent = Buffer.from(result.content, 'latin1')
    filename = result.filename
    contentType = 'text/plain; charset=iso-8859-1'
  }

  await supabase
    .from('agi_declarations')
    .update({
      tax_payment_file_generated_at: new Date().toISOString(),
      tax_payment_file_format: format,
    })
    .eq('id', agi.id)
    .eq('company_id', companyId)

  // Buffer is not assignable to BodyInit under the strict build tsconfig
  // (Buffer<ArrayBufferLike>); the repo convention is a Uint8Array view.
  return new Response(new Uint8Array(fileContent), {
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  })
  },
  { requireWrite: true },
)

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
