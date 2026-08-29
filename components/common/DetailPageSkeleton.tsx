import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

interface DetailPageSkeletonProps {
  /** Number of summary cards under the title row. */
  cards?: 2 | 3
  /** Full-width variant for MainContainer's wide routes (max-w-7xl). */
  wide?: boolean
  className?: string
}

/**
 * Silhouette of a register/document detail page: back link, title row with
 * action pills, then a card grid. Used both as the route-level loading.tsx of
 * the [id] segments and as the client page's own loading state, so the
 * handoff from the RSC fallback to the client fetch is a no-op visually
 * instead of skeleton -> centred spinner -> content (three unrelated layouts
 * on the most-travelled drill-down path).
 */
export function DetailPageSkeleton({ cards = 2, wide = false, className }: DetailPageSkeletonProps) {
  return (
    <div className={cn('space-y-8', className)} aria-busy="true" aria-live="polite">
      {/* Back link */}
      <Skeleton className="h-4 w-24" />

      {/* Title (24px) + status pill + primary actions (pills) */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-6 w-20 rounded-full" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-9 w-28 rounded-full" />
          <Skeleton className="h-9 w-24 rounded-full" />
        </div>
      </div>

      {/* Card grid */}
      <div
        className={cn(
          'grid gap-6',
          cards === 3 ? 'md:grid-cols-3' : 'md:grid-cols-2',
          wide && 'lg:grid-cols-[minmax(0,1fr)_280px]',
        )}
      >
        {Array.from({ length: cards }, (_, i) => (
          <div key={i} className="space-y-3 rounded-lg border border-border p-5">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-4 w-3/5" />
          </div>
        ))}
      </div>

      {/* Line/table block */}
      <div>
        <div className="flex h-10 items-center gap-4 border-b border-border px-4">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="ml-auto h-3 w-14" />
        </div>
        {[1, 2, 3].map((i) => (
          <div key={i} className="flex items-center justify-between gap-4 border-b border-border px-4 py-3 last:border-b-0">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-4 w-20" />
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * Silhouette of the invoice editor (single-column snabbflöde): heading, the
 * customer/details block and the lines block. Matches the fallback the
 * "Ny faktura" dialog shows while the editor chunk loads.
 */
export function InvoiceEditorSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn('space-y-4', className)} aria-busy="true" aria-live="polite">
      <Skeleton className="h-8 w-1/3" />
      <Skeleton className="h-32 w-full rounded-lg" />
      <Skeleton className="h-32 w-full rounded-lg" />
    </div>
  )
}
