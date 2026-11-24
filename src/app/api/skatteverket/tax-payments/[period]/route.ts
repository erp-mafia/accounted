import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { getAgiPaymentDueDate } from '@/lib/tax/deadline-config'
import { readAgiPaymentPeriodConflict } from '@/lib/deadlines/agi-payable-declaration'
import { roundOre } from '@/lib/money'
import {
  SKATTEKONTO_PAYMENT_COVER_STATUSES,
  declarationBankPayment,
  type SkattekontoDeclarationPaymentOrder,
} from '@/lib/payments/orders/skattekonto-underway'

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
 * `bank_payment` is the bank payment to the skattekonto that pays the
 * declaration while it is not marked paid (declarationBankPayment): on its way
 * to the bank or executed. Set, the panel shows it instead of offering Betala
 * via banken and the payment file again; null when there is none.
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
    .select('total_tax, total_avgifter, tax_payment_file_generated_at, tax_payment_file_format, tax_paid_at, status, salary_run_id, created_at')
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

  const { status, salary_run_id: salaryRunId, created_at: createdAt, ...payment } = agi
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

  let bankPayment: SkattekontoDeclarationPaymentOrder | null = null
  if (!payment.tax_paid_at) {
    const { data: orders, error: ordersError } = await supabase
      .from('payment_orders')
      .select('status, amount, requested_execution_date, created_at, executed_at, signing:payment_order_batches!fk_payment_orders_batch(status, signing_started_at)')
      .eq('company_id', companyId)
      .eq('purpose', 'skattekonto')
      .in('status', [...SKATTEKONTO_PAYMENT_COVER_STATUSES])
      .gte('created_at', createdAt)
    if (ordersError) throw ordersError
    bankPayment = declarationBankPayment((orders ?? []) as SkattekontoDeclarationPaymentOrder[], {
      declared: roundOre(Number(payment.total_tax) + Number(payment.total_avgifter)),
      created_at: createdAt,
      due_date: paymentDueDate,
    })
  }

  return NextResponse.json({
    data: {
      ...payment,
      payment_due_date: paymentDueDate,
      period_conflict: periodConflict,
      bank_payment: bankPayment
        ? {
            status: bankPayment.status,
            amount: roundOre(Number(bankPayment.amount)),
            requested_execution_date: bankPayment.requested_execution_date,
            executed_at: bankPayment.executed_at,
          }
        : null,
    },
  })
  },
)
