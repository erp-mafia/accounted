import { Suspense } from 'react'
import { ReconciliationWorkspace } from '@/components/reconciliation/ReconciliationWorkspace'
import { getDashboardCompanyId, getDashboardFiscalPeriods } from '../request-context'
import type { FiscalPeriod } from '@/types'

/**
 * /reconciliation. Fiscal periods are loaded here so the period picker has
 * them on first paint (same as the focused reports); the page itself is a
 * client workspace over the reconciliation API. The list is request-cached:
 * the dashboard layout already read it.
 */
export default async function ReconciliationPage() {
  const [companyId, { data: periods }] = await Promise.all([
    getDashboardCompanyId(),
    getDashboardFiscalPeriods(),
  ])

  return (
    // useSearchParams in the workspace needs a Suspense boundary above it.
    <Suspense fallback={null}>
      <ReconciliationWorkspace initialPeriods={(periods ?? []) as FiscalPeriod[]} initialCompanyId={companyId} />
    </Suspense>
  )
}
