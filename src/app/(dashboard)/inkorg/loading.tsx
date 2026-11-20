import { Skeleton } from '@/components/ui/skeleton'
import { WORK_AREA_CLASS } from '@/components/inkorg/frame'

/**
 * The page's silhouette while it loads: the top bar, then the toolbar over
 * the list, in the page's own frame, so nothing moves when they land.
 */
export default function InkorgLoading() {
  return (
    <div aria-busy="true">
      {/* The top bar's class hooks (.page-header in globals.css), as a hand-rolled header reuses them. */}
      <div className="page-header flex">
        <Skeleton className="h-4 w-16 rounded-sm" />
      </div>
      <div className={WORK_AREA_CLASS}>
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-64 rounded-lg" />
          <Skeleton className="h-8 w-24 rounded-lg" />
        </div>
        <div className="space-y-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full rounded-lg" />
          ))}
        </div>
      </div>
    </div>
  )
}
