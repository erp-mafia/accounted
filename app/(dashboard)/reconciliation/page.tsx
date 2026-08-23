import { Suspense } from 'react'
import { ReconciliationWorkspace } from '@/components/reconciliation/ReconciliationWorkspace'

// useSearchParams in the workspace needs a Suspense boundary above it.
export default function ReconciliationPage() {
  return (
    <Suspense fallback={null}>
      <ReconciliationWorkspace />
    </Suspense>
  )
}
