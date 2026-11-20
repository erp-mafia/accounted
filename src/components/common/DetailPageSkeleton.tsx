import { Skeleton } from '@/components/ui/skeleton'
import { PageHeader } from '@/components/ui/page-header'
import { cn } from '@/lib/utils'

interface DetailPageSkeletonProps {
  /** Number of fact sections under the facts line. */
  cards?: 2 | 3
  className?: string
}

/**
 * Silhouette of a register/document detail page: the title and its pills sit
 * in the top bar, the facts on one line under it, then sections of label and
 * value rows edge to edge. No back link, no cards: the page that follows has
 * neither. Used both as the route-level loading.tsx of the [id] segments and
 * as the client page's own loading state, so the handoff from the RSC
 * fallback to the client fetch is a no-op visually instead of skeleton ->
 * centred spinner -> content (three unrelated layouts on the most-travelled
 * drill-down path).
 */
export function DetailPageSkeleton({ cards = 2, className }: DetailPageSkeletonProps) {
  return (
    // Stil v3: fades in only after 300ms (animate-late), so a fast load never flashes it.
    <div className={cn('animate-late space-y-8', className)} aria-busy="true" aria-live="polite">
      <PageHeader
        title={<Skeleton className="h-4 w-56" />}
        action={
          <div className="flex gap-2">
            <Skeleton className="h-8 w-28 rounded-md" />
            <Skeleton className="h-8 w-24 rounded-md" />
          </div>
        }
      />
      <Skeleton className="h-3.5 w-80" />
      <div className="space-y-8">
        {Array.from({ length: cards }, (_, i) => (
          <div key={i} className="space-y-0">
            <Skeleton className="mb-3 h-3 w-24" />
            {[0, 1, 2].map((j) => (
              <div key={j} className="flex h-9 items-center gap-8 border-b-hairline">
                <Skeleton className="h-3.5 w-32" />
                <Skeleton className="h-3.5 w-48" />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
