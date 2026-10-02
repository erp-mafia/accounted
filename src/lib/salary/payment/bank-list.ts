/**
 * Banklista: the list of payments a salary payment file carries (payee,
 * masked account, amount, the reference that ties it to its record in the
 * file) with the total, for checking the file before it is uploaded to the
 * bank.
 *
 * There is no second computation: the list is the `payees` / `totalAmount`
 * of buildSalaryPaymentFile() itself, run as a dry run (every precondition
 * checked, the real generator run, nothing archived or stamped). A run the
 * builder refuses has no list either, with the same reason.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import type { NextResponse } from 'next/server'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import type { Logger } from '@/lib/logger'
import {
  buildSalaryPaymentFile,
  SALARY_PAYMENT_FILE_FORMATS,
  salaryPaymentFileRefusal,
  type SalaryPaymentFileError,
  type SalaryPaymentFileFormat,
  type SalaryPaymentFileOk,
} from './build-payment-file'

/** Query of the bank-list routes: the file format to list (default: the company's preferred format). */
export const SalaryBankListQuery = z.object({ format: z.enum(SALARY_PAYMENT_FILE_FORMATS).optional() })

export type SalaryBankList = Pick<
  SalaryPaymentFileOk,
  'format' | 'filename' | 'paymentDate' | 'periodLabel' | 'employeeCount' | 'totalAmount' | 'payees' | 'payer' | 'warnings'
>

export type SalaryBankListResult = { ok: true; list: SalaryBankList } | SalaryPaymentFileError

export async function buildSalaryBankList(
  supabase: SupabaseClient,
  input: { companyId: string; runId: string; userId: string; format?: SalaryPaymentFileFormat },
): Promise<SalaryBankListResult> {
  const result = await buildSalaryPaymentFile(supabase, { ...input, dryRun: true })
  if (!result.ok) return result
  const { format, filename, paymentDate, periodLabel, employeeCount, totalAmount, payees, payer, warnings } = result
  return {
    ok: true,
    list: { format, filename, paymentDate, periodLabel, employeeCount, totalAmount, payees, payer, warnings },
  }
}

/** Download name of the bank-list PDF, beside the payment file it describes. */
export function salaryBankListFileName(list: Pick<SalaryBankList, 'periodLabel' | 'format'>): string {
  return `banklista_lon_${list.periodLabel}_${list.format}.pdf`
}

/**
 * The structured error for a refused bank list. The catalogue codes are the
 * ones the v1 payment-file endpoint answers (salaryPaymentFileRefusal); where
 * the builder wrote a sentence naming the affected employees, that sentence
 * is the message, since it says who to fix.
 */
export function salaryBankListErrorResponse(
  result: SalaryPaymentFileError,
  log: Logger,
  requestId: string,
): NextResponse {
  const refusal = salaryPaymentFileRefusal(result)
  if (!refusal) return errorResponse(result.cause, log, { requestId })
  const named =
    (result.code === 'EMPLOYEE_BANK_INVALID' || result.code === 'GENERATOR_FAILED') &&
    typeof result.details.message === 'string' &&
    result.details.message
      ? result.details.message
      : undefined
  return errorResponseFromCode(refusal.code, log, {
    requestId,
    ...(refusal.reason !== undefined ? { reason: refusal.reason } : {}),
    ...(refusal.details ? { details: refusal.details } : {}),
    ...(named ? { messageSv: named } : {}),
  })
}
