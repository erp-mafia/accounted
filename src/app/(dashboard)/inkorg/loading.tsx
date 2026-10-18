import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { CONTENT_COLUMN_CLASS, RAIL_COLUMN_CLASS, WORK_AREA_CLASS } from '@/components/inkorg/frame'

/**
 * The page's silhouette while it loads: the top bar, then the rail in its
 * own column beside the list, in the page's own frame, so nothing moves
 * when they land.
 */
export default function InkorgLoading() {
  return (
    <div aria-busy="true">
      {/* The top bar's class hooks (.page-header in globals.css), as a hand-rolled header reuses them. */}
      <div className="page-header flex">
        <Skeleton className="h-4 w-16 rounded-sm" />
      </div>
      <div className={WORK_AREA_CLASS}>
        <div className={cn('hidden space-y-2 md:block', RAIL_COLUMN_CLASS)}>
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-full rounded-lg" />
          ))}
        </div>
        <div className={cn('space-y-3', CONTENT_COLUMN_CLASS)}>
          <Skeleton className="h-8 w-40 rounded-sm" />
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full rounded-lg" />
          ))}
        </div>
      </div>
    </div>
  )
}
