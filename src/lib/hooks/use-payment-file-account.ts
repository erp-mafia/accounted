'use client'

import { useCallback } from 'react'
import useSWR from 'swr'
import { useCompanyOptional } from '@/contexts/CompanyContext'
import type { PaymentFileAccountView } from '@/lib/salary/payment/payment-account'

async function fetchPaymentFileAccount([url]: readonly [string, string | null, string | null]): Promise<PaymentFileAccountView> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} ${res.status}`)
  return ((await res.json()) as { data: PaymentFileAccountView }).data
}

/**
 * The bank account the payment files pay from (GET /api/salary/payment-account,
 * the resolution the files run): for a salary run, the account its file pays
 * from (a booked run's verifikat account, else the primary); without one, the
 * primary bank account, which the supplier and tax files pay from.
 *
 * `account` is undefined while unknown (loading, or a failed read): callers
 * then show no warning, as the download itself says what is missing. Pass
 * enabled false to skip the read. The key carries the company so a switch
 * never shows another company's account, and the run's status, since booking
 * fixes the run's account to its verifikat's.
 */
export function usePaymentFileAccount(
  salaryRunId: string | null,
  { enabled = true, runStatus = null }: { enabled?: boolean; runStatus?: string | null } = {},
): { account: PaymentFileAccountView | undefined; refresh: () => void } {
  const companyId = useCompanyOptional()?.company?.id ?? null
  const url = salaryRunId
    ? `/api/salary/payment-account?run_id=${encodeURIComponent(salaryRunId)}`
    : '/api/salary/payment-account'
  const { data, mutate } = useSWR(enabled ? ([url, companyId, runStatus] as const) : null, fetchPaymentFileAccount, {
    shouldRetryOnError: false,
  })
  const refresh = useCallback(() => {
    void mutate()
  }, [mutate])
  return { account: data, refresh }
}
