import { PageHeader } from '@/components/ui/page-header'
import { Skeleton } from '@/components/ui/skeleton'

/**
 * Silhouette of a register page: the title bar with one action, a toolbar
 * of pills, then the borderless table. The route fallback for every list
 * that had none, so a navigation never paints an empty pane first.
 */
export function ListPageSkeleton({ rows = 6, toolbar = true }: { rows?: number; toolbar?: boolean }) {
  return (
    <div className="space-y-8" aria-busy="true" aria-live="polite">
      <PageHeader title={<Skeleton className="h-4 w-40" />} action={<Skeleton className="h-9 w-32 rounded-full" />} />
      {toolbar && (
        <div className="flex flex-wrap items-center gap-2">
          <Skeleton className="h-9 w-44 rounded-full" />
          <Skeleton className="h-9 w-64" />
          <Skeleton className="ml-auto h-9 w-28 rounded-full" />
        </div>
      )}
      <div>
        <div className="flex h-10 items-center gap-4 border-b border-border">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-3 w-24" />
          <Skeleton className="ml-auto h-3 w-14" />
        </div>
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex items-center justify-between gap-4 border-b border-border/60 py-3.5 last:border-b-0">
            <Skeleton className="h-4 w-48" />
            <div className="flex items-center gap-6">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-4 w-16" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
