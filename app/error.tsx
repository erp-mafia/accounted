'use client'

import { AppErrorBoundary } from '@/components/system/AppErrorBoundary'

// App-wide error boundary. Before this existed, only (dashboard) had an
// error.tsx, so a transient error anywhere else (notably the /select-company
// picker and the onboarding/auth layouts, which hit Supabase auth right after
// login) escalated to the full-screen app/global-error.tsx. This contains those
// errors and recovers via a single hard reload instead. Dashboard errors still
// hit the closer app/(dashboard)/error.tsx; root-layout failures still hit
// global-error.tsx.
export default function AppError({
  error,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return <AppErrorBoundary error={error} scope="app" />
}
