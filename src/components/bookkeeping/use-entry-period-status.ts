'use client'

import { useEffect, useState } from 'react'
import { ISO_DATE_RE } from '@/lib/invariants'
import type { PeriodStatusValue } from '@/lib/core/bookkeeping/period-status'

/** The period verdict for a verifikat's date, and the filed momsperiod it lies in while open. */
export interface EntryPeriodAnswer {
  /** Null when the answer could not be read. */
  status: PeriodStatusValue | null
  filedVat: { tax_period: string; filed_on: string; period_start: string; period_end: string } | null
}

/**
 * The period-status answer for one date (GET
 * /api/bookkeeping/fiscal-periods/period-status, the one the verifikat page
 * reads), for a door that offers corrections from outside the verifikat
 * page (correctionPaths decides which). Undefined while it is on its way or
 * when no date is asked; a failed read answers status null, which
 * correctionPaths reads as not open.
 */
export function useEntryPeriodStatus(date: string | null | undefined): EntryPeriodAnswer | undefined {
  const wanted = date && ISO_DATE_RE.test(date) ? date : null
  const [answer, setAnswer] = useState<{ date: string; value: EntryPeriodAnswer } | null>(null)

  useEffect(() => {
    if (!wanted) return
    let cancelled = false
    const failed: EntryPeriodAnswer = { status: null, filedVat: null }
    fetch(`/api/bookkeeping/fiscal-periods/period-status?date=${encodeURIComponent(wanted)}`)
      .then(async (res) => {
        if (!res.ok) return failed
        const { data } = await res.json()
        const status = data?.status
        const filed = data?.filed_vat
        return {
          status: status === 'open' || status === 'locked' || status === 'closed' ? status : null,
          filedVat:
            status === 'open' &&
            filed &&
            typeof filed.tax_period === 'string' &&
            typeof filed.filed_on === 'string' &&
            typeof filed.period_start === 'string' &&
            typeof filed.period_end === 'string'
              ? { tax_period: filed.tax_period, filed_on: filed.filed_on, period_start: filed.period_start, period_end: filed.period_end }
              : null,
        } satisfies EntryPeriodAnswer
      })
      .catch(() => failed)
      .then((value) => {
        if (!cancelled) setAnswer({ date: wanted, value })
      })
    return () => {
      cancelled = true
    }
  }, [wanted])

  return wanted && answer?.date === wanted ? answer.value : undefined
}
