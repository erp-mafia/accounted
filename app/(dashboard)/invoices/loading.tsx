import { Skeleton } from '@/components/ui/skeleton'

export default function InvoicesLoading() {
  return (
    <div className="space-y-8">
      {/* Title (24px) + primary action (single "Ny faktura" split button, pill) */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <Skeleton className="h-8 w-36" />
        <Skeleton className="h-9 w-32 rounded-full" />
      </div>

      {/* Toolbar: status picker chip + search + fiscal-year picker */}
      <div className="flex flex-wrap items-center gap-2">
        <Skeleton className="h-9 w-28 rounded-full" />
        <Skeleton className="h-9 flex-1" />
        <Skeleton className="h-9 w-28 rounded-full" />
      </div>

      {/* Borderless table: header row over hairline-separated single-line rows */}
      <div>
        <div className="flex h-10 items-center gap-4 border-b border-border px-4">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="ml-auto h-3 w-14" />
        </div>
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <div
            key={i}
            className="flex items-center justify-between gap-4 border-b border-border px-4 py-3 last:border-b-0"
          >
            <Skeleton className="h-4 w-40" />
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
