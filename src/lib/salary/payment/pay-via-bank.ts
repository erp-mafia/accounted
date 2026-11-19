/**
 * Pay a salary run through the bank: one draft payment order per employee
 * with a positive payout, the net pay to the account on the employee card,
 * from one of the company's own accounts. The person approves the drafts and
 * signs them with BankID in one go (one basket when the bank takes baskets),
 * exactly like supplier payments; the run moves to paid when the bank has
 * executed every payment (salary_run_paid_by_bank, migration
 * 20261027100000).
 *
 * What is paid is never the caller's choice. The amounts are the run's
 * payable amounts (payable.ts: the effective net, or for a correction run
 * only the difference against what the corrected run already paid, the
 * figure the payment file writes) and the accounts are the employee cards;
 * the database function create_salary_payment_orders reads both itself
 * (salary_run_payable_amounts), and this service reads the same rows first
 * to name every problem by employee before anything is written. An employee
 * a correction overpaid is never paid or deducted: the preview names the
 * amount so the person handles it. An employee whose payment is approved, at the bank or executed is
 * left out, so a payment the bank rejected is paid again by preparing the run
 * again; drafts nobody approved are replaced.
 *
 * A run that is paid or booked, or one that already has a payment file, may
 * have been paid another way (the book step marks a run paid by itself), so
 * those need the person's confirmation that the net pay has not left. A
 * payment file is refused while a bank payment of the run is live
 * (build-payment-file.ts), so the two never both pay the month.
 *
 * The day defaults to the banking day before payday, so the money is on the
 * employees' accounts on payday (a transfer to another bank arrives the next
 * banking day), and never earlier than the bank takes. Nothing books the
 * debits: the salary voucher credits the bank account when the run is
 * booked, and the bank rows are reconciled against it.
 */

import { randomUUID } from 'node:crypto'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import { earliestExecutionDateIso, executionDateFor, previousBankDayIso } from '@/lib/payments/bank-days'
import {
  describePayeeAccountProblems,
  maskPayeeAccount,
  normalizeBankNumber,
  payeeAccountProblem,
  type PayeeAccountProblem,
} from '@/lib/payments/bank-account'
import { loadDebtor } from '@/lib/payments/orders/debtor'
import { openPaymentsDoor } from '@/lib/payments/orders/switched-on'
import type { PaymentOrderRow } from '@/lib/payments/orders/types'
import { isSandboxCompany } from '@/lib/sandbox/guard'
import { createServiceClient } from '@/lib/supabase/server'
import {
  CORRECTION_NOTHING_TO_PAY_SV,
  loadCorrectionPaidBefore,
  overpaidEmployees,
  payableAmount,
  type OverpaidEmployee,
} from './payable'

/** Run statuses whose net pay may be paid through the bank. */
export const SALARY_BANK_PAYMENT_STATUSES = ['approved', 'paid', 'booked'] as const

/** A salary payment that is approved, at the bank or executed: its employee is not paid again. */
const IN_PAYMENT_STATUSES = ['approved', 'submitted', 'awaiting_signature', 'awaiting_second_signer', 'accepted', 'executed'] as const

export interface PrepareSalaryBankPaymentInput {
  salaryRunId: string
  cashAccountId: string
  /** YYYY-MM-DD. Defaults to the banking day before payday. */
  executionDate?: string | null
  /** YYYY-MM-DD in Stockholm; injected so tests and the preview agree. */
  today: string
  /** The person confirms the net pay has not left another way (a paid or booked run, or one with a payment file). */
  confirmedUnpaid?: boolean
  /** Run every check and answer the payments that would be created, without writing anything. The dialog's preview. */
  dryRun?: boolean
}

export interface SalaryBankPaymentWarning {
  /**
   * after_payday: the money leaves after payday, so the employees get it late.
   * date_moved: the day asked for is no banking day the bank takes, so it moved to the next one.
   */
  code: 'after_payday' | 'date_moved'
  /** For after_payday: payday. */
  payday?: string
  /** For date_moved: the day asked for and the banking day it became. */
  from?: string
  to?: string
}

/** One payment the run would make. */
export interface SalaryBankPayee {
  employee_id: string
  name: string
  /** Clearing number and the last four digits of the account. */
  masked_account: string
  amount: number
  /** An executed salary payment already went to this account: the bank has paid it before. */
  known_account: boolean
}

