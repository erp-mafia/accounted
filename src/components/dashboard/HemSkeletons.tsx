import { Skeleton } from '@/components/ui/skeleton'

/** Suspense fallback for the setup checklist block. */
export function ChecklistSkeleton() {
  return (
    <div className="animate-late space-y-3" aria-busy="true">
      <Skeleton className="h-4 w-40" />
      {[1, 2, 3].map((i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-4 w-4 rounded-full" />
          <Skeleton className="h-4 w-64" />
        </div>
      ))}
    </div>
  )
}

/**
 * Suspense fallback for the Att göra pane, in the shape of the view it
 * stands in for: Hem (date, headline, the Först rows, the group rows), the
 * Behöver dig list (44px rows under a column head) or a Börja step.
 */
export function PanesSkeleton({ view = 'hem' }: { view?: 'hem' | 'behover' | 'borja' | 'gjort' }) {
  if (view === 'borja') {
    return (
      <div className="animate-late space-y-5" aria-busy="true">
        <Skeleton className="h-7 w-72" />
        <Skeleton className="h-64 w-full rounded-lg" />
        {[1, 2, 3].map((i) => (
          <div key={i} className="flex h-9 items-center justify-between gap-4 border-b-hairline">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-40" />
          </div>
        ))}
      </div>
    )
  }
  const rows = (count: number, height: string) =>
    Array.from({ length: count }, (_, i) => (
      <div key={i} className={`flex ${height} items-center justify-between gap-4 border-b-hairline px-2`}>
        <Skeleton className="h-4 w-64" />
        <Skeleton className="h-4 w-16" />
      </div>
    ))
  if (view !== 'hem') {
    return (
      <div className="animate-late -mx-2" aria-busy="true">
        <div className="flex h-8 items-center border-b-hairline px-2">
          <Skeleton className="h-3 w-12" />
        </div>
        {rows(8, 'h-11')}
      </div>
    )
  }
  return (
    <div className="animate-late space-y-8" aria-busy="true">
      <div className="space-y-2">
        <Skeleton className="h-3 w-32" />
        <Skeleton className="h-6 w-80" />
      </div>
      <div>
        <Skeleton className="mb-3 h-4 w-16" />
        <div className="-mx-2 border-t-hairline">{rows(3, 'h-11')}</div>
      </div>
      <div>
        <Skeleton className="mb-3 h-4 w-24" />
        <div className="-mx-2 border-t-hairline">{rows(4, 'h-[60px]')}</div>
      </div>
    </div>
  )
}
