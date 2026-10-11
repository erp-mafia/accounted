'use client'

import { useCallback } from 'react'
import useSWR from 'swr'
import { useCompanyOptional } from '@/contexts/CompanyContext'
import type { AgiSubmissionState } from '@/lib/salary/agi-submission-state'

async function fetchAgiSubmission([url]: readonly [string, string | null]): Promise<AgiSubmissionState | null> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} ${res.status}`)
  return ((await res.json()) as { data?: AgiSubmissionState | null } | null)?.data ?? null
}

/**
 * Fetches the Skatteverket extension's per-period AGI submission record
 * (`agi_submission_{period}`, period = YYYYMM) so the run page, progress
 * rail, and salary hero can render the real filing state machine
 * (underlag submitted / awaiting BankID signature / signed).
 *
 * Returns `submission: null` when the extension is disabled (503, e.g.
 * self-hosted), the user isn't connected, or nothing has been submitted
 * yet: callers fall back to the run row's own agi_* timestamps. Pass a
 * null period to skip fetching entirely (e.g. a run that isn't booked).
 *
 * Refetches when the tab regains focus (SWR's revalidateOnFocus): the user
 * typically signs in Skatteverket's Mina Sidor in another tab (or on their
 * phone) and comes back here expecting the state to have caught up. The key
 * carries the company so a switch never shows another company's record.
 */
export function useAgiSubmission(period: string | null): {
  submission: AgiSubmissionState | null
  refresh: () => void
} {
  const companyId = useCompanyOptional()?.company?.id ?? null
  const { data, mutate } = useSWR(
    period ? ([`/api/extensions/ext/skatteverket/agi/status?period=${period}`, companyId] as const) : null,
    fetchAgiSubmission,
    // A 503 (extension off) is an answer, not a blip: no retry loop.
    { shouldRetryOnError: false },
  )
  const refresh = useCallback(() => {
    void mutate()
  }, [mutate])

  return { submission: data ?? null, refresh }
}
