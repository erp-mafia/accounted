'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { useLocale, useTranslations } from 'next-intl'
import { ChevronDownIcon } from '@/components/icons'
import { AttnLine } from '@/components/ui/attn-line'
import { DefRow } from '@/components/ui/detail-section'
import { Skeleton } from '@/components/ui/skeleton'
import { QUIET_LINK_CLASS, VTD_CLASS, VTH_CLASS } from '@/components/ui/dry-table'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import type { SalaryBankList } from '@/lib/salary/payment/bank-list'
import type { OverpaidEmployee } from '@/lib/salary/payment/payable'
import { salaryBankListUrl, type SalaryPaymentFileFormat } from '@/lib/salary/payment/payment-format'
import { cn, formatCurrency, formatRowAmount } from '@/lib/utils'

interface PaymentBankListProps {
  salaryRunId: string
  format: SalaryPaymentFileFormat
}

/** A refused bank list, with whom a correction overpaid when it has nothing to pay. */
class BankListError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    readonly overpaid: OverpaidEmployee[],
    /** Which setting is missing (details.problem), for SALARY_RUN_PAYMENT_FILE_MISSING_BANK_DETAILS. */
    readonly problem: string | null,
    /** The employees without bank details, for SALARY_RUN_PAYMENT_FILE_EMPLOYEE_BANK_MISSING. */
    readonly employees: string[],
  ) {
    super(message)
  }
}

/**
 * The missing settings PaymentFilePanel does not already point at with its
 * own attention line (it covers IBAN, BIC and bankgiro): the bank's file ids.
 */
const SETTINGS_PROBLEMS_NAMED_HERE = new Set(['swedbank_ids_missing', 'nordea_signer_id_missing', 'nordea_agreement_id_missing'])

/** Where a refused bank list is fixed, when this row is the only place that says so. */
function refusalFix(error: BankListError | undefined): 'settings' | 'employees' | null {
  if (!error) return null
  if (error.code === 'SALARY_RUN_PAYMENT_FILE_EMPLOYEE_BANK_MISSING') return 'employees'
  if (error.code === 'SALARY_RUN_PAYMENT_FILE_MISSING_BANK_DETAILS' && error.problem && SETTINGS_PROBLEMS_NAMED_HERE.has(error.problem)) {
    return 'settings'
  }
  return null
}

/** "Anna Andersson (1 290,75 kr), Bertil Berg (300,00 kr)": who a correction overpaid, and by how much. */
function overpaidList(overpaid: OverpaidEmployee[]): string {
  return overpaid.map((employee) => `${employee.name} (${formatCurrency(employee.amount)})`).join(', ')
}

/**
 * Banklista beside the payment-file download: the payments the file carries
 * for the chosen format, from the payment file builder itself (a dry run of
 * the same computation), with a PDF of the same list. For a correction run
 * (rättelsekörning) the file pays only the difference against the run it
 * corrects: one muted line says so, and an employee it overpaid is named in
 * one attention sentence.
 */
