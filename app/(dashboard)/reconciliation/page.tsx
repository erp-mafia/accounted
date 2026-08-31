import { Suspense } from 'react'
import { ReconciliationWorkspace } from '@/components/reconciliation/ReconciliationWorkspace'
import { getDashboardAuthContext, getDashboardCompanyId } from '../request-context'
import type { FiscalPeriod } from '@/types'

/**
 * /reconciliation. Fiscal periods are loaded here so the period picker has
 * them on first paint (same as the focused reports); the page itself is a
 * client workspace over the reconciliation API.
 */
export default async function ReconciliationPage() {
  const [{ supabase }, companyId] = await Promise.all([getDashboardAuthContext(), getDashboardCompanyId()])
  const { data: periods } = companyId
    ? await supabase
        .from('fiscal_periods')
        .select('*')
        .eq('company_id', companyId)
        .order('period_start', { ascending: false })
    : { data: [] }

  return (
    // useSearchParams in the workspace needs a Suspense boundary above it.
    <Suspense fallback={null}>
      <ReconciliationWorkspace initialPeriods={(periods ?? []) as FiscalPeriod[]} initialCompanyId={companyId} />
    </Suspense>
  )
}
