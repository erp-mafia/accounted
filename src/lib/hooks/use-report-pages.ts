'use client'

import { useEffect, useState } from 'react'
import {
  fetchReportData,
  viewReportPages,
  withoutFailedPages,
  type ReportPageChain,
  type ReportPagesView,
  type SettledReportPages,
} from '@/lib/reports/report-data'

export interface UseReportPagesResult<T> extends ReportPagesView<T> {
  /** Whether the last page says another follows. */
  hasMore: boolean
  /** Ask for the next page; it is appended when it lands. */
  loadMore: () => void
  /** Ask again for the page that failed, keeping the pages already shown. */
  retry: () => void
}

/**
 * The paged sibling of useReportData: `url` is the first page (null fetches
 * nothing), `nextUrl` turns an answered page into the next page's URL, or
 * null when it was the last. Any change to `url` starts over at its first
 * page and drops the pages and requests of the earlier one
 * (viewReportPages, lib/reports/report-data.ts).
 */
export function useReportPages<T>(
  url: string | null,
  fallbackError: string,
  nextUrl: (page: T) => string | null,
): UseReportPagesResult<T> {
  const [chain, setChain] = useState<ReportPageChain>({ base: null, urls: [] })
  const [settled, setSettled] = useState<SettledReportPages<T>>({ base: null, results: {} })
  const view = viewReportPages(url, chain, settled)
  const { pending } = view

  useEffect(() => {
    if (url === null || pending === null) return
    const controller = new AbortController()
    void fetchReportData<T>(pending, fallbackError, controller.signal).then((outcome) => {
      if (controller.signal.aborted) return
      setSettled((prev) => ({
        base: url,
        results: { ...(prev.base === url ? prev.results : {}), [pending]: outcome },
      }))
    })
    return () => controller.abort()
  }, [url, pending, fallbackError])

  const last = view.pages[view.pages.length - 1]
  const more = url !== null && !view.loading && view.error === null && last !== undefined ? nextUrl(last) : null

  const loadMore = () => {
    if (url === null || more === null) return
    setChain((prev) => {
      const urls = prev.base === url ? prev.urls : [url]
      // A second click before the page landed asks for nothing new.
      return urls.includes(more) ? prev : { base: url, urls: [...urls, more] }
    })
  }

  const retry = () => setSettled((prev) => withoutFailedPages(prev))

  return { ...view, hasMore: more !== null, loadMore, retry }
}