export function PaymentBankList({ salaryRunId, format }: PaymentBankListProps) {
  const t = useTranslations('salary_payments')
  const tc = useTranslations('salary_correction_payment')
  const locale = useLocale() as ErrorLocale
  const [open, setOpen] = useState(false)

  // Both URLs come from the allow-listed format with an encoded query, so no
  // DOM text reaches the fetch or the link attribute as is.
  const listUrl = salaryBankListUrl(salaryRunId, format)
  const pdfUrl = salaryBankListUrl(salaryRunId, format, 'pdf')
  const { data, error, isLoading } = useSWR<SalaryBankList, BankListError>(
    listUrl,
    async (url: string) => {
      const res = await fetch(url)
      const json = await res.json().catch(() => null)
      if (!res.ok) {
        const envelope = json as {
          error?: {
            code?: unknown
            details?: { correction?: { overpaid?: OverpaidEmployee[] }; problem?: unknown; employees?: Array<{ name?: unknown }> }
          }
        } | null
        const details = envelope?.error?.details
        const overpaid = details?.correction?.overpaid
        const employees = details?.employees
        throw new BankListError(
          getErrorMessage(json, { context: 'salary', statusCode: res.status, locale }),
          res.status,
          typeof envelope?.error?.code === 'string' ? envelope.error.code : null,
          Array.isArray(overpaid) ? overpaid : [],
          typeof details?.problem === 'string' ? details.problem : null,
          Array.isArray(employees)
            ? employees.map((employee) => employee?.name).filter((name): name is string => typeof name === 'string' && name !== '')
            : [],
        )
      }
      return (json as { data: SalaryBankList }).data
    },
    {
      // A refusal (a missing bank id, an employee without an account) stays a
      // refusal until someone fills the detail in, so asking again every few
      // seconds only repeats it: SWR's default retry made 46 such requests
      // from 9 people in a week (2026-11). Coming back to the tab still asks
      // again, which is when the detail may have been filled in. A server
      // failure is retried as before.
      shouldRetryOnError: (failure: unknown) => !(failure instanceof BankListError) || failure.status >= 500,
    },
  )

  if (isLoading) {
    return (
      <DefRow label={t('bank_list_label')}>
        <Skeleton className="h-4 w-48" />
      </DefRow>
    )
  }

  // A correction with no positive difference has no file to make: say that,
  // and name whom it overpaid, instead of "the list appears once the file can be made".
  if (error?.code === 'SALARY_RUN_PAYMENT_FILE_NOTHING_TO_PAY') {
    return (
      <>
        <DefRow label={t('bank_list_label')}>
          <span className="text-xs text-muted-foreground">{tc('nothing_to_pay')}</span>
        </DefRow>
        {error.overpaid.length > 0 && (
          <AttnLine>{tc('overpaid', { list: overpaidList(error.overpaid), count: error.overpaid.length })}</AttnLine>
        )}
      </>
    )
  }

  // Missing bank file ids and employees without an account are named only
  // here, so they get an attention line with the way to the fix, not a muted
  // note beside a download button that fails the same way.
  const fix = refusalFix(error)
  if (error && fix) {
    return (
      <>
        <DefRow label={t('bank_list_label')}>
          <span className="text-xs text-muted-foreground">{t('bank_list_unavailable', { reason: '' }).trim()}</span>
        </DefRow>
        <AttnLine
          action={
            fix === 'employees'
              ? { label: t('employee_bank_link'), href: '/salary/employees' }
              : { label: t('missing_account_link'), href: '/settings/invoicing' }
          }
        >
          {fix === 'employees' && error.employees.length > 0
            ? t('employee_bank_missing_named', { names: error.employees.join(', '), count: error.employees.length })
            : error.message}
        </AttnLine>
      </>
    )
  }

  if (error || !data) {
    return (
      <DefRow label={t('bank_list_label')}>
        <span className="text-xs text-muted-foreground">
          {t('bank_list_unavailable', { reason: error?.message ?? '' })}
        </span>
      </DefRow>
    )
  }

  const overpaid = data.correction?.overpaid ?? []

  return (
    <>
      <DefRow label={t('bank_list_label')}>
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <span className="tabular-nums">
            {t('bank_list_summary', { count: data.employeeCount, total: formatCurrency(data.totalAmount) })}
          </span>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors duration-150 hover:text-foreground"
            aria-expanded={open}
          >
            <ChevronDownIcon className={cn('h-3 w-3 transition-transform duration-150', open && 'rotate-180')} />
            {open ? t('bank_list_hide') : t('bank_list_show')}
          </button>
          <a
            href={pdfUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={QUIET_LINK_CLASS}
          >
            {t('bank_list_pdf')}
          </a>
        </div>
        {data.correction && <div className="mt-1 text-xs text-muted-foreground">{tc('difference_only')}</div>}
      </DefRow>
      {/* Never paid, never deducted: the person handles it (one sentence, every name and amount). */}
      {overpaid.length > 0 && <AttnLine>{tc('overpaid', { list: overpaidList(overpaid), count: overpaid.length })}</AttnLine>}

      {open && (
        <div className="overflow-x-auto pb-2">
          <table className="stagger-enter w-full border-collapse text-[13px]">
            <thead>
              <tr>
                <th className={VTH_CLASS}>{t('bank_list_th_payee')}</th>
                <th className={VTH_CLASS}>{t('bank_list_th_account')}</th>
                <th className={VTH_CLASS}>{t('bank_list_th_reference')}</th>
                <th className={cn(VTH_CLASS, 'pr-0 text-right')}>{t('bank_list_th_amount')}</th>
              </tr>
            </thead>
            <tbody>
              {data.payees.map((payee, i) => (
                <tr key={`${payee.employeeId}-${i}`}>
                  <td className={VTD_CLASS}>{payee.name}</td>
                  <td className={cn(VTD_CLASS, 'whitespace-nowrap tabular-nums')}>{payee.maskedAccount}</td>
                  <td className={cn(VTD_CLASS, 'whitespace-nowrap tabular-nums text-muted-foreground')}>
                    {payee.reference}
                  </td>
                  <td className={cn(VTD_CLASS, 'whitespace-nowrap pr-0 text-right tabular-nums')}>
                    {formatRowAmount(payee.amount)}
                  </td>
                </tr>
              ))}
              <tr>
                <td className="py-2 pr-4 font-medium" colSpan={3}>
                  {t('bank_list_total')}
                </td>
                <td className="whitespace-nowrap py-2 text-right font-medium tabular-nums">
                  {formatCurrency(data.totalAmount)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
