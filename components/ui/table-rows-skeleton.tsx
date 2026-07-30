import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

interface TableRowsSkeletonProps {
  /** How many placeholder rows to draw. Match the page's usual first screen. */
  rows?: number
  /** Cells per row. Drawn 1fr wide except the last, which is right-aligned. */
  columns?: number
  /** Draw the uppercase header stripe above the rows. */
  header?: boolean
  className?: string
}

/**
 * Loading placeholder for a page-level list.
 *
 * Mirrors the dry-table geometry on purpose: TD_CLASS is `px-4 py-[11px]` on
 * 13px text, so a settled row is about 39px. Nine pages used to hand-roll this
 * with `h-10` blocks on `space-y-3`, a 52px pitch, so every list visibly
 * shifted up 20 to 35px the moment the data arrived. Sizing the placeholder
 * like the real row is the whole point of having one.
 */
export function TableRowsSkeleton({
  rows = 6,
  columns = 3,
  header = true,
  className,
}: TableRowsSkeletonProps) {
  return (
    <div className={cn('w-full', className)} role="status" aria-busy="true">
      <span className="sr-only">Laddar</span>
      {header && (
        <div className="flex items-center gap-4 border-b border-border px-4 py-2.5">
          {Array.from({ length: columns }).map((_, i) => (
            <Skeleton
              key={i}
              className={cn('h-2.5', i === columns - 1 ? 'ml-auto w-16' : 'w-24 flex-1')}
            />
          ))}
        </div>
      )}
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex items-center gap-4 border-b border-border px-4 py-[11px]">
          {Array.from({ length: columns }).map((_, c) => (
            <Skeleton
              key={c}
              className={cn('h-3.5', c === columns - 1 ? 'ml-auto w-20' : 'w-full flex-1')}
            />
          ))}
        </div>
      ))}
    </div>
  )
}
