import { Skeleton } from '@/components/ui/skeleton'

/** The journey while it loads: the question, its line and the choices, on the page itself (no card). */
export default function OnboardingLoading() {
  return (
    <div className="w-full space-y-6" aria-busy="true">
      <div className="space-y-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-full" />
      </div>
      <div className="space-y-3">
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-11 w-full" />
      </div>
    </div>
  )
}
