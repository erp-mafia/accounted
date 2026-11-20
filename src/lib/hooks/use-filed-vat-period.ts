'use client'

import { useEffect, useState } from 'react'
import { ISO_DATE_RE } from '@/lib/invariants'

/** The filed momsperiod a form's booking date lies in, as the hint names it. */
export interface FiledVatPeriodHint {
  tax_period: string
  filed_on: string
}

/**
 * The filed momsperiod an open booking date lies in, for a form that books on
 * a date the person picks (the faktura, the supplier invoice). Asked of the
 * period-status answer, the one the verifikat page reads
 * (/api/bookkeeping/fiscal-periods/period-status, filed_vat).
 *
 * Null while the answer is on its way, when the date is locked or closed (the
 * form's own lock text says that), when no declaration is on record for the
 * period, and when the question could not be asked: a hint beside the date,
 * never a gate.
 */
export function useFiledVatPeriod(date: string | null | undefined, enabled = true): FiledVatPeriodHint | null {
  const wanted = enabled && date && ISO_DATE_RE.test(date) ? date : null
  const [answer, setAnswer] = useState<{ date: string; filed: FiledVatPeriodHint | null } | null>(null)

  useEffect(() => {
    if (!wanted) return
    let cancelled = false
    // Typing a date passes through other dates: ask once it rests.
    const handle = setTimeout(async () => {
      try {
        const res = await fetch(`/api/bookkeeping/fiscal-periods/period-status?date=${encodeURIComponent(wanted)}`)
        if (!res.ok) return
        const { data } = await res.json()
        const filed = data?.filed_vat
        const hint =
          data?.status === 'open' && filed && typeof filed.tax_period === 'string' && typeof filed.filed_on === 'string'
            ? { tax_period: filed.tax_period as string, filed_on: filed.filed_on as string }
            : null
        if (!cancelled) setAnswer({ date: wanted, filed: hint })
      } catch {
        // A hint only: the booking and its own checks do not depend on it.
      }
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [wanted])

  return wanted && answer?.date === wanted ? answer.filed : null
}
