/**
 * A salary run's net pay as draft bank payments, staged by an agent
 * (gnubok_prepare_salary_payments): the preparation the run page's Betala
 * via banken makes (lib/salary/payment/pay-via-bank.ts), one draft per
 * employee with a payout, to the account on the employee card. Nothing
 * reaches the bank: a person approves the drafts and signs them with BankID
 * on Betalningar, like supplier payments.
 *
 * Whether the net pay already left another way (a run that is paid or
 * booked, or one with a payment file) is never the agent's to answer: the
 * input has no field for it. The person answers it when they approve the
 * proposal in the app, where the approval is refused with
 * SALARY_RUN_BANK_PAYMENT_CONFIRMATION_REQUIRED, kept pending
 * (fixable-refusals.ts), and sent again with that code confirmed. The
 * confirmation is read from the approval (OperationContext.acknowledgedWarnings),
 * never from the staged params, so no other door can give it.
 *
 * MCP only: the run page has its own route (POST /api/salary/runs/:id/payment/pay-via-bank)
 * over the same service.
 */
import { z } from 'zod'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { isoDateSchema } from '@/lib/invariants/zod'
import { prepareSalaryBankPayment } from '@/lib/salary/payment/pay-via-bank'
import { OrderOut, paymentsPageUrl, toOrderOut } from './payment-orders'
import { defineOperation, type OperationOutcome } from './types'

/** The refusal a person answers at approval: the net pay has not left another way. */
export const SALARY_UNPAID_CONFIRMATION = 'SALARY_RUN_BANK_PAYMENT_CONFIRMATION_REQUIRED'

const META = { request_id: 'req_…', api_version: '2026-05-12' }
const RUN_EXAMPLE_ID = 'run_a8f1…'

const Warning = z.object({
  code: z
    .enum(['after_payday', 'date_moved'])
    .describe('after_payday: the money reaches the employees after payday. date_moved: the day asked for is no banking day, so it moved.'),
  payday: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
})

const Output = z.object({
  salary_run_id: z.string().uuid(),
  payment_orders: z.array(OrderOut).describe('One draft per employee with a payout, to the account on the employee card.'),
  total: z.number(),
  replaced_draft_ids: z.array(z.string().uuid()).describe('Drafts of the run nobody approved, replaced by these.'),
  warnings: z.array(Warning),
  next: z.object({
    sign_in_app: z.string().describe('The Betalningar page where a person approves the drafts and signs them with BankID.'),
  }),
})

type OutputT = z.infer<typeof Output>

