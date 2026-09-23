'use client'

import { useMemo, type ReactNode } from 'react'
import { SWRConfig } from 'swr'
import { buildReferenceFallback, type ReferenceSeed } from '@/lib/reference-data/seed'

/**
 * Nested SWR config carrying the server-fetched reference data as
 * `fallback`. Mounted by app/(dashboard)/layout.tsx inside CompanyProvider;
 * SWR merges this with the root SWRProvider so the shared cache, fetcher
 * and dedupe stay global while the seed is per company.
 */
export function ReferenceDataSeed({
  companyId,
  fiscalPeriods,
  cashAccounts,
  settings,
  children,
}: ReferenceSeed & { companyId: string | null; children: ReactNode }) {
  const fallback = useMemo(
    () => buildReferenceFallback(companyId, { fiscalPeriods, cashAccounts, settings }),
    [companyId, fiscalPeriods, cashAccounts, settings],
  )
  return <SWRConfig value={{ fallback }}>{children}</SWRConfig>
}