// A type, not an interface: a dry run's preview is a Record<string, unknown>.
export type SalaryBankPaymentPreview = {
  salary_run_id: string
  /** YYYY-MM, the message the employees see is built from it. */
  period: string
  payment_date: string | null
  cash_account_id: string
  debtor: { bank_name: string | null; bic: string | null }
  currency: string
  requested_execution_date: string
  date_moved_from: string | null
  /** The message on each payment. */
  reference: string
  payees: SalaryBankPayee[]
  total: number
  /** Employees with a payout of 0 kr (for a correction: no difference to pay): nothing to pay. */
  zero_payouts: number
  /** Employees whose payment is approved, at the bank or executed: left out. */
  in_payment: number
  /** Drafts of the run nobody approved, replaced by this preparation. */
  replaces_drafts: number
  /** Set when the person must confirm the net pay has not left another way. */
  confirmation_required: { status: string; payment_file_generated_at: string | null } | null
  /**
   * Set for a correction run (rättelsekörning): every amount is the
   * difference against what the corrected run already paid, and an employee
   * it overpaid is left out and named here with the amount.
   */
  correction: { corrects_run_id: string; overpaid: OverpaidEmployee[] } | null
  warnings: SalaryBankPaymentWarning[]
}

export interface PreparedSalaryBankPayment {
  orders: PaymentOrderRow[]
  replaced_draft_ids: string[]
  warnings: SalaryBankPaymentWarning[]
  total: number
}

interface RunRow {
  id: string
  status: string
  period_year: number
  period_month: number
  payment_date: string | null
  payment_file_generated_at: string | null
  corrects_run_id: string | null
}

interface RunEmployeeRow {
  employee_id: string
  net_salary: number | string
  tax_withheld: number | string
  tax_withheld_override: number | string | null
  employee: { first_name: string | null; last_name: string | null; clearing_number: string | null; bank_account_number: string | null } | null
}

const RPC_CODES: Record<string, string> = {
  sandbox: 'PAYMENTS_UNAVAILABLE',
  invalid_payload: 'VALIDATION_ERROR',
  idempotency_mismatch: 'PAYMENT_ORDERS_IDEMPOTENCY_MISMATCH',
  run_not_found: 'SALARY_RUN_NOT_FOUND',
  run_not_payable: 'SALARY_RUN_BANK_PAYMENT_NOT_READY',
  confirmation_required: 'SALARY_RUN_BANK_PAYMENT_CONFIRMATION_REQUIRED',
  nothing_to_pay: 'SALARY_RUN_BANK_PAYMENT_NOTHING_TO_PAY',
  employee_bank_missing: 'SALARY_RUN_BANK_PAYMENT_EMPLOYEE_BANK_MISSING',
  already_in_payment: 'SALARY_RUN_BANK_PAYMENT_ALREADY_IN_PAYMENT',
}

function employeeName(row: RunEmployeeRow): string {
  return `${row.employee?.first_name ?? ''} ${row.employee?.last_name ?? ''}`.trim()
}

/** The message on each payment: what the employee sees on the statement. */
export function salaryPaymentReference(year: number, month: number): string {
  return `Lön ${year}-${String(month).padStart(2, '0')}`
}