export const salaryRunsPrepareBankPayment = defineOperation({
  id: 'salary-runs.prepare-bank-payment',
  kind: 'write',
  scope: 'payroll:write',
  risk: 'medium',
  reversible: true,
  docs: {
    summary: "Prepare a salary run's net pay as draft bank payments, one per employee, for BankID signing on Betalningar.",
    description:
      'Creates one draft payment order per employee with a payout: the run\'s payable amount (for a correction run only the ' +
      'difference against what the corrected run paid) to the account on the employee card, from one of the company\'s own bank ' +
      'accounts, on the banking day before payday unless execution_date is given. Nothing reaches the bank: a person approves the ' +
      'drafts and signs them with BankID on the Betalningar page, like supplier payments, and the run moves to paid once the bank ' +
      'has executed every payment. Employees whose payment is approved, at the bank or executed are left out; drafts nobody approved ' +
      'are replaced. For a run that is paid or booked, or has a payment file, the person who approves the proposal in Accounted ' +
      'confirms that the net pay has not already left another way; an agent never answers that.',
    useWhen: 'The user wants the salaries of an approved or booked salary run paid from the bank in Accounted instead of a payment file.',
    doNotUseFor:
      'Supplier invoices or the skattekonto (gnubok_prepare_payments). A payment file. Signing: no API or MCP door signs.',
    pitfalls: [
      'SALARY_RUN_BANK_PAYMENT_NOT_READY: the run is not approved, paid or booked yet (details.current_status).',
      'SALARY_RUN_BANK_PAYMENT_CONFIRMATION_REQUIRED at approval: the run is paid or booked, or has a payment file. Only the person approving in Accounted (Att göra) can confirm the net pay has not left another way; an approval by API key is refused. The preview\'s confirmation_required says so before staging.',
      'SALARY_RUN_BANK_PAYMENT_EMPLOYEE_BANK_MISSING or _INVALID: an employee card lacks a usable clearing and account number (details.employees by name).',
      'SALARY_RUN_BANK_PAYMENT_NOTHING_TO_PAY: every employee with a payout already has a bank payment.',
      'PAYMENTS_UNAVAILABLE: bank payments are not switched on for the company. PAYMENT_ORDERS_ACCOUNT_NOT_PAYABLE: the account cannot pay (details.reason).',
      'execution_date may not be in the past; a day that is no banking day moves to the next one (warnings date_moved).',
    ],
    example: {
      request: { salary_run_id: RUN_EXAMPLE_ID, cash_account_id: '41b0…' },
      response: {
        data: {
          salary_run_id: RUN_EXAMPLE_ID,
          payment_orders: [],
          total: 44697.99,
          replaced_draft_ids: [],
          warnings: [],
          next: { sign_in_app: 'https://app.accounted.se/payments' },
        },
        meta: META,
      },
    },
  },
  input: z.object({
    salary_run_id: z.string().uuid().describe('The salary run (salary_run_id from gnubok_list_salary_runs): approved, paid or booked.'),
    cash_account_id: z
      .string()
      .uuid()
      .describe('The company bank account to pay from (cash_account_id from gnubok_get_payments_availability, payable true).'),
    execution_date: isoDateSchema
      .optional()
      .describe('YYYY-MM-DD the bank pays; defaults to the banking day before payday. Never in the past.'),
  }),
  output: Output,
  errorCodes: [
    'PAYMENTS_UNAVAILABLE',
    'PAYMENT_ORDERS_ACCOUNT_NOT_PAYABLE',
    'SALARY_RUN_NOT_FOUND',
    'SALARY_RUN_BANK_PAYMENT_NOT_READY',
    'SALARY_RUN_BANK_PAYMENT_CONFIRMATION_REQUIRED',
    'SALARY_RUN_BANK_PAYMENT_NOTHING_TO_PAY',
    'SALARY_RUN_BANK_PAYMENT_EMPLOYEE_BANK_MISSING',
    'SALARY_RUN_BANK_PAYMENT_EMPLOYEE_BANK_INVALID',
    'SALARY_RUN_BANK_PAYMENT_ALREADY_IN_PAYMENT',
    'VALIDATION_ERROR',
  ],
  mcp: {
    name: 'gnubok_prepare_salary_payments',
    title: 'Prepare Salary Bank Payments',
    description:
      "Stage a salary run's net pay as draft bank payments, one per employee, for BankID signing on Betalningar. For a paid or " +
      'booked run the person approving in Accounted confirms the pay has not left another way. Agents prepare, never sign.',
    keywords: [
      'betala lön',
      'lön via banken',
      'betala löner',
      'nettolön',
      'löneutbetalning',
      'betala via banken',
      'bankbetalning lön',
      'bankid lön',
    ],
    stage: {
      pendingType: 'prepare_salary_payment_orders',
      title: (_input, preview) =>
        typeof preview?.period === 'string'
          ? `Förbered bankbetalning av lönerna för ${preview.period}`
          : 'Förbered bankbetalning av lönerna',
      extras: (_input, preview) => ({
        next: {
          description:
            'After approval the payments wait as drafts on Betalningar: a person approves them and signs with BankID (gnubok_get_payments_signing_link).',
          tool: 'gnubok_get_payments_signing_link',
        },
        ...(preview.confirmation_required
          ? {
              complianceNote:
                'The run is paid or booked, or has a payment file: the person approving in Accounted confirms that the net pay has not already left another way. Approve it there, not by API key.',
            }
          : {}),
      }),
    },
  },
  run: async (ctx, input, { dryRun }): Promise<OperationOutcome<OutputT>> => {
    // Only a person's approval in the app carries the confirmation, and only
    // the commit of a staged proposal reads it.
    const confirmedUnpaid =
      ctx.pendingOperationId !== undefined && (ctx.acknowledgedWarnings ?? []).includes(SALARY_UNPAID_CONFIRMATION)
    const outcome = await prepareSalaryBankPayment(ctx, {
      salaryRunId: input.salary_run_id,
      cashAccountId: input.cash_account_id,
      executionDate: input.execution_date ?? null,
      today: todayIsoStockholm(),
      confirmedUnpaid,
      dryRun,
    })
    if (!outcome.ok) {
      if (outcome.code !== SALARY_UNPAID_CONFIRMATION) return outcome
      return {
        ...outcome,
        messageSv:
          'Lönekörningen är betald eller bokförd, eller har en betalfil: personen som godkänner förslaget i Accounted bekräftar att lönen inte redan har betalats ut på annat sätt.',
        messageEn:
          'The run is paid or booked, or has a payment file: the person approving the proposal in Accounted confirms that the salaries have not already been paid another way.',
      }
    }
    if (outcome.dryRun) return outcome
    return {
      ok: true,
      created: true,
      data: {
        salary_run_id: input.salary_run_id,
        payment_orders: outcome.data.orders.map((order) => toOrderOut(order)),
        total: outcome.data.total,
        replaced_draft_ids: outcome.data.replaced_draft_ids,
        warnings: outcome.data.warnings,
        next: { sign_in_app: paymentsPageUrl(outcome.data.orders.map((order) => order.id)) },
      },
    }
  },
})
