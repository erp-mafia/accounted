import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { sessionFailureResponse } from '@/lib/operations/session'
import { prepareSalaryBankPayment } from '@/lib/salary/payment/pay-via-bank'

const PaySalaryViaBankSchema = z.object({
  cash_account_id: z.uuid(),
  /** Omitted, the banking day before payday. */
  execution_date: z.iso.date().nullish(),
  /** The person confirms the net pay has not left another way (a paid or booked run, or one with a payment file). */
  confirmed_unpaid: z.boolean().optional(),
  /** Every rule runs and the payments that would be created are answered; nothing is written. The dialog's preview. */
  dry_run: z.boolean().optional(),
})

/**
 * POST /api/salary/runs/[id]/payment/pay-via-bank: prepare the run's net pay
 * as draft bank payments, one per employee with a payout, to the account on
 * the employee card. Nothing reaches the bank: the drafts are approved and
 * signed with BankID like supplier payments (POST /api/payments/orders/approve,
 * POST /api/payments/signing). The rules live in
 * lib/salary/payment/pay-via-bank.ts.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.run.payment.pay_via_bank',
  async (request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params
    const validation = await validateBody(request, PaySalaryViaBankSchema)
    if (!validation.success) return validation.response
    const body = validation.data

    const outcome = await prepareSalaryBankPayment(
      { supabase, companyId, userId: user.id, log },
      {
        salaryRunId: id,
        cashAccountId: body.cash_account_id,
        executionDate: body.execution_date ?? null,
        today: todayIsoStockholm(),
        confirmedUnpaid: body.confirmed_unpaid === true,
        dryRun: body.dry_run === true,
      },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data }, { status: 201 })
  },
  { requireWrite: true },
)