export async function prepareSalaryBankPayment(
  ctx: OperationContext,
  input: PrepareSalaryBankPaymentInput,
): Promise<OperationOutcome<PreparedSalaryBankPayment>> {
  const { supabase, companyId, userId, log } = ctx
  const door = await openPaymentsDoor(ctx)
  if (!door.ok) return { ok: false, code: 'PAYMENTS_UNAVAILABLE', details: { reason: door.reason } }
  // Never from the sandbox: a demo visitor must not reach a real bank.
  if (await isSandboxCompany(supabase, companyId)) {
    return { ok: false, code: 'PAYMENTS_UNAVAILABLE', details: { reason: 'sandbox' } }
  }
  if (input.executionDate && input.executionDate < input.today) {
    return { ok: false, code: 'VALIDATION_ERROR', details: { field: 'execution_date', reason: 'in_the_past' } }
  }

  const { data: runData, error: runError } = await supabase
    .from('salary_runs')
    .select('id, status, period_year, period_month, payment_date, payment_file_generated_at, corrects_run_id')
    .eq('id', input.salaryRunId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (runError) throw runError
  const run = runData as RunRow | null
  if (!run) return { ok: false, code: 'SALARY_RUN_NOT_FOUND' }
  if (!(SALARY_BANK_PAYMENT_STATUSES as readonly string[]).includes(run.status)) {
    return {
      ok: false,
      code: 'SALARY_RUN_BANK_PAYMENT_NOT_READY',
      details: { current_status: run.status, allowed_statuses: [...SALARY_BANK_PAYMENT_STATUSES] },
    }
  }

  const debtor = await loadDebtor(supabase, companyId, input.cashAccountId)
  if (!debtor.ok) return { ok: false, code: 'PAYMENT_ORDERS_ACCOUNT_NOT_PAYABLE', details: { reason: debtor.reason } }

  const { data: employeeData, error: employeeError } = await supabase
    .from('salary_run_employees')
    .select('employee_id, net_salary, tax_withheld, tax_withheld_override, employee:employees(first_name, last_name, clearing_number, bank_account_number)')
    .eq('salary_run_id', run.id)
    .eq('company_id', companyId)
  if (employeeError) throw employeeError
  const runEmployees = (employeeData ?? []) as unknown as RunEmployeeRow[]

  const { data: orderData, error: orderError } = await supabase
    .from('payment_orders')
    .select('id, employee_id, status')
    .eq('company_id', companyId)
    .eq('salary_run_id', run.id)
    .eq('purpose', 'salary')
    .in('status', ['draft', ...IN_PAYMENT_STATUSES])
  if (orderError) throw orderError
  const runOrders = (orderData ?? []) as Array<{ id: string; employee_id: string; status: string }>
  const inPayment = new Set(runOrders.filter((o) => o.status !== 'draft').map((o) => o.employee_id))
  const drafts = runOrders.filter((o) => o.status === 'draft')

  // A correction pays only the difference against what the run it corrects
  // already paid (payable.ts); an ordinary run reads nothing more.
  const chain = await loadCorrectionPaidBefore(supabase, companyId, run)
  if (!chain.ok) throw chain.error
  const paidBefore = chain.paidBefore

  // Rounded to öre once, the figure the payment file writes and the
  // database function computes.
  const figures = runEmployees.map((row) => ({
    row,
    input: {
      employee_id: row.employee_id,
      name: employeeName(row),
      net_salary: Number(row.net_salary),
      tax_withheld: Number(row.tax_withheld),
      tax_withheld_override: row.tax_withheld_override === null ? null : Number(row.tax_withheld_override),
    },
  }))
  const withPayout = figures.map(({ row, input }) => ({ row, amount: payableAmount(input, row.employee_id, paidBefore) }))
  const overpaid = overpaidEmployees(figures.map((f) => f.input), paidBefore)
  const correction = paidBefore ? { corrects_run_id: paidBefore.correctsRunId, overpaid } : null
  const positive = withPayout.filter((p) => p.amount > 0)
  const toPay = positive.filter((p) => !inPayment.has(p.row.employee_id))
  if (toPay.length === 0) {
    return {
      ok: false,
      code: 'SALARY_RUN_BANK_PAYMENT_NOTHING_TO_PAY',
      details: { in_payment: inPayment.size, ...(correction ? { correction } : {}) },
      // A correction with nothing left to pay says so, not that everyone is in payment.
      ...(correction && inPayment.size === 0 ? { messageSv: CORRECTION_NOTHING_TO_PAY_SV } : {}),
    }
  }

  // Every employee paid needs an account, named all at once by name, never
  // by number.
  const missing = toPay.filter((p) => !p.row.employee?.clearing_number || !p.row.employee?.bank_account_number)
  if (missing.length > 0) {
    return {
      ok: false,
      code: 'SALARY_RUN_BANK_PAYMENT_EMPLOYEE_BANK_MISSING',
      details: { employees: missing.map((p) => ({ employee_id: p.row.employee_id, name: employeeName(p.row) })) },
    }
  }
  const invalid = toPay.flatMap((p) => {
    const problem = payeeAccountProblem(p.row.employee?.clearing_number, p.row.employee?.bank_account_number)
    return problem ? [{ employee_id: p.row.employee_id, name: employeeName(p.row), problem }] : []
  }) as Array<{ employee_id: string; name: string; problem: PayeeAccountProblem }>
  if (invalid.length > 0) {
    return {
      ok: false,
      code: 'SALARY_RUN_BANK_PAYMENT_EMPLOYEE_BANK_INVALID',
      messageSv: describePayeeAccountProblems(invalid),
      details: { employees: invalid },
    }
  }

  const confirmationRequired =
    run.status !== 'approved' || run.payment_file_generated_at
      ? { status: run.status, payment_file_generated_at: run.payment_file_generated_at }
      : null
  if (confirmationRequired && !input.confirmedUnpaid && !input.dryRun) {
    return { ok: false, code: 'SALARY_RUN_BANK_PAYMENT_CONFIRMATION_REQUIRED', details: confirmationRequired }
  }

  // The money leaves the banking day before payday, so it is there on
  // payday; never before the bank takes it.
  const payday = run.payment_date
  const wanted = input.executionDate ?? (payday ? previousBankDayIso(payday) : earliestExecutionDateIso(input.today))
  const executionDate = executionDateFor(wanted, input.today)
  const warnings: SalaryBankPaymentWarning[] = []
  if (input.executionDate && executionDate !== input.executionDate) {
    warnings.push({ code: 'date_moved', from: input.executionDate, to: executionDate })
  }
  if (payday && executionDate >= payday) warnings.push({ code: 'after_payday', payday })

  const total = Math.round(toPay.reduce((sum, p) => sum + p.amount * 100, 0)) / 100
  const reference = salaryPaymentReference(run.period_year, run.period_month)

  if (input.dryRun) {
    // An account the bank has paid salary to before (the order's payee_check
    // 'known'): a changed account on the card shows as not known.
    const { data: paidData, error: paidError } = await supabase
      .from('payment_orders')
      .select('employee_id, payee_clearing, payee_account')
      .eq('company_id', companyId)
      .eq('purpose', 'salary')
      .eq('status', 'executed')
      .in('employee_id', toPay.map((p) => p.row.employee_id))
    if (paidError) throw paidError
    const paidAccounts = new Set(
      ((paidData ?? []) as Array<{ employee_id: string; payee_clearing: string | null; payee_account: string | null }>).map(
        (o) => `${o.employee_id}:${o.payee_clearing}:${o.payee_account}`,
      ),
    )
    const preview: SalaryBankPaymentPreview = {
      salary_run_id: run.id,
      period: `${run.period_year}-${String(run.period_month).padStart(2, '0')}`,
      payment_date: payday,
      cash_account_id: input.cashAccountId,
      debtor: { bank_name: debtor.debtor.bank_name, bic: debtor.debtor.bic },
      currency: debtor.debtor.currency,
      requested_execution_date: executionDate,
      date_moved_from: input.executionDate && executionDate !== input.executionDate ? input.executionDate : null,
      reference,
      payees: toPay
        .map((p) => {
          const clearing = normalizeBankNumber(p.row.employee?.clearing_number)
          const account = normalizeBankNumber(p.row.employee?.bank_account_number)
          return {
            employee_id: p.row.employee_id,
            name: employeeName(p.row),
            masked_account: maskPayeeAccount(clearing, account),
            amount: p.amount,
            known_account: paidAccounts.has(`${p.row.employee_id}:${clearing}:${account}`),
          }
        })
        .sort((a, b) => a.name.localeCompare(b.name, 'sv')),
      total,
      // A correction's overpaid employee is named in correction.overpaid, not counted here.
      zero_payouts: withPayout.filter((p) => (paidBefore ? p.amount === 0 : p.amount <= 0)).length,
      in_payment: inPayment.size,
      replaces_drafts: drafts.length,
      confirmation_required: confirmationRequired,
      correction,
      warnings,
    }
    return { ok: true, dryRun: true, preview }
  }

  const writer = createServiceClient()
  const { data: rpc, error: rpcError } = await writer.rpc('create_salary_payment_orders', {
    p_company_id: companyId,
    p_salary_run_id: run.id,
    p_cash_account_id: input.cashAccountId,
    p_debtor_snapshot: debtor.debtor,
    p_requested_execution_date: executionDate,
    p_reference: reference,
    p_idempotency_key: randomUUID(),
    p_confirmed_unpaid: input.confirmedUnpaid === true,
    p_user_id: userId,
  })
  if (rpcError) throw rpcError
  const result = rpc as {
    ok: boolean
    code?: string
    details?: Record<string, unknown>
    orders?: PaymentOrderRow[]
    replaced_draft_ids?: string[]
  }
  if (!result.ok || !result.orders) {
    log.warn('create_salary_payment_orders refused', { code: result.code })
    return {
      ok: false,
      code: RPC_CODES[result.code ?? ''] ?? 'UNKNOWN_ERROR',
      details: { rpc_code: result.code, ...(result.details ?? {}) },
    }
  }
  const created = Math.round(result.orders.reduce((sum, o) => sum + Number(o.amount) * 100, 0)) / 100
  return {
    ok: true,
    data: { orders: result.orders, replaced_draft_ids: result.replaced_draft_ids ?? [], warnings, total: created },
  }
}
