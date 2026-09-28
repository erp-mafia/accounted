import { NextResponse } from 'next/server'
import { createHash } from 'node:crypto'
import { withRouteContext } from '@/lib/api/with-route-context'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { generateBankgiroPaymentsBgLb } from '@/lib/salary/payment/bg-lb-generator'
import { generateSupplierPain001 } from '@/lib/payments/pain001-supplier'
import { resolveBatchDebtor } from '@/lib/payments/batch-service'
import { requiresBankgiroDebtorForBankgiroPayee } from '@/lib/payments/pain001-bank-policy'
import { resolveSkattekontoOcr, SKATTEKONTO_BANKGIRO } from '@/lib/skatteverket/skattekonto-ocr'
import { validateBankgiroNumber } from '@/lib/bankgiro/luhn'
import { getBranding } from '@/lib/branding/service'
import { parseEntityType, usesPersonnummerAsOrgNumber } from '@/lib/company/entity-type'
import { roundOre } from '@/lib/money'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { adjustDeadlineToNextBankingDay } from '@/lib/tax/swedish-holidays'
import { formatDateISO } from '@/lib/calendar/utils'
import { lookupBicByBankName, lookupBicByClearing } from '@/lib/salary/payment/bank-account'

type PaymentFormat = 'bg_lb' | 'pain001'

type SelectedRow = {
  id: string
  transaktionsdatum: string
  forfallodatum: string | null
  transaktionstext: string
  belopp_skatteverket: number | string
  status: 'booked' | 'upcoming'
  bank_entered_at: string | null
}

const errorResponse = (code: string, message: string, messageEn: string, status: number) =>
  NextResponse.json({ error: { code, message, message_en: messageEn } }, { status })

const SWEDBANK_ISO_ONLY_FROM = '2026-09-01'

/**
 * Generate one payment file from selected upcoming Skattekonto debits.
 * Selection controls the funding amount, not allocation at Skatteverket:
 * every payment still lands as an unallocated credit on the tax account.
 */
