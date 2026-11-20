'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  reportRequestKey,
  startReportRequest,
  viewReportData,
  type ReportDataView,
  type SettledReport,
} from '@/lib/reports/report-data'

export interface UseReportDataResult<T> extends ReportDataView<T> {
  /** Ask again for the same URL: loading until the new answer lands. */
  refetch: () => void
}

/**
 * The one fetch hook of the report views. `url` null fetches nothing (a
 * prerequisite is missing). Any change to `url` starts a new request, aborts
 * the previous one, and shows loading until the new answer lands, so a slower
 * answer for earlier parameters can never replace it (lib/reports/report-data.ts).
 * `fallbackError` is the view's message for a network or parse failure.
 */
export function useReportData<T>(url: string | null, fallbackError: string): UseReportDataResult<T> {
  const [attempt, setAttempt] = useState(0)
  const [settled, setSettled] = useState<SettledReport<T> | null>(null)
  const key = url === null ? null : reportRequestKey(url, attempt)

  useEffect(() => {
    if (key === null || url === null) return
    return startReportRequest<T>(key, url, fallbackError, setSettled)
  }, [key, url, fallbackError])

  const refetch = useCallback(() => setAttempt((n) => n + 1), [])

  return { ...viewReportData(settled, key), refetch }
}
