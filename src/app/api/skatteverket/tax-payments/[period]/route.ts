import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { getAgiPaymentDueDate } from '@/lib/tax/deadline-config'
import { readAgiPaymentPeriodConflict } from '@/lib/deadlines/agi-payable-declaration'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { roundOre } from '@/lib/money'
import {
  isSkattekontoPaymentSigned,
  readSkattekontoPaymentsTowards,
  skattekontoPaymentPaysDeclaration,
} from '@/lib/payments/orders/skattekonto-day'
import { resolveSkattekontoDueDate } from '@/lib/payments/orders/skattekonto-sources'

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
 *
 * `period_conflict` is the refusal the payment file and the skattekonto
 * payment give the declaration (AGI_PAYMENT_PERIOD_CONFLICT, crm#1768: it
 * holds one run's totals while another live run is paid out in the month),
 * so the panel says so instead of offering to pay it; null when it may be
 * paid.
 *
 * `bank_payment` is a payment to the skattekonto through the bank made
 * towards the period's due date: in payment (claimed for signing, signed or
 * at the bank) or executed, from the banking day before it through the due
 * date (readSkattekontoPaymentsTowards). The panel shows it, and offers no
 * second payment when `pays_declaration` (skattekontoPaymentPaysDeclaration):
 * it is signed or executed (isSkattekontoPaymentSigned: a BankID nobody
 * finished only while it can), and its amount is the declaration's to the
 * öre, or the sum of everything declared due that day with it
 * (resolveSkattekontoDueDate). One that reached the bank unsigned never
 * executes, and any other larger amount may be the momsdeklaration due the
 * same day alone: shown, with the button kept. A payment that pays it is the
 * one shown, else one of the declaration's amount (its own payment, left
 * unsigned), else the earliest. null when there is none, when the period is
 * marked paid or may not be paid, and when the payments cannot be read: it
 * only informs, so a failed read never takes the panel down.
 */
export const GET = withRouteContext<{ params: Promise<{ period: string }> }>(
  'tax_payment.status',
  async (request, { supabase, companyId, log }, { params }) => {
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
    .select('total_tax, total_avgifter, tax_payment_file_generated_at, tax_payment_file_format, tax_paid_at, status, salary_run_id')
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

  const { status, salary_run_id: salaryRunId, ...payment } = agi
  const check = await readAgiPaymentPeriodConflict(supabase, companyId, {
    salary_run_id: salaryRunId ?? null,
    status,
    period_year: periodYear,
    period_month: periodMonth,
  })
  if (!check.ok) throw check.error
  const periodConflict = check.conflict
    ? {
        code: check.conflict.code,
        message: check.conflict.messageSv,
        message_en: check.conflict.messageEn,
        details: check.conflict.details,
      }
    : null

  let bankPayment: {
    status: string
    amount: number
    requested_execution_date: string
    pays_declaration: boolean
  } | null = null
  if (!payment.tax_paid_at && !periodConflict && paymentDueDate) {
    try {
      const orders = await readSkattekontoPaymentsTowards(supabase, companyId, paymentDueDate)
      if (orders.length > 0) {
        const amountOf = (order: { amount: number | string }) => roundOre(Number(order.amount))
        const declared = roundOre(Number(payment.total_tax) + Number(payment.total_avgifter))
        const nowMs = Date.now()
        let paying = orders.find((order) => skattekontoPaymentPaysDeclaration(order, declared, nowMs))
        // A larger signed payment pays it only as the sum of everything
        // declared due that day with this AGI in it (Betala allt som
        // förfaller, or the AGI added to the day's open moms payment); any
        // other amount may be another declaration's alone.
        if (!paying && orders.some((order) => isSkattekontoPaymentSigned(order, nowMs) && amountOf(order) > declared)) {
          try {
            const day = await resolveSkattekontoDueDate(supabase, companyId, paymentDueDate, todayIsoStockholm())
            if (day.ok && day.combined.components.some((part) => part.source === 'agi' && part.period === period)) {
              paying = orders.find((order) => skattekontoPaymentPaysDeclaration(order, day.combined.total, nowMs))
            }
          } catch (error) {
            log.warn('skattekonto due day read failed', { error })
          }
        }
        // Nothing pays it: the declaration's own payment left unsigned is the
        // one to sign again, not another declaration's payment of the days.
        const shown = paying ?? orders.find((order) => amountOf(order) === declared) ?? orders[0]
        bankPayment = {
          status: shown.status,
          amount: amountOf(shown),
          requested_execution_date: shown.requested_execution_date,
          pays_declaration: paying !== undefined,
        }
      }
    } catch (error) {
      // Without it the panel offers Betala via banken as before, and the
      // dialog still refuses a second payment on a day already in payment.
      log.warn('skattekonto bank payment read failed', { error })
    }
  }

  return NextResponse.json({
    data: { ...payment, payment_due_date: paymentDueDate, period_conflict: periodConflict, bank_payment: bankPayment },
  })
  },
)
