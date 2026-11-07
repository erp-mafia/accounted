'use client'

import useSWR from 'swr'
import { createClient } from '@/lib/supabase/client'
import { REFERENCE_SWR_OPTIONS } from '@/lib/reference-data/hooks'
import { readSeriesInUse, seriesFilterLetters } from '@/lib/bookkeeping/series-filter-letters'

/**
 * The series letters the verifikat list's filter offers: the ones the
 * company has numbered vouchers in (crm#1680), cached per company like the
 * other reference data.
 */
export function useSeriesFilterLetters(companyId: string | null | undefined, active: string): string[] {
  const { data, error } = useSWR(
    companyId ? ['voucher-series-in-use', companyId] : null,
    ([, id]: [string, string]) => readSeriesInUse(createClient(), id),
    REFERENCE_SWR_OPTIONS,
  )
  return seriesFilterLetters(error ? null : (data ?? []), active === 'all' ? null : active)
}
