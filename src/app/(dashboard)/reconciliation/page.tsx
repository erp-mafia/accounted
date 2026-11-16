import { Suspense } from 'react'
import { ReconciliationWorkspace } from '@/components/reconciliation/ReconciliationWorkspace'

/**
 * /reconciliation: a client workspace over the reconciliation API. The
 * fiscal year is the app-wide one (the sidebar), already cached by the
 * dashboard layout's reference-data seed.
 */
export default function ReconciliationPage() {
  return (
    // useSearchParams in the workspace needs a Suspense boundary above it.
    <Suspense fallback={null}>
      <ReconciliationWorkspace />
    </Suspense>
  )
}
