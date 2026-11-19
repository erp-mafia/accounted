import { PageHeader } from '@/components/ui/page-header'
import { Skeleton } from '@/components/ui/skeleton'

/**
 * Silhouette of a register page: the title bar with one action, the
 * toolbar, then the borderless table at the real row heights (32px head,
 * 44px rows over hairlines, the 16px bleed). The route fallback for every
 * list that had none. Stil v3: it fades in only after 300ms (animate-late),
 * so a fast navigation never flashes it.
 */
export function ListPageSkeleton({ rows = 6, toolbar = true }: { rows?: number; toolbar?: boolean }) {
  return (
    <div className="animate-late space-y-8" aria-busy="true" aria-live="polite">
      <PageHeader title={<Skeleton className="h-4 w-40" />} action={<Skeleton className="h-8 w-32 rounded-md" />} />
      {toolbar && (
        <div className="flex flex-wrap items-center gap-2">
          <Skeleton className="h-8 w-44 rounded-md" />
          <Skeleton className="h-8 w-64 rounded-md" />
          <Skeleton className="ml-auto h-8 w-28 rounded-md" />
        </div>
      )}
      <div className="-mx-2">
        <div className="flex h-8 items-center gap-4 border-b-hairline px-2">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-3 w-24" />
          <Skeleton className="ml-auto h-3 w-14" />
        </div>
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex h-11 items-center justify-between gap-4 border-b-hairline px-2">
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
