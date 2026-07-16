'use client'

import { useEffect } from 'react'
import { useFetch } from './use-fetch'
import type { AgiSubmissionState } from '@/lib/salary/agi-submission-state'

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
 * Refetches when the tab regains focus: the user typically signs in
 * Skatteverket's Mina Sidor in another tab (or on their phone) and comes
 * back here expecting the state to have caught up.
 */
export function useAgiSubmission(period: string | null): {
  submission: AgiSubmissionState | null
  refresh: () => void
} {
  const { data, refetch } = useFetch<
    { data?: AgiSubmissionState | null },
    AgiSubmissionState | null
  >(period ? `/api/extensions/ext/skatteverket/agi/status?period=${period}` : null, {
    select: body => body?.data ?? null,
  })

  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === 'visible') refetch()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [refetch])

  return { submission: data, refresh: refetch }
}
