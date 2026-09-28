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
import { parseEntityType, usesPersonnummerAsOrgNumber } from '@/lib/company/entity-type'
import {
  agiTaxPaymentDate,
  resolveCombinedTaxPayment,
  type CombinedTaxPaymentSettings,
} from '@/lib/skatteverket/combined-tax-payment'

ensureInitialized()

/**
 * Generate one Skattekonto payment for an AGI due date. The payment includes
 * both unpaid AGI and positive VAT when the declarations share that date.
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

  const [{ data: company }, { data: settings }] = await Promise.all([
    supabase
      .from('companies')
      .select('name, org_number, entity_type')
      .eq('id', companyId)
      .single(),
    supabase
      .from('company_settings')
      .select('bankgiro, moms_period, fiscal_year_start_month, vat_has_eu_trade, vat_filing_method, vat_taxable_base_over_40m, vat_registered')
      .eq('company_id', companyId)
      .single(),
  ])

  if (!company || !company.org_number) {
    return NextResponse.json(
      { error: 'Organisationsnummer saknas för företaget.' },
      { status: 400 }
    )
  }
  if (!settings) {
    return NextResponse.json({ error: 'Skatteinställningar saknas för företaget.' }, { status: 400 })
  }

  const entityType = parseEntityType(company.entity_type)
  const taxSettings = settings as CombinedTaxPaymentSettings & { bankgiro: string | null }
  const paymentDate = agiTaxPaymentDate(periodYear, periodMonth, taxSettings)
  let combined
  try {
    combined = await resolveCombinedTaxPayment(
      supabase,
      companyId,
      entityType,
      taxSettings,
      paymentDate,
    )
  } catch (err) {
    return NextResponse.json({ error: getErrorMessage(err) }, { status: 400 })
  }
  if (new URL(request.url).searchParams.get('preview') === 'true') {
    return NextResponse.json({ data: combined })
  }
  const totalAmount = combined.totalAmount
  if (totalAmount <= 0) {
    return NextResponse.json({ error: `Inget moms- eller AGI-belopp att betala för perioden ${period}.` }, { status: 400 })
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
      usesPersonnummerAsOrgNumber(entityType) ? 'enskild_firma' : 'aktiebolag',
    )
  } catch (err) {
    return NextResponse.json({ error: getErrorMessage(err) }, { status: 400 })
  }

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

    // Deterministic per due date, including when the same combined payment is
    // downloaded from the VAT report instead of the AGI view.
    const orgDigits = company.org_number.replace(/\D/g, '')
    const messageId = `${getBranding().appName.toUpperCase()}-SKATT-${orgDigits}-${paymentDate}`

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
    filename = `pain001_skatt_${paymentDate}.xml`
    contentType = 'application/xml; charset=utf-8'
  } else {
    if (!settings.bankgiro) {
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
        { paymentDate, periodLabel: paymentDate }
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
