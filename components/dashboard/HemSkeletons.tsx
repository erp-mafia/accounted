import { Skeleton } from '@/components/ui/skeleton'

/** Suspense fallback for the setup checklist block. */
export function ChecklistSkeleton() {
  return (
    <div className="space-y-3 rounded-lg border border-border p-5" aria-busy="true">
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

/** Suspense fallback for the Att göra + Fortsätt panes. */
export function PanesSkeleton() {
  return (
    <div className="grid items-start gap-x-6 gap-y-8 md:grid-cols-2" aria-busy="true">
      {[0, 1].map((col) => (
        <div key={col}>
          <Skeleton className="mb-3 h-4 w-24" />
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="flex items-center justify-between gap-4 border-b border-border px-1 py-3 last:border-b-0">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-4 w-10" />
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