export const GET = withRouteContext(
  'skattekonto.payment_file',
  async (request, { supabase, companyId }) => {
    const params = new URL(request.url).searchParams
    const ids = [...new Set((params.get('transaction_ids') ?? '').split(',').filter(Boolean))]
    const format = (params.get('format') ?? 'pain001') as PaymentFormat

    if (ids.length === 0 || ids.length > 100 || ids.some((id) => !/^[0-9a-f-]{36}$/i.test(id))) {
      return errorResponse(
        'INVALID_TRANSACTION_SELECTION',
        'Välj mellan 1 och 100 giltiga skattekontohändelser.',
        'Select between 1 and 100 valid tax account events.',
        400,
      )
    }
    if (format !== 'bg_lb' && format !== 'pain001') {
      return errorResponse('INVALID_FORMAT', 'Ogiltigt filformat.', 'Invalid file format.', 400)
    }

    const [{ data: rows, error: rowsError }, { data: company }, { data: settings }] =
      await Promise.all([
        supabase
          .from('skattekonto_transactions')
          .select('id, transaktionsdatum, forfallodatum, transaktionstext, belopp_skatteverket, status, bank_entered_at')
          .eq('company_id', companyId)
          .in('id', ids),
        supabase
          .from('companies')
          .select('name, org_number, entity_type')
          .eq('id', companyId)
          .single(),
        supabase
          .from('company_settings')
          .select('bankgiro, bic, clearing_number, bank_name')
          .eq('company_id', companyId)
          .single(),
      ])

    if (rowsError) throw rowsError
    if (!rows || rows.length !== ids.length) {
      return errorResponse(
        'TRANSACTION_NOT_FOUND',
        'En eller flera valda skattekontohändelser finns inte längre.',
        'One or more selected tax account events no longer exist.',
        404,
      )
    }
    const selected = rows as SelectedRow[]
    if (selected.some((row) => row.status !== 'upcoming' || Number(row.belopp_skatteverket) >= 0)) {
      return errorResponse(
        'TRANSACTION_NOT_PAYABLE',
        'Endast kommande debiteringar på skattekontot kan ingå i en betalning.',
        'Only upcoming tax account debits can be included in a payment.',
        400,
      )
    }
    if (selected.some((row) => row.bank_entered_at)) {
      return errorResponse(
        'TRANSACTION_ALREADY_IN_BANK',
        'En eller flera valda debiteringar är redan markerade som inlagda i banken.',
        'One or more selected debits are already marked as entered at the bank.',
        409,
      )
    }

    const amountByDueDate = new Map<string, number>()
    for (const row of selected) {
      const dueDate = row.forfallodatum ?? row.transaktionsdatum
      amountByDueDate.set(
        dueDate,
        roundOre((amountByDueDate.get(dueDate) ?? 0) + Math.abs(Number(row.belopp_skatteverket))),
      )
    }
    const today = todayIsoStockholm()
    const payments = [...amountByDueDate.entries()]
      .sort(([dateA], [dateB]) => dateA.localeCompare(dateB))
      .map(([dueDate, amount]) => {
        const earliestExecutionDate = dueDate < today ? today : dueDate
        return {
          amount,
          paymentDate: formatDateISO(adjustDeadlineToNextBankingDay(
            new Date(`${earliestExecutionDate}T12:00:00Z`),
          )),
        }
      })
    const firstPaymentDate = payments[0].paymentDate
    const lastPaymentDate = payments[payments.length - 1].paymentDate
    const periodLabel = firstPaymentDate === lastPaymentDate
      ? firstPaymentDate
      : `${firstPaymentDate}_${lastPaymentDate}`

    if (!company?.org_number) {
      return errorResponse(
        'ORG_NUMBER_MISSING',
        'Organisationsnummer saknas för företaget.',
        'The company registration number is missing.',
        400,
      )
    }
    const entityType = parseEntityType(company.entity_type)
    let ocr: string
    try {
      ocr = await resolveSkattekontoOcr(
        supabase,
        companyId,
        company.org_number,
        usesPersonnummerAsOrgNumber(entityType) ? 'enskild_firma' : 'aktiebolag',
      )
    } catch (err) {
      return errorResponse('OCR_ERROR', getErrorMessage(err), getErrorMessage(err), 400)
    }

    let fileContent: Buffer
    let filename: string
    let contentType: string
    if (format === 'pain001') {
      const debtorResolution = await resolveBatchDebtor(supabase, companyId)
      if (!debtorResolution.ok) {
        return errorResponse(
          'DEBTOR_DETAILS_MISSING',
          'Företagets IBAN, BIC eller organisationsnummer saknas.',
          'The company IBAN, BIC or registration number is missing.',
          400,
        )
      }
      const debtor = debtorResolution.debtor
      if (!debtor.bankgiro && requiresBankgiroDebtorForBankgiroPayee(debtor.bic)) {
        return errorResponse(
          'DEBTOR_BANKGIRO_REQUIRED',
          'Ett giltigt bankgironummer för företaget krävs för betalfil till Skatteverket.',
          'A valid company Bankgiro number is required for a Skatteverket payment file.',
          400,
        )
      }
      try {
        const xml = generateSupplierPain001(
          {
            name: debtor.name,
            orgNumber: debtor.org_number,
            iban: debtor.iban,
            bic: debtor.bic,
            bankgiro: debtor.bankgiro,
            city: debtor.city,
          },
          payments.map((payment) => ({
            payee: { type: 'bankgiro', bankgiro: SKATTEKONTO_BANKGIRO.replace(/\D/g, '') },
            payeeName: 'Skatteverket',
            payeeCity: 'Solna',
            amount: payment.amount,
            paymentDate: payment.paymentDate,
            reference: { type: 'ocr', value: ocr },
          })),
          {
            messageId: `${getBranding().appName.toUpperCase()}-SKATT-${createHash('sha256')
              .update([...ids].sort().join(','))
              .digest('hex')
              .slice(0, 12)}`,
            createdAt: new Date().toISOString(),
          },
        )
        fileContent = Buffer.from(xml, 'utf-8')
      } catch (err) {
        return errorResponse('PAYMENT_FILE_ERROR', getErrorMessage(err), getErrorMessage(err), 400)
      }
      filename = `pain001_skatt_${periodLabel}.xml`
      contentType = 'application/xml; charset=utf-8'
    } else {
      if (!settings?.bankgiro) {
        return errorResponse(
          'BANKGIRO_MISSING',
          'Företagets bankgironummer är inte ifyllt.',
          'The company bankgiro number is missing.',
          400,
        )
      }
      if (!validateBankgiroNumber(settings.bankgiro)) {
        return errorResponse(
          'BANKGIRO_INVALID',
          'Företagets bankgironummer är ogiltigt.',
          'The company bankgiro number is invalid.',
          400,
        )
      }
      const payingBankBic =
        settings.bic?.trim().toUpperCase() ||
        lookupBicByClearing(settings.clearing_number) ||
        lookupBicByBankName(settings.bank_name)
      if (payingBankBic?.startsWith('SWEDSESS') &&
          payments.some((payment) => payment.paymentDate >= SWEDBANK_ISO_ONLY_FROM)) {
        return errorResponse(
          'LB_FORMAT_UNSUPPORTED',
          'Swedbank tar inte emot LB-filer för betalningar från 1 september 2026. Välj ISO 20022 pain.001.',
          'Swedbank does not accept LB files for payments from 1 September 2026. Choose ISO 20022 pain.001.',
          400,
        )
      }
      try {
        const result = generateBankgiroPaymentsBgLb(
          { name: company.name, senderBankgiro: settings.bankgiro },
          payments.map((payment) => ({
            receiverBankgiro: SKATTEKONTO_BANKGIRO,
            ocr,
            amount: payment.amount,
            paymentDate: payment.paymentDate,
            receiverName: 'Skatteverket',
          })),
          { periodLabel },
        )
        fileContent = Buffer.from(result.content, 'latin1')
        filename = result.filename
      } catch (err) {
        return errorResponse('PAYMENT_FILE_ERROR', getErrorMessage(err), getErrorMessage(err), 400)
      }
      contentType = 'text/plain; charset=iso-8859-1'
    }

    return new Response(new Uint8Array(fileContent), {
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    })
  },
  { requireWrite: true },
)
